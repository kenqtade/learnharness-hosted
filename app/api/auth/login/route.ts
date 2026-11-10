/** Sign in (platform mode, multi-user branch). Thin wrapper: the body lives in src/server/accounts-http.ts. */
import { authLoginResponse, withStore } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = withStore((request: Request) => authLoginResponse(request));
