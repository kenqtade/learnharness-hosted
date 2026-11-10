/**
 * The server-side request hook (convex-store branch): refresh the store
 * from Convex, then re-mirror saved API keys into the environment — pi-ai
 * reads provider keys from env, and on a cold serverless instance the
 * module-load mirror (keys.ts) can run before the data has arrived.
 */
import { convexMode } from "../store/vfs.ts";
import { storeReady as syncStore } from "../store/ready.ts";
import { initAuthEnv } from "./keys.ts";

import { flushStore } from "../store/ready.ts";

export { flushStore };

export async function storeReady(): Promise<void> {
	if (!convexMode) return;
	await syncStore();
	initAuthEnv();
}

/** Wrap a route handler defined elsewhere (`export const GET = withStore(fn)`);
 *  off Convex it returns `fn` itself so sync handlers stay sync. */
export function withStore<F extends (...args: never[]) => unknown>(fn: F): F {
	if (!convexMode) return fn;
	return (async (...args: Parameters<F>) => {
		await storeReady();
		const result = await fn(...args);
		// another instance may serve the next request: every write this one
		// made must be in Convex before the reply leaves
		await flushStore();
		return result;
	}) as unknown as F;
}
