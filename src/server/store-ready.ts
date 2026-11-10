/**
 * The server-side request hook (convex-store branch): refresh the store
 * from Convex, then re-mirror saved API keys into the environment — pi-ai
 * reads provider keys from env, and on a cold serverless instance the
 * module-load mirror (keys.ts) can run before the data has arrived.
 *
 * Multi-user branch: in platform mode (LH_MULTI_USER=1) the same wrapper
 * is the auth gate. It resolves the session cookie, refuses the request
 * when the route needs a signed-in user (401) or the owner (403), and runs
 * the handler INSIDE the user's scope so every store call — and every
 * background task the handler starts — lands in that user's data space.
 */
import { convexMode } from "../store/vfs.ts";
import { storeReady as syncStore } from "../store/ready.ts";
import { multiUser, runAsUser } from "../store/user-scope.ts";
import { initAuthEnv } from "./keys.ts";
import { cookieValue, routeAccess, verifySession, type Session } from "./accounts.ts";

import { flushStore } from "../store/ready.ts";

export { flushStore };

export async function storeReady(): Promise<void> {
	if (!convexMode) return;
	await syncStore();
	initAuthEnv();
}

/** The signed-in user of a request (platform mode), or null. */
export function requestSession(request: Request): Session | null {
	return verifySession(cookieValue(request.headers.get("cookie")));
}

const json = (status: number, error: string, code: string) =>
	Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });

/** Wrap a route handler defined elsewhere (`export const GET = withStore(fn)`);
 *  off Convex and off platform mode it returns `fn` itself so sync handlers
 *  stay sync. */
export function withStore<F extends (...args: never[]) => unknown>(fn: F): F {
	if (!convexMode && !multiUser) return fn;
	return (async (...args: Parameters<F>) => {
		await storeReady();
		let session: Session | null = null;
		if (multiUser) {
			const request = (args as unknown[])[0];
			const req = request instanceof Request ? request : null;
			const access = req ? routeAccess(req.method, new URL(req.url).pathname) : "user";
			session = req ? requestSession(req) : null;
			if (access !== "public" && !session) return json(401, "Sign in to continue.", "auth_required");
			if (access === "owner" && session?.role !== "owner") return json(403, "Only the platform owner can do this.", "owner_only");
		}
		const result = session ? await runAsUser(session, () => fn(...args)) : await fn(...args);
		// another instance may serve the next request: every write this one
		// made must be in Convex before the reply leaves
		await flushStore();
		return result;
	}) as unknown as F;
}
