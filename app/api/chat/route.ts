import { withStore } from "@/src/server";
import { handleChatRequest } from "@/src/server";

async function POST_handler(req: Request) {
	return handleChatRequest(req);
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const POST = withStore(POST_handler);
// The turn runs under waitUntil in this invocation — make the 300 s wall
// explicit (reliability wave, 2026-11; chat-handler stops turns at 270 s).
export const maxDuration = 300;
