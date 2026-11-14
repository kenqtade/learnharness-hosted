import { withStore } from "@/src/server";
/**
 * THE REATTACH STREAM (background-turn runner wave, owner ruling
 * 2026-09-25) — and, since CONNECTION DIET B (owner, 2026-10-10), THE
 * turn wire, period: POST /api/chat acknowledges and closes, so the
 * submitter too attaches here. One SSE stream per chat: a running turn →
 * subscribe to the live turn object: FULL replay of the event log, then
 * live chunks until settle ([DONE]). No running turn → the cheap terminal
 * ({"type":"turn-settled"} + [DONE]): the client refetches the record.
 * A retained settlement-failure notice precedes that terminal when a
 * reply could not be saved before the submitter attached.
 *
 * HOSTED FORK (2026-11-14): "no running turn" must mean "no running turn
 * ANYWHERE". A serverless host hands every request to a different
 * instance, so the turn this browser is watching may be running on another
 * one — and the cheap terminal told the learner the turn was over while
 * the teacher was still working. The durable turn marker makes that turn
 * visible; this route then holds the wire open (a keep-alive comment, the
 * marker re-checked every few seconds) until the marker is gone, and ends
 * with EXACTLY the same terminal the cheap path produces.
 *
 * 404 mirrors the POST handler's unknown-chat. Framework route is a thin
 * wrapper over the server barrel (the import law); tests drive the seams
 * (turn-runs + ui-stream) directly.
 */
import { ensureDurableRecovered, getChat, runningTurn, piTurnResponse, settledTurnResponse, isTurnRunningAnywhere, remoteTurnResponse } from "@/src/server";

export const dynamic = "force-dynamic";
// Background work (turns, jobs, deliveries) runs under waitUntil in this
// invocation — make the 300 s wall explicit (reliability wave, 2026-11).
export const maxDuration = 300;

async function GET_handler(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	// DURABLE-PI BRANCH: a returning visitor reattaches to a turn resumed
	// after a crash (no-op unless LH_RUNTIME=pi-durable).
	await ensureDurableRecovered();
	const handle = runningTurn(id);
	if (handle) return piTurnResponse(handle);
	// No handle on THIS instance — but a turn may be running on another one
	// (hosted). Hold the wire open until the durable marker is gone.
	if (await isTurnRunningAnywhere(id)) return remoteTurnResponse(id, req.signal);
	return settledTurnResponse(id);
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const GET = withStore(GET_handler);
