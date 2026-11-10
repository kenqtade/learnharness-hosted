/**
 * Request-entry hooks for the storage seam (src/store/vfs.ts). Every API
 * route and server page awaits `storeReady()` first, so in Convex mode the
 * in-memory copy is fresh before any store reads it. On real fs both are
 * zero-cost pass-throughs.
 */
import { convexMode, storeReady } from "./vfs.ts";

export { flushStore, storeReady } from "./vfs.ts";

/**
 * Wrap a route handler defined elsewhere (`export const GET = withStore(fn)`).
 * Off Convex it returns `fn` itself (sync handlers stay sync for the tests
 * that call them directly); in Convex mode Next awaits the async wrapper.
 */
export function withStore<F extends (...args: never[]) => unknown>(fn: F): F {
	if (!convexMode) return fn;
	return (async (...args: Parameters<F>) => {
		await storeReady();
		return fn(...args);
	}) as unknown as F;
}
