/** Who is signed in (platform mode, multi-user branch). Thin wrapper: the body lives in src/server/accounts-http.ts. */
import { authMeResponse, withStore } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withStore((request: Request) => authMeResponse(request));
