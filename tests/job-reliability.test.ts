/**
 * Reliability wave (2026-11) — deterministic fault injection for the time-out
 * and sub-agent failure modes measured by evals/agent-reliability:
 *
 *   1. a job that hits its wall budget hands itself back (lease released,
 *      redispatched) instead of being killed silently
 *   2. after maxAttempts the job fails with an honest "ran out of time"
 *      result that IS delivered to the lesson
 *   3. a live lease held by another instance blocks a duplicate run (runner
 *      AND recovery sweep); an expired lease (a killed instance) re-runs
 *   4. a worker that loses its lease mid-run unwinds without writing
 *   5. internal dispatch envelopes: sign/verify, tamper, expiry, targets
 *   6. the turn deadline: budgets + the explained out-of-time message
 *
 * No network: faux engines, a recording deliver, store files in an isolated
 * data dir.
 */
import "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ResearchResult, SteerMessage } from "../src/core/contracts.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { createJobRunner, jobLeaseTuning, leaseHeldElsewhere, outOfTimeReason, researchModelOverride } from "../src/agent/subagents/runner.ts";
import { isJobLive, unregisterJobAbort } from "../src/agent/subagents/aborts.ts";
import { recoverStaleJobs, setJobRespawn } from "../src/server/jobs.ts";
import { dispatchTarget, signEnvelope, verifyEnvelope } from "../src/server/internal-dispatch.ts";
import { handleChatRequest, jobBudgetMs, markTurnOutOfTime, outOfTimeTurnText, turnBudgetMs } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { invocationStartedAt, remainingInvocationBudget, runWithInvocationClock } from "../src/server/invocation-clock.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";

const INPUT = { question: "What is binary search?" };
const BRIEF = "## Summary\nBinary search halves the range each step.\n\n## Sources\n- none";
const defaults = { ...jobLeaseTuning };
const createdJobs: string[] = [];

afterEach(() => {
	Object.assign(jobLeaseTuning, defaults);
	researchModelOverride.current = undefined;
	setJobRespawn(() => {});
	for (const id of createdJobs) {
		const job = jobStore.getJob(id);
		if (job?.status === "running") jobStore.updateJob(id, { status: "done", activity: "settled (fence)", lease: null });
		unregisterJobAbort(id);
	}
});

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A model call that never answers until its abort signal fires (a hung
 *  provider), repeated for every attempt. */
function hungEngine(calls = 5): PiEngine & { started: () => number } {
	let started = 0;
	const step = ((_ctx: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			started++;
			const sig = options?.signal;
			if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
			sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		})) as unknown as FauxResponseStep;
	const engine = fauxEngine(Array.from({ length: calls }, () => step));
	return Object.assign(engine, { started: () => started });
}

function recordingDeliver() {
	const steers: SteerMessage[] = [];
	return { steers, deliver: async (steer: SteerMessage) => { steers.push(steer); } };
}

function newResearchJob(title: string) {
	const chat = chatStore.createChat(`Test: ${title}`);
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: `call-${createdJobs.length}-${Date.now()}`, input: INPUT });
	createdJobs.push(job.id);
	return job;
}

