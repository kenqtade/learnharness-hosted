import { withStore } from "@/src/server";
import { pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function GET_handler() { return pluginTransport.list(); }
function POST_handler(request: Request) { return pluginTransport.refresh(request); }

export const GET = withStore(GET_handler);
export const POST = withStore(POST_handler);
