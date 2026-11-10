/** The signed-in user's own account (platform mode, multi-user branch). Thin wrapper: the body lives in src/server/accounts-http.ts. */
import { accountResponse, withStore } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withStore((request: Request) => accountResponse(request));
export const PATCH = withStore((request: Request) => accountResponse(request));
export const POST = withStore((request: Request) => accountResponse(request));