describe("job deadline + attempts (runner)", () => {
	it("a run that hits its budget releases the lease and asks for a fresh run — no result, no delivery", async () => {
		const job = newResearchJob("deadline");
		const delivery = recordingDeliver();
		const redispatched: string[] = [];
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, budgetMs: () => 120, redispatch: (id) => redispatched.push(id) });
		researchModelOverride.current = hungEngine();
		const t0 = Date.now();
		await runner.runJob(job.id);
		assert.ok(Date.now() - t0 < 5_000, "the budget stopped the hung call");
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.status, "running", "handed back, not failed");
		assert.equal(after.lease, null, "lease released");
		assert.equal(after.attempts, 1);
		assert.equal(after.result, undefined);
		assert.match(after.activity, /out of time — resuming in a fresh run \(attempt 2 of 3\)/);
		assert.deepEqual(redispatched, [job.id]);
		assert.equal(delivery.steers.length, 0);
		assert.equal(isJobLive(job.id), false);
	});

	it("after maxAttempts the job fails with an honest out-of-time result that reaches the lesson", async () => {
		const job = newResearchJob("attempt cap");
		const delivery = recordingDeliver();
		const redispatched: string[] = [];
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, budgetMs: () => 80, redispatch: (id) => redispatched.push(id) });
		researchModelOverride.current = hungEngine(10);
		for (let i = 0; i < 3; i++) await runner.runJob(job.id);
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.status, "error");
		assert.equal(after.attempts, 3);
		assert.equal(redispatched.length, 2, "two hand-backs, then the give-up");
		const result = after.result as ResearchResult;
		assert.equal(result.brief, `Research failed: ${outOfTimeReason(3)}`);
		assert.equal(delivery.steers.length, 1, "the failure is delivered — the teacher never waits forever");
		assert.match(delivery.steers[0]!.content, /ran out of time/);
		// A fourth start (e.g. a late recovery) is a no-op on a finished job.
		await runner.runJob(job.id);
		assert.equal(delivery.steers.length, 1);
	});

	it("a job already past the attempt cap (killed at the wall every time) gives up at once without a model call", async () => {
		const job = newResearchJob("killed thrice");
		jobStore.updateJob(job.id, { attempts: 3, lease: { owner: "dead", until: Date.now() - 1 } });
		const delivery = recordingDeliver();
		const engine = hungEngine();
		researchModelOverride.current = engine;
		await createJobRunner({ chatStore, jobStore, deliver: delivery.deliver }).runJob(job.id);
		assert.equal(engine.started(), 0);
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.status, "error");
		assert.match((after.result as ResearchResult).brief, /ran out of time — the job was stopped at the hosting time limit 3 times/);
		assert.equal(delivery.steers.length, 1);
	});

	it("usage is cumulative across attempts", async () => {
		const job = newResearchJob("usage carry");
		jobStore.updateJob(job.id, { attempts: 1, usage: { model: "faux:x", inputTokens: 100, outputTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined, steps: 1 } });
		researchModelOverride.current = fauxEngine([fauxAssistantMessage([fauxText(BRIEF)])]);
		await createJobRunner({ chatStore, jobStore, deliver: recordingDeliver().deliver }).runJob(job.id);
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.status, "done");
		assert.equal(after.attempts, 2);
		assert.ok((after.usage?.steps ?? 0) >= 2, `steps carried over (got ${after.usage?.steps})`);
	});
});

describe("job lease (no duplicates across instances)", () => {
	it("a live lease held elsewhere blocks the run entirely", async () => {
		const job = newResearchJob("foreign lease");
		jobStore.updateJob(job.id, { lease: { owner: "other-instance:abc", until: Date.now() + 60_000 }, attempts: 1 });
		const engine = hungEngine();
		researchModelOverride.current = engine;
		const delivery = recordingDeliver();
		await createJobRunner({ chatStore, jobStore, deliver: delivery.deliver }).runJob(job.id);
		assert.equal(engine.started(), 0);
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.attempts, 1, "not counted as an attempt");
		assert.equal(after.lease?.owner, "other-instance:abc");
	});

	it("an expired lease (the instance was killed) re-runs to completion and clears the claim", async () => {
		const job = newResearchJob("expired lease");
		jobStore.updateJob(job.id, { lease: { owner: "killed:abc", until: Date.now() - 1_000 }, attempts: 1 });
		researchModelOverride.current = fauxEngine([fauxAssistantMessage([fauxText(BRIEF)])]);
		const delivery = recordingDeliver();
		await createJobRunner({ chatStore, jobStore, deliver: delivery.deliver }).runJob(job.id);
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.status, "done");
		assert.equal(after.attempts, 2);
		assert.equal(after.lease, null);
		assert.equal(delivery.steers.length, 1);
	});

	it("the lease is renewed while the loop runs", async () => {
		jobLeaseTuning.renewMs = 30;
		jobLeaseTuning.ttlMs = 200;
		const job = newResearchJob("renewal");
		const runner = createJobRunner({ chatStore, jobStore, deliver: recordingDeliver().deliver, budgetMs: () => 400, redispatch: () => {} });
		researchModelOverride.current = hungEngine();
		const running = runner.runJob(job.id);
		await new Promise((r) => setTimeout(r, 60));
		const first = jobStore.getJob(job.id)!.lease!.until;
		await new Promise((r) => setTimeout(r, 120));
		const later = jobStore.getJob(job.id)!.lease!.until;
		assert.ok(later > first, "renewed");
		await running;
	});

	it("a worker whose lease was taken over unwinds without writing a result", async () => {
		jobLeaseTuning.renewMs = 25;
		const job = newResearchJob("lost lease");
		const delivery = recordingDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		researchModelOverride.current = hungEngine();
		const running = runner.runJob(job.id);
		await new Promise((r) => setTimeout(r, 40));
		jobStore.updateJob(job.id, { lease: { owner: "thief:1", until: Date.now() + 60_000 } });
		await running;
		const after = jobStore.getJob(job.id)!;
		assert.equal(after.status, "running", "the new owner owns the outcome");
		assert.equal(after.lease?.owner, "thief:1");
		assert.equal(after.result, undefined);
		assert.equal(delivery.steers.length, 0);
	});

	it("leaseHeldElsewhere: own, foreign, expired, released", () => {
		const now = 1_000;
		assert.equal(leaseHeldElsewhere({ lease: { owner: "a", until: 2_000 } }, "a", now), false);
		assert.equal(leaseHeldElsewhere({ lease: { owner: "b", until: 2_000 } }, "a", now), true);
		assert.equal(leaseHeldElsewhere({ lease: { owner: "b", until: 500 } }, "a", now), false);
		assert.equal(leaseHeldElsewhere({ lease: null }, "a", now), false);
		assert.equal(leaseHeldElsewhere({}, undefined, now), false);
	});
});

