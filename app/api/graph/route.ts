import { withStore } from "@/src/server";
import { graphView } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

async function GET_handler() {
	return Response.json(graphView());
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const GET = withStore(GET_handler);
