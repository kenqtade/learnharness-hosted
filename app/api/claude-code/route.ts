import { withStore } from "@/src/server";
import { claudeCodeInstallationResponse } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
async function GET_handler(request: Request) {
	return claudeCodeInstallationResponse(request);
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const GET = withStore(GET_handler);
