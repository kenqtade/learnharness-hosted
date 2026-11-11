/**
 * Next.js boot hook.
 * - CONVEX-STORE BRANCH: with LH_STORE=convex, load the data from Convex
 *   before the first request (src/store/vfs.ts).
 * - Plugins (upstream v0.6.0) use this per-server initialization hook. A
 *   plugin failure must not prevent access to existing learning data or
 *   teaching/practice.
 * - DURABLE-PI BRANCH: when LH_RUNTIME=pi-durable, open the durable runtime
 *   at server start so turns a crashed process left unfinished resume
 *   immediately. The default runtime does nothing here.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	if (process.env.LH_STORE === "convex") {
		const { storeReady } = await import("./src/store/vfs.ts");
		await storeReady(true);
		const { initAuthEnv } = await import("./src/server/keys.ts");
		initAuthEnv(); // saved keys → env, now that they've arrived
	}
	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
	if ((process.env.LH_RUNTIME ?? "").trim().toLowerCase() !== "pi-durable") return;
	const { ensureDurableRecovered } = await import("./src/server/chat-handler.ts");
	await ensureDurableRecovered();
}
