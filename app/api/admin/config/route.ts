/** Owner: platform settings (platform mode, multi-user branch). Thin wrapper: the body lives in src/server/accounts-http.ts. */
import { adminConfigResponse, withStore } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withStore((request: Request) => adminConfigResponse(request));
export const PUT = withStore((request: Request) => adminConfigResponse(request));
