/**
 * POST /api/eval/job — staging-only eval hook (LH_EVAL_HOOKS=1, owner only;
 * 404 everywhere else). Spawns a visual/demo sub-agent job straight into a
 * chat so evals/agent-reliability can measure the job machinery on the host.
 * Body: {chatId, kind: "visual" | "demo", brief, title?, evalBudgetMs?}.
 */
import { withStore, spawnEvalJob } from "@/src/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function POST_handler(request: Request) {
	const body = (await request.json().catch(() => null)) as { chatId?: unknown; kind?: unknown; brief?: unknown; title?: unknown; evalBudgetMs?: unknown } | null;
	if (!body || typeof body.chatId !== "string" || (body.kind !== "visual" && body.kind !== "demo") || typeof body.brief !== "string") {
		return Response.json({ error: "Body must be {chatId, kind: visual|demo, brief, title?, evalBudgetMs?}" }, { status: 400 });
	}
	const result = spawnEvalJob(body.chatId, body.kind, body.brief, typeof body.title === "string" ? body.title : undefined, typeof body.evalBudgetMs === "number" ? body.evalBudgetMs : undefined);
	return Response.json(result.body, { status: result.status });
}

export const POST = withStore(POST_handler);
