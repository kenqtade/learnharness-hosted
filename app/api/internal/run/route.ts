/**
 * POST /api/internal/run — the receiving end of internal dispatch
 * (src/server/internal-dispatch.ts, reliability wave 2026-11). The server
 * calls itself here so background work (a sub-agent job, a result delivery,
 * an extraction run) starts in a FRESH invocation with its own time budget
 * instead of inheriting the leftovers of the request that triggered it.
 * Authenticated by an HMAC signature, not a session: the route is public in
 * the platform access table and refuses everything that is not signed.
 */
import { withStore, runInternalTask, INTERNAL_SIG_HEADER } from "@/src/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function POST_handler(request: Request) {
	const body = await request.text();
	const result = await runInternalTask(body, request.headers.get(INTERNAL_SIG_HEADER));
	return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

export const POST = withStore(POST_handler);
