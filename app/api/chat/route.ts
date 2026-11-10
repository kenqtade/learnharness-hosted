import { withStore } from "@/src/server";
import { handleChatRequest } from "@/src/server";

async function POST_handler(req: Request) {
	return handleChatRequest(req);
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const POST = withStore(POST_handler);
