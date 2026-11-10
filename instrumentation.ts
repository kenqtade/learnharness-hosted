/**
 * Next.js boot hook. DURABLE-PI BRANCH: when LH_RUNTIME=pi-durable, open the
 * durable runtime at server start so turns a crashed process left unfinished
 * resume immediately (not only when someone next visits the chat). The
 * default runtime does nothing here.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	// CONVEX-STORE BRANCH: with LH_STORE=convex, load the data from Convex
	// before the first request (src/store/vfs.ts).
	if (process.env.LH_STORE === "convex") {
		const { storeReady } = await import("./src/store/vfs.ts");
		await storeReady(true);
		const { initAuthEnv } = await import("./src/server/keys.ts");
		initAuthEnv(); // saved keys → env, now that they've arrived
	}
	if ((process.env.LH_RUNTIME ?? "").trim().toLowerCase() !== "pi-durable") return;
	const { ensureDurableRecovered } = await import("./src/server/chat-handler.ts");
	await ensureDurableRecovered();
}
