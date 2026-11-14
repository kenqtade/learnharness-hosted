/**
 * THE REMOTE-TURN DECISIONS (client half, reliability wave, 2026-11): pure
 * decisions about what a chat view does when the server says a turn runs
 * SOMEWHERE.
 *
 * The problem: hosted on Vercel, every request can land on a different
 * instance. A turn that runs on ANOTHER instance is invisible to the
 * in-process events channel (no turn-started / turn-settled frame ever
 * arrives) and the reattach stream answers "settled" at once. The RECORD is
 * the only truth: `turnInFlight === true` means the chat's turn — or its
 * pending continuation — runs on some instance.
 *
 * These functions hold the DECISION, so the wiring in components/chat.tsx
 * stays mechanical and the decisions are testable without a renderer.
 * Pure and browser-safe: the shell may import them through "@/src/core".
 */

/** How often the remote-turn watch re-reads the record (visible documents). */
export const REMOTE_TURN_POLL_MS = 4000;

/** What one reading of the server's liveness truth means for this view. */
export type RemoteTurnDecision =
	/** A turn runs on another instance: stay busy and keep watching. */
	| "watch"
	/** No turn runs anywhere: leave the busy state and adopt the record. */
	| "settle"
	/** Our own stream owns the view: never touch the busy state. */
	| "hold";

/**
 * The watch's decision for one record reading.
 *
 * @param turnInFlight the server's liveness truth (undefined = the server
 *   did not say — treated as "no turn runs", the harmless degradation
 *   against a server that does not report it)
 * @param localStream this view's own stream is attached (our turn, or the
 *   reattach stream) — it owns the rendering and the busy state
 */
export function decideRemoteTurn(input: { turnInFlight: boolean | undefined; localStream: boolean }): RemoteTurnDecision {
	if (input.localStream) return "hold";
	return input.turnInFlight === true ? "watch" : "settle";
}

/** What a returning tab does (visibilitychange → visible, pageshow). */
export type TabReturnDecision =
	/** A turn runs: attach to it (live rendering when the server can) and
	 *  keep the watch running meanwhile. */
	| "attach"
	/** No turn runs: adopt the record — a reply that finished while the tab
	 *  was away appears, and a stale banner clears with it. */
	| "sync"
	/** Our own stream owns the view: leave it alone. */
	| "hold";

/**
 * The returning tab's decision for one record reading (same inputs as
 * {@link decideRemoteTurn}).
 */
export function decideTabReturn(input: { turnInFlight: boolean | undefined; localStream: boolean }): TabReturnDecision {
	if (input.localStream) return "hold";
	return input.turnInFlight === true ? "attach" : "sync";
}
