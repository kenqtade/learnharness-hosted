import { withStore, runUpdateCheck, cronSecretMatches } from "@/src/server";
/**
 * GET /api/cron/update — Vercel Cron triggers this (auth via CRON_SECRET).
 * The cron runs daily (17:03 UTC) and triggers a redeploy if a newer
 * upstream release exists.
 */

const CRON_SECRET = process.env.CRON_SECRET;

export const dynamic = "force-dynamic";

async function GET_handler(request: Request) {
	if (!CRON_SECRET) {
		return Response.json({ error: "Auto-update cron is disabled (no CRON_SECRET)" }, { status: 503 });
	}
	const authHeader = request.headers.get("Authorization");
	if (!authHeader || !cronSecretMatches(authHeader.replace(/^Bearer\s+/i, ""), CRON_SECRET)) {
		return new Response(null, { status: 401 });
	}
	const status = await runUpdateCheck();
	return Response.json(status);
}

export const GET = withStore(GET_handler);