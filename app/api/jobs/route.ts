import { withStore } from "@/src/server";
import { isTurnRunningAnywhere, listJobs } from "@/src/server";

export const dynamic = "force-dynamic";
// Background work (turns, jobs, deliveries) runs under waitUntil in this
// invocation — make the 300 s wall explicit (reliability wave, 2026-11).
export const maxDuration = 300;

/**
 * Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat
 * view's jobs fetch lands here — once on mount, per jobs-changed
 * announcement (the store emits post-write, debounced client-side), and
 * on channel resync (push-architecture S4, 2026-10-02 — the old interval
 * poll is retired). It drives the dispatch cards, the sub-agents panel,
 * and the re-sync when a job settles. `turnInFlight` rides along for the
 * settle logic's idle check — HOSTED FORK: it counts a turn running on
 * ANOTHER instance too (the durable marker), because the learner's browser
 * may land on an instance that never saw the turn start.
 */
async function GET_handler(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId), turnInFlight: await isTurnRunningAnywhere(chatId) });
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const GET = withStore(GET_handler);