describe("recovery sweep respects the durable lease", () => {
	function sweep(): void {
		const g = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
		if (g.__lhWakePipeline) g.__lhWakePipeline.lastSweepAt = 0;
		recoverStaleJobs();
	}

	it("never respawns a job another instance is running; respawns once the claim lapses", () => {
		const job = newResearchJob("sweep");
		const respawned: string[] = [];
		setJobRespawn((id) => respawned.push(id));
		jobStore.updateJob(job.id, { lease: { owner: "other:1", until: Date.now() + 60_000 } });
		sweep();
		assert.ok(!respawned.includes(job.id), "live foreign lease → untouched");
		jobStore.updateJob(job.id, { lease: { owner: "other:1", until: Date.now() - 1 } });
		sweep();
		assert.ok(respawned.includes(job.id), "lapsed lease → re-run");
	});
});

describe("internal dispatch envelopes", () => {
	const env = { CRON_SECRET: "s3cret", VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "example.vercel.app" };

	it("round-trips, refuses tampering, expiry, bad tasks and a missing secret", () => {
		const now = Date.now();
		const signed = signEnvelope({ task: { kind: "job", jobId: "job_1" }, user: { id: "u1", role: "member" }, exp: now + 1_000 }, env)!;
		assert.deepEqual(verifyEnvelope(signed.body, signed.signature, now, env)?.task, { kind: "job", jobId: "job_1" });
		assert.equal(verifyEnvelope(signed.body.replace("job_1", "job_2"), signed.signature, now, env), null, "tampered body");
		assert.equal(verifyEnvelope(signed.body, signed.signature, now + 5_000, env), null, "expired");
		assert.equal(verifyEnvelope(signed.body, null, now, env), null, "unsigned");
		assert.equal(verifyEnvelope(signed.body, signed.signature, now, { CRON_SECRET: "other" }), null, "wrong key");
		const bad = signEnvelope({ task: { kind: "job", jobId: "../etc" }, user: null, exp: now + 1_000 }, env)!;
		assert.equal(verifyEnvelope(bad.body, bad.signature, now, env), null, "unsafe id");
		assert.equal(signEnvelope({ task: { kind: "deliver", chatId: "c" }, user: null, exp: now }, {}), null);
	});

	it("targets the production alias on Vercel only; opt-out and opt-in switches", () => {
		assert.equal(dispatchTarget(env), "https://example.vercel.app/api/internal/run");
		assert.equal(dispatchTarget({ ...env, LH_INTERNAL_DISPATCH: "0" }), null);
		assert.equal(dispatchTarget({ CRON_SECRET: "x" }), null, "local: in-process");
		assert.equal(dispatchTarget({ CRON_SECRET: "x", LH_INTERNAL_DISPATCH: "1", LH_INTERNAL_ORIGIN: "http://localhost:3000/" }), "http://localhost:3000/api/internal/run");
		assert.equal(dispatchTarget({ VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "x.app" }), null, "no secret → in-process");
		assert.equal(dispatchTarget({ ...env, VERCEL_ENV: "preview" }), null, "previews stay in-process");
		assert.ok(dispatchTarget({ ...env, VERCEL_ENV: "production" }));
	});
});

