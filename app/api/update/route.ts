import { withStore, readUpdateStatus, runUpdateCheck } from "@/src/server";
/**
 * GET /api/update — the "Check now" button and status display.
 * GET → current status; POST → run check (with 24h guard on retries).
 */

export const dynamic = "force-dynamic";

async function GET_handler() {
	const status = readUpdateStatus();
	return Response.json(status);
}

async function POST_handler() {
	const status = await runUpdateCheck();
	return Response.json(status);
}

export const GET = withStore(GET_handler);
export const POST = withStore(POST_handler);