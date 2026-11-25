/**
 * Keep the server alive until `promise` settles.
 *
 * On Vercel, work that outlives the HTTP response (a background agent
 * turn, a research job, a pending Convex write) is frozen unless it is
 * registered with `waitUntil`. Limits: Vercel cancels it at the function's
 * max duration (300 s on Hobby). See docs/convex-vercel.md.
 *
 * RENDER (free web service, docs/render-hosting.md): Render spins the
 * service down after 15 minutes without inbound traffic, even if work is
 * still running. While anything registered here is in flight, the server
 * requests its own public URL every few minutes. That counts as traffic, so
 * a long agent turn or background job is not cut off. When the work ends the
 * pings stop and the service may sleep again.
 *
 * Elsewhere (local server, Electron, tests) the process stays up anyway, so
 * this only passes the promise through.
 */
import { waitUntil } from "@vercel/functions";

const PING_INTERVAL_MS = 4 * 60_000;
let inFlight = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** Public URL Render gives the service (unset off Render). */
function selfUrl(env: Record<string, string | undefined> = process.env): string | null {
	if (env.LH_AWAKE_PING === "0") return null;
	const base = env.LH_AWAKE_PING_URL || env.RENDER_EXTERNAL_URL;
	return base ? base.replace(/\/+$/, "") + "/api/version" : null;
}

function startPinging(url: string): void {
	if (pingTimer) return;
	pingTimer = setInterval(() => {
		fetch(url, { headers: { "x-lh-awake-ping": "1" } }).catch(() => { /* next tick tries again */ });
	}, PING_INTERVAL_MS);
	pingTimer.unref?.();
}

function stopPinging(): void {
	if (pingTimer) clearInterval(pingTimer);
	pingTimer = null;
}

/** How many registered promises are still running (tests, shutdown). */
export function keepAliveInFlight(): number { return inFlight; }

export function keepAlive<T>(promise: Promise<T>): Promise<T> {
	if (process.env.VERCEL) {
		try { waitUntil(promise.then(() => undefined, () => undefined)); } catch { /* outside a request: nothing to extend */ }
		return promise;
	}
	const url = selfUrl();
	if (url) {
		inFlight++;
		startPinging(url);
		const done = () => { inFlight = Math.max(0, inFlight - 1); if (inFlight === 0) stopPinging(); };
		promise.then(done, done);
	}
	return promise;
}
