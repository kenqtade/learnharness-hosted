/**
 * THE REMOTE REATTACH WAIT (hosted fork, 2026-11-14) — what the reattach
 * stream answers when the chat's turn runs on ANOTHER serverless instance.
 *
 * THE BUG IT FIXES: the learner's reconnect landed on an instance that knew
 * nothing about the running turn, so the stream answered the cheap terminal
 * ("turn-settled") while the teacher was still working — the learner saw
 * the saved "needs more time" marker as an error and nothing more ever
 * arrived. The durable turn marker (src/store/turn-markers.ts) is what makes
 * the other instance visible; this helper is what keeps the wire OPEN
 * until that marker is gone.
 *
 * THE WIRE: one SSE stream, same dialect as every other turn stream. While
 * the remote turn runs it carries a comment line (": waiting") as a
 * keep-alive — a comment is invisible to the client — and the marker is
 * re-checked every few seconds (the store is refreshed with it, so the
 * answer is seconds old, not the copy this instance booted with). When the
 * marker is gone or stale the stream ends with EXACTLY the terminal bytes
 * `settledTurnResponse(chatId)` produces — the client refetches the record
 * and finds the truth. The hard cap (240 s, under the host's 300 s wall)
 * ends the same way: a terminal is always a terminal.
 */

import { settledTurnResponse } from "./turn-runs.ts";
import { isTurnRunningRemotely } from "./turn-liveness.ts";

/** How often the durable marker is re-checked (the store is refreshed with it). */
export const REMOTE_TURN_POLL_MS = 3_000;
/** How often the keep-alive comment is written. */
export const REMOTE_TURN_COMMENT_MS = 10_000;
/** The hard cap — Vercel kills the function at 300 s, we end at 240 s. */
export const REMOTE_TURN_CAP_MS = 240_000;

export interface RemoteTurnWaitOptions {
	/** Marker re-check interval (ms). */
	pollMs?: number;
	/** Keep-alive comment interval (ms). */
	commentMs?: number;
	/** The hard cap (ms). */
	capMs?: number;
}

/**
 * The SSE response that waits for a turn running on another instance.
 *
 * `signal` is the request's abort signal: a learner who closes the tab must
 * not keep the function alive — the stream closes and the timers stop.
 */
export function remoteTurnResponse(chatId: string, signal?: AbortSignal | null, options: RemoteTurnWaitOptions = {}): Response {
	const pollMs = options.pollMs ?? REMOTE_TURN_POLL_MS;
	const commentMs = options.commentMs ?? REMOTE_TURN_COMMENT_MS;
	const capMs = options.capMs ?? REMOTE_TURN_CAP_MS;
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let poll: ReturnType<typeof setInterval> | undefined;
			let comment: ReturnType<typeof setInterval> | undefined;
			let cap: ReturnType<typeof setTimeout> | undefined;
			const clearTimers = () => {
				if (poll) clearInterval(poll);
				if (comment) clearInterval(comment);
				if (cap) clearTimeout(cap);
				poll = undefined;
				comment = undefined;
				cap = undefined;
			};
			const onAbort = () => {
				if (closed) return;
				closed = true;
				clearTimers();
				try { controller.close(); } catch { /* already closed */ }
			};
			/** The terminal: the exact bytes settledTurnResponse produces. */
			const finish = async () => {
				if (closed) return;
				closed = true;
				clearTimers();
				signal?.removeEventListener("abort", onAbort);
				try {
					controller.enqueue(encoder.encode(await settledTurnResponse(chatId).text()));
				} catch { /* the reader left */ }
				try { controller.close(); } catch { /* already closed */ }
			};
			const check = async () => {
				if (closed) return;
				const live = await isTurnRunningRemotely(chatId);
				if (closed) return;
				if (!live) await finish();
			};
			/** The keep-alive comment: an SSE comment line the client ignores. */
			const writeComment = () => {
				if (closed) return;
				try { controller.enqueue(encoder.encode(": waiting\n\n")); } catch { /* the reader left */ }
			};
			comment = setInterval(writeComment, commentMs);
			poll = setInterval(() => { void check(); }, pollMs);
			cap = setTimeout(() => { void finish(); }, capMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			cleanup = () => {
				closed = true;
				clearTimers();
				signal?.removeEventListener("abort", onAbort);
			};
			// The first comment goes out at once: the wire is open from the
			// first moment (a proxy must not wait for the first keep-alive),
			// and the cadence above keeps it open every 10 s.
			writeComment();
			// The first check is immediate: a marker that vanished between the
			// route's check and here must end the stream at once (and off a
			// hosted deployment there is no remote marker at all — the stream
			// ends with the terminal straight away).
			void check();
		},
		cancel() { cleanup(); },
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
