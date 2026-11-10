import { withStore, currentUpdateStatus, runUpdateCheckOnce, refreshBuildState, runningBuildId } from "@/src/server";
/**
 * /api/update — the Settings → Updates row and the refresh banner.
 * GET  (every signed-in account): current status. Also runs the upstream
 *      check when the last one is over 6 h old and follows a running
 *      rebuild, so updates land without waiting for the daily cron.
 * POST (owner only in platform mode — see routeAccess): check now.
 */

export const dynamic = "force-dynamic";

async function GET_handler() {
	return Response.json(await currentUpdateStatus(), { headers: { "Cache-Control": "no-store" } });
}

async function POST_handler() {
	await runUpdateCheckOnce();
	const status = await refreshBuildState();
	return Response.json({ ...status, buildId: runningBuildId() }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withStore(GET_handler);
export const POST = withStore(POST_handler);
