import { createPluginDocumentRoute, pluginTransport, withStore } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This exact route skips Proxy body cloning, NOT desktop authentication.
const handlers = createPluginDocumentRoute(pluginTransport);
export const POST = withStore(handlers.POST);
export const OPTIONS = withStore(handlers.OPTIONS);
export const GET = withStore(handlers.GET);
export const HEAD = withStore(handlers.HEAD);
export const PUT = withStore(handlers.PUT);
export const PATCH = withStore(handlers.PATCH);
export const DELETE = withStore(handlers.DELETE);
