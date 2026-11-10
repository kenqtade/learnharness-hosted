/** Owner: invite codes (platform mode, multi-user branch). Thin wrapper: the body lives in src/server/accounts-http.ts. */
import { adminInvitesResponse, withStore } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withStore((request: Request) => adminInvitesResponse(request));
export const POST = withStore((request: Request) => adminInvitesResponse(request));
export const DELETE = withStore((request: Request) => adminInvitesResponse(request));
