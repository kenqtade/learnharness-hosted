/**
 * Graceful shutdown for always-on hosts (Render, Docker, a VPS).
 *
 * Render stops a free service when it goes to sleep (15 idle minutes),
 * redeploys or restarts. It sends SIGTERM and allows about 30 s. Writes still
 * queued for Convex (src/store/vfs.ts) live only in memory, so they are
 * flushed here before the process exits. Nothing is lost when the service
 * sleeps. Unfinished agent jobs resume on the next start (recoverStaleJobs).
 *
 * Next.js only leaves SIGTERM to us when NEXT_MANUAL_SIG_HANDLE=true (set in
 * render.yaml). Without it, Next exits on its own and this handler does
 * nothing harmful.
 */
const FLUSH_BUDGET_MS = 20_000;
let installed = false;

export function installShutdownFlush(flush: () => Promise<void>, log: (msg: string) => void = console.log): void {
	if (installed) return;
	installed = true;
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log(`[shutdown] ${signal}: saving pending writes to Convex…`);
		const timeout = new Promise<"timeout">((resolve) => { setTimeout(() => resolve("timeout"), FLUSH_BUDGET_MS).unref?.(); });
		try {
			const result = await Promise.race([flush().then(() => "ok" as const), timeout]);
			log(result === "ok" ? "[shutdown] pending writes saved" : "[shutdown] flush timed out; exiting anyway");
		} catch (error) {
			log(`[shutdown] flush failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(0);
	};
	process.on("SIGTERM", () => { void stop("SIGTERM"); });
	process.on("SIGINT", () => { void stop("SIGINT"); });
}
