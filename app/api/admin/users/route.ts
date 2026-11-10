/** Owner: manage accounts (platform mode, multi-user branch). Thin wrapper: the body lives in src/server/accounts-http.ts. */
import { adminUsersResponse, withStore } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withStore((request: Request) => adminUsersResponse(request));
export const PATCH = withStore((request: Request) => adminUsersResponse(request));
export const DELETE = withStore((request: Request) => adminUsersResponse(request));
