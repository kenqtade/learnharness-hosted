/**
 * Keep a serverless function alive until `promise` settles.
 *
 * On Vercel, work that outlives the HTTP response (a background agent
 * turn, a research job, a pending Convex write) is frozen unless it is
 * registered with `waitUntil`. Elsewhere (local server, Electron, tests)
 * the process stays up anyway, so this is a no-op.
 *
 * Limits: Vercel cancels it at the function's max duration (300 s on
 * Hobby) — see docs/convex-vercel.md.
 */
import { waitUntil } from "@vercel/functions";

export function keepAlive<T>(promise: Promise<T>): Promise<T> {
	if (process.env.VERCEL) {
		try { waitUntil(promise.then(() => undefined, () => undefined)); } catch { /* outside a request: nothing to extend */ }
	}
	return promise;
}
