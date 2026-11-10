import { withStore } from "@/src/server";
/**
 * GET /api/capabilities — the switchboard's honest status (portability wave,
 * 2026-11-03).
 *
 * Read-only and secret-free: provider ids, availability and a one-line
 * reason. It never returns a key, a token, or an endpoint credential — the
 * same rule app/api/keys already follows for masked key status.
 *
 * The Settings page's "capabilities" section reads this; so does the smoke
 * test that proves the two deployment profiles differ without a code change.
 */

import { capabilityReport } from "@/src/server";

export const dynamic = "force-dynamic";

async function GET_handler() {
	return Response.json(capabilityReport(), {
		headers: { "Cache-Control": "no-store" },
	});
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const GET = withStore(GET_handler);
