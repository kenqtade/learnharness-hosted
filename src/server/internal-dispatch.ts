/**
 * Internal dispatch (reliability wave, 2026-11) — give background work its
 * OWN serverless invocation.
 *
 * On Vercel, `waitUntil` (keep-alive.ts) only extends the invocation that
 * started the work, so a sub-agent job dispatched 200 s into a turn's
 * request inherited ~100 s of the 300 s wall and was killed silently. Here
 * the server POSTs a signed task to its own production URL; the receiving
 * invocation (app/api/internal/run) starts with a full budget.
 *
 * Security: the body carries {task, user, exp} and an HMAC-SHA256 signature
 * in `x-lh-internal-sig`, keyed from LH_INTERNAL_SECRET (or derived from
 * CRON_SECRET / LH_CONVEX_SECRET, both server-only). Replays inside the
 * short expiry are harmless: every task is idempotent (jobs are leased,
 * deliveries are keyed by steer id, extraction refuses a concurrent run).
 *
 * Off Vercel (local server, desktop, tests) there is no wall: dispatchTarget()
 * is null and callers run the work in-process exactly as before.
 */
import crypto from "node:crypto";
import { flushStore } from "../store/vfs.ts";
import { currentUser, type ScopeUser } from "../store/user-scope.ts";

export type InternalTask =
	| { kind: "job"; jobId: string }
	| { kind: "deliver"; chatId: string }
	| { kind: "extract"; chatId: string };

export interface InternalEnvelope {
	task: InternalTask;
	user: ScopeUser | null;
	/** Epoch ms after which the envelope is refused. */
	exp: number;
}

export const INTERNAL_SIG_HEADER = "x-lh-internal-sig";
export const INTERNAL_RUN_PATH = "/api/internal/run";
const ENVELOPE_TTL_MS = 120_000;

function internalSecret(env: Record<string, string | undefined> = process.env): string | null {
	if (env.LH_INTERNAL_SECRET) return env.LH_INTERNAL_SECRET;
	const base = env.CRON_SECRET || env.LH_CONVEX_SECRET;
	return base ? crypto.createHmac("sha256", base).update("lh-internal-dispatch-v1").digest("hex") : null;
}

/** Where to send internal tasks, or null to run in-process. */
export function dispatchTarget(env: Record<string, string | undefined> = process.env): string | null {
	if (env.LH_INTERNAL_DISPATCH === "0") return null;
	if (!env.VERCEL && env.LH_INTERNAL_DISPATCH !== "1") return null;
	// A preview deployment must never hand work to the production alias
	// (different code); previews keep the in-process path.
	if (env.VERCEL && env.VERCEL_ENV && env.VERCEL_ENV !== "production" && env.LH_INTERNAL_DISPATCH !== "1") return null;
	if (!internalSecret(env)) return null;
	const origin = env.LH_INTERNAL_ORIGIN
		|| (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
	return origin ? origin.replace(/\/+$/, "") + INTERNAL_RUN_PATH : null;
}

export function signEnvelope(envelope: InternalEnvelope, env: Record<string, string | undefined> = process.env): { body: string; signature: string } | null {
	const secret = internalSecret(env);
	if (!secret) return null;
	const body = JSON.stringify(envelope);
	return { body, signature: crypto.createHmac("sha256", secret).update(body).digest("base64url") };
}

const isUser = (u: unknown): u is ScopeUser =>
	!!u && typeof (u as ScopeUser).id === "string" && ((u as ScopeUser).role === "owner" || (u as ScopeUser).role === "member");

function isTask(t: unknown): t is InternalTask {
	const task = t as { kind?: unknown; jobId?: unknown; chatId?: unknown } | null;
	if (!task) return false;
	if (task.kind === "job") return typeof task.jobId === "string" && /^[A-Za-z0-9_-]+$/.test(task.jobId);
	if (task.kind === "deliver" || task.kind === "extract") return typeof task.chatId === "string" && /^[A-Za-z0-9_-]+$/.test(task.chatId);
	return false;
}

/** Verify a received task; null = refuse (bad signature, expired, malformed). */
export function verifyEnvelope(body: string, signature: string | null, now = Date.now(), env: Record<string, string | undefined> = process.env): InternalEnvelope | null {
	const secret = internalSecret(env);
	if (!secret || !signature) return null;
	const expected = Buffer.from(crypto.createHmac("sha256", secret).update(body).digest("base64url"));
	const given = Buffer.from(signature);
	if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	const env_ = parsed as Partial<InternalEnvelope>;
	if (typeof env_.exp !== "number" || env_.exp < now) return null;
	if (!isTask(env_.task)) return null;
	if (env_.user !== null && !isUser(env_.user)) return null;
	return { task: env_.task, user: env_.user ?? null, exp: env_.exp };
}

/**
 * Send one task to a fresh invocation. Resolves true once the receiver
 * accepted it (202), false on any failure — the caller then runs the work
 * in-process (the old behaviour) so nothing is ever dropped. Every pending
 * store write is flushed first: the receiver reads the store from Convex.
 */
export async function dispatchInternal(task: InternalTask, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	const target = dispatchTarget();
	if (!target) return false;
	const signed = signEnvelope({ task, user: currentUser(), exp: Date.now() + ENVELOPE_TTL_MS });
	if (!signed) return false;
	try {
		await flushStore();
		const res = await fetchImpl(target, {
			method: "POST",
			headers: { "content-type": "application/json", [INTERNAL_SIG_HEADER]: signed.signature },
			body: signed.body,
			signal: AbortSignal.timeout(15_000),
		});
		await res.arrayBuffer().catch(() => undefined);
		if (res.status === 202) return true;
		console.error(`[dispatch] ${task.kind} refused by ${target}: HTTP ${res.status}`);
		return false;
	} catch (err) {
		console.error(`[dispatch] ${task.kind} could not reach ${target}:`, err);
		return false;
	}
}