describe("turn deadline", () => {
	it("the invocation clock: deadlines count from the request start and survive awaits", async () => {
		assert.equal(invocationStartedAt(), undefined);
		assert.equal(remainingInvocationBudget(10_000), 10_000, "outside a request: the whole budget");
		const start = Date.now() - 4_000; // the request began 4 s ago (e.g. compaction ran first)
		await runWithInvocationClock(async () => {
			await new Promise((r) => setTimeout(r, 5));
			assert.equal(invocationStartedAt(), start);
			const left = remainingInvocationBudget(10_000);
			assert.ok(left <= 6_000 && left > 5_000, `left ${left}`);
			assert.equal(remainingInvocationBudget(3_000), 1_000, "floored, never negative");
			// Background work started inside inherits the clock.
			await new Promise<void>((resolve) => setTimeout(() => { assert.equal(invocationStartedAt(), start); resolve(); }, 5));
		}, start);
	});

	it("budgets: Vercel defaults, env overrides, none locally", () => {
		assert.equal(turnBudgetMs({ VERCEL: "1" }), 270_000);
		assert.equal(turnBudgetMs({ VERCEL: "1", LH_TURN_BUDGET_MS: "1000" }), 1_000);
		assert.equal(turnBudgetMs({}), undefined);
		assert.equal(jobBudgetMs({ VERCEL: "1" }), 240_000);
		assert.equal(jobBudgetMs({ LH_JOB_BUDGET_MS: "5000" }), 5_000);
		assert.equal(jobBudgetMs({}), undefined);
	});

	it("rewrites the aborted tail into an explained error; synthesizes one when the model never answered", () => {
		const user = { role: "user", content: "hi" };
		const aborted = { role: "assistant", content: [], stopReason: "aborted", provider: "nvidia", model: "m", api: "openai-completions" };
		const marked = markTurnOutOfTime([user, aborted], 1, 270_000) as Array<Record<string, unknown>>;
		assert.equal(marked[1]!.stopReason, "error");
		assert.equal(marked[1]!.errorMessage, outOfTimeTurnText(270_000));
		assert.match(String(marked[1]!.errorMessage), /ran out of time.*270 s time budget/);
		const synthesized = markTurnOutOfTime([user], 1, 1_000) as Array<Record<string, unknown>>;
		assert.equal(synthesized.length, 2);
		assert.equal(synthesized[1]!.role, "assistant");
		assert.equal(synthesized[1]!.stopReason, "error");
		// A turn that ended on a tool result gets an appended explained reply;
		// the earlier tool-call message keeps its own stop reason.
		const toolUse = { role: "assistant", content: [], stopReason: "toolUse", provider: "nvidia", model: "m", api: "openai-completions" };
		const toolResult = { role: "toolResult", toolCallId: "t1", content: [] };
		const appended = markTurnOutOfTime([user, toolUse, toolResult], 1, 1_000) as Array<Record<string, unknown>>;
		assert.equal(appended.length, 4);
		assert.equal(appended[1]!.stopReason, "toolUse");
		assert.equal(appended[3]!.role, "assistant");
		assert.equal(appended[3]!.stopReason, "error");
		assert.equal(appended[3]!.provider, "nvidia");
		// Earlier (base) assistant messages are never rewritten.
		const base = markTurnOutOfTime([aborted, user], 1, 1_000) as Array<Record<string, unknown>>;
		assert.equal(base[0]!.stopReason, "aborted");
	});

	it("end to end: a hung teacher is stopped at the budget and the record ends with the explained error", async () => {
		process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
		const prev = process.env.LH_TURN_BUDGET_MS;
		process.env.LH_TURN_BUDGET_MS = "200";
		try {
			const chat = chatStore.createChat("Test: turn deadline e2e");
			chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
			const engine = hungEngine();
			const agent: Parameters<typeof handleChatRequest>[1] = (opts) => createTeacherAgent(undefined, { engine, tools: {}, messages: opts.messages });
			const req = new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "teach me" } }) });
			const t0 = Date.now();
			const ack = await handleChatRequest(req, agent);
			assert.equal(ack.status, 200);
			const handle = runningTurn(chat.id);
			if (handle) await new Response(handle.subscribe()).text();
			for (let i = 0; i < 200 && runningTurn(chat.id); i++) await new Promise((r) => setTimeout(r, 25));
			assert.ok(Date.now() - t0 < 10_000);
			const messages = chatStore.getChat(chat.id)!.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
			const last = messages.filter((m) => m.role === "assistant").at(-1)!;
			assert.equal(last.stopReason, "error");
			assert.equal(last.errorMessage, outOfTimeTurnText(200));
		} finally {
			if (prev === undefined) delete process.env.LH_TURN_BUDGET_MS;
			else process.env.LH_TURN_BUDGET_MS = prev;
		}
	});
});
