import { runningBuildId, runningVersion } from "@/src/server";
/**
 * GET /api/version — which build is live. Public and storage-free: the
 * refresh banner polls it (also on the sign-in page) and compares the
 * build id with the one baked into the page it loaded.
 */

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ version: runningVersion(), buildId: runningBuildId() }, { headers: { "Cache-Control": "no-store" } });
}
