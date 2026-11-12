import type { PiEngine } from "../models.ts";
import type { SearchProvider } from "../../core/search.ts";
import {
	accumulateJobUsage,
	buildSubagentSteer,
	isSubagentFailure,
	isWebSourceUrl,
	piUsageToStep,
	isBuiltinJobKind,
	type DemoResult,
	type DemoToolInput,
	type BuiltinJobKind,
	type JobRecord,
	type JobUsage,
	type PdfResult,
	type PdfToolInput,
	type ResearchResult,
	type ResearchToolInput,
	type SteerMessage,
	type UsageStepLike,
	type VisualResult,
	type VisualToolInput,
} from "../../core/contracts.ts";
import { isJobLive, registerJobAbort, unregisterJobAbort } from "./aborts.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRole } from "../../../config.ts";
import { ROLE_SLOT, modelsNotConfigured, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
import { runDemoBuilder } from "./demo-builder.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";
import { runResearcherAgent } from "./researcher.ts";
import { runVisualMaker } from "./visual-maker.ts";
import { loadLearnerImage, type LearnerImage } from "../tools/learner-image.ts";
import { LEARNER_IMAGE_HREF } from "../../core/learner-image-svg.ts";

/**
 * The background job runner (contracts.ts "THE ASYNC PROTOCOL" §2–3), created
 * via createJobRunner({ chatStore, jobStore, deliver }) — the composition root
 * (chat-handler) injects the storage ports and the WAKE SEAM (the server-side
 * steer delivery, src/server/jobs.ts); this module never imports an adapter.
 *
 *   runJob(jobId) — runs the kind's sub-agent loop in the background
 *     (the job tools' execute fires this via the spawn seam, fire-and-forget),
 *     updating the job's activity line on every iteration. On completion the
 *     runner builds the STEER MESSAGE (buildSubagentSteer) and hands it to
 *     `deliver` without waiting. The worker's final outcome and pending
 *     delivery are saved together; the session owns delivery from then on.
 *
 *   On failure the result is the failure shape (empty html/svg + "FAILED: …"
 *   notes; research: failure brief) — and it STILL steers, because the
 *   teacher must learn the outcome. Failed delivery starts stay quietly
 *   pending and never rewrite the worker's computation outcome.
 */

/**
 * Test seam: the spawn wiring has no injection point at the tool layer, so
 * tests swap in a scripted pi engine here to keep job tests off the network.
 * Undefined in production. (The jobs spawn through the module-level KIND
 * runners, which read these at call time.)
 */
export const researchModelOverride: { current?: PiEngine } = {};
export const demoModelOverride: { current?: PiEngine } = {};
export const visualModelOverride: { current?: PiEngine } = {};
export const pdfModelOverride: { current?: PiEngine } = {};

/** The dispatch-time tool input (from src/agent/tools/jobs.ts schemas). */
type JobToolInput = ResearchToolInput | DemoToolInput | VisualToolInput | PdfToolInput;

export interface JobRunnerDeps {
	chatStore: ChatStore;
	jobStore: JobStore;
	/**
	 * Hand a finished job's steer to the session delivery registry. The
	 * promise tracks durable marker acceptance, but the worker never waits
	 * on it. Its persisted pending obligation survives process restart.
	 */
	deliver: (steer: SteerMessage) => Promise<void>;
	/** Settings-resolved engine per role (model slots wave, 2026-09-20):
	 *  the role-override → slot chain, read FRESH per job (the server
	 *  wiring passes effectiveSettings-based resolution). Test overrides
	 *  (below) still win. BYOK (owner, 2026-09-22): the chain may end
	 *  EMPTY → undefined; runJob then refuses the spawn honestly instead
	 *  of guessing a model. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** The search seam (search port wave, 2026-09-20): resolves the LIVE
	 *  provider fresh per job — server/search.ts composition injected by
	 *  the wiring; null = honestly unavailable (the researcher's web_search
	 *  reports it as recoverable text). Absent seam (tests) reads the same;
	 *  research dispatch and web_fetch do not require search credentials. */
	searchProvider?: () => SearchProvider | null;
	/** Key-presence gate (provider-key interlude, 2026-09-25): given the
	 *  resolved engine's provider + the kind's slot tier, return the
	 *  refusal envelope when the provider's key is missing (null = run).
	 *  Injected because the agent layer may not read the key store; absent
	 *  in tests that inject engines directly (test engines never owe a key). */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
	/** Wall-clock budget for ONE run of a job, in ms (reliability wave,
	 *  2026-11). Hosts that kill a function at a hard wall (Vercel: 300 s)
	 *  pass a figure below the wall: the runner stops the loop itself at the
	 *  budget, hands the job back (lease released) and asks `redispatch` for
	 *  a fresh run — instead of being killed mid-write with no trace.
	 *  undefined = no budget (local server / desktop / tests). Read per run. */
	budgetMs?: (job: JobRecord) => number | undefined;
	/** Start a released job again in a FRESH function invocation (its own
	 *  time budget). Absent → the next recovery sweep re-runs it. */
	redispatch?: (jobId: string) => void;
}

/** Lease + retry tuning (reliability wave, 2026-11). Mutable for tests. */
export const jobLeaseTuning = {
	/** How long a claim holds without renewal. Must comfortably exceed
	 *  renewMs (a slow store write must not let a live job's claim lapse). */
	ttlMs: 60_000,
	renewMs: 20_000,
	/** Worker starts per job, counting hosting kills and out-of-time stops. */
	maxAttempts: 3,
};

/** One opaque id per server process — the owner half of a lease. */
const INSTANCE_ID = `${process.env.VERCEL_REGION ?? "local"}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** The honest failure text when a job keeps running out of time. */
export function outOfTimeReason(attempts: number): string {
	return `ran out of time — the job was stopped at the hosting time limit ${attempts} time${attempts === 1 ? "" : "s"} without finishing`;
}

/** True when another worker holds a live claim on the job. */
export function leaseHeldElsewhere(job: Pick<JobRecord, "lease">, owner: string | undefined, now = Date.now()): boolean {
	return !!job.lease && job.lease.until > now && job.lease.owner !== owner;
}

export interface JobRunner {
	/** Run one job's sub-agent loop to completion (background; never throws).
	 *  The tool input rides along from dispatch (the spawn fires mid-stream,
	 *  before the tool part is persisted). Recovery reads saved job input,
	 *  with transcript fallback for legacy jobs. Delivery is not awaited. */
	runJob(jobId: string, input?: JobToolInput): Promise<void>;
}

/** One job loop's injected machinery: the kill switch (real abort, 2026-09
 * semantics) and the usage tap (money channel — every model call folds into
 * JobRecord.usage as it completes). */
interface LoopContext {
	/** Fires when abortJob kills the run; abortSignal is passed into every
	 * model call so the spend stops mid-call, not at the next loop check. */
	abortSignal: AbortSignal;
	/** The job's chat (debug: raw provider-event recording under
	 * LH_PROVIDER_EVENTS=1 — forwarded into every subagent run). */
	chatId?: string;
	/** Fold one model call's usage into the job record (progress write). */
	onUsage: (step: UsageStepLike) => void;
	/** The kill switch behind abortSignal (deadline / lost-lease stops). */
	controller: AbortController;
}

/** The kind→role table (model slots wave, 2026-09-20): which ModelRole's
 * engine each sub-agent kind runs — the engineFor injection key. */
const KIND_ROLE: Record<BuiltinJobKind, ModelRole> = {
	research: "researcher",
	demo: "demoBuilder",
	visual: "visualMaker",
	pdf: "pdfReader",
};

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { chatStore, jobStore, deliver } = deps;

	/** Running usage totals per live job (the loop's onUsage folds here,
	 * then writes through the job store so the poll sees progress). */
	const usageTotals = new Map<string, JobUsage>();
	/** Lease owner per job this runner is executing. */
	const leaseOwners = new Map<string, string>();
	/** Jobs whose run hit its time budget: the loop's own (abort-shaped)
	 *  outcome is discarded; runJob's finally hands the job back instead. */
	const outOfTime = new Set<string>();
	/** Jobs whose claim another worker took over: unwind without writing. */
	const lostLease = new Set<string>();

	function makeLoopContext(jobId: string, engine: PiEngine): LoopContext {
		const chatId = jobStore.getJob(jobId)?.chatId;
		// Provider-qualified stamp: the engine's actual model — the only
		// thing that ran (BYOK: no config-pin fallback stamps exist).
		const model = `${engine.model.provider}:${engine.model.id}`;
		// Real-kill wiring (2026-09 abort semantics): the controller is what
		// the abort endpoint fires (agent/subagents/aborts.ts registry); the
		// signal rides into every model call of the loop.
		const controller = new AbortController();
		registerJobAbort(jobId, controller);
		return {
			controller,
			abortSignal: controller.signal,
			chatId,
			onUsage: (step) => {
				const next = accumulateJobUsage(usageTotals.get(jobId), model, step);
				usageTotals.set(jobId, next);
				jobStore.updateJob(jobId, { usage: next }); // merge patch — status untouched
			},
		};
	}

	/** True while the job may still write terminal state (result, error,
	 * steer). False once abortJob has flipped it to error ("Aborted by learner") —
	 * the runner then unwinds silently; the abort path owns the record and
	 * the abort steer. */
	function stillRunning(jobId: string): boolean {
		return jobStore.getJob(jobId)?.status === "running";
	}

	/** Persist a maker's progress as a job checkpoint (checkpoints wave,
	 *  2026-11). Only while THIS run still owns the record: an aborted job or
	 *  a lease another instance took over is never written. The write is
	 *  merged (status untouched) and intentionally unthrottled — the sniffed
	 *  drafts are the whole point, and job writes are small and rare. */
	function saveCheckpoint(jobId: string, draft: string, verified: boolean): void {
		const current = jobStore.getJob(jobId);
		if (!current || current.status !== "running") return;
		if (leaseHeldElsewhere(current, leaseOwners.get(jobId))) return;
		jobStore.updateJob(jobId, { checkpoint: { draft, verified, at: Date.now() } });
	}

	/** The kind→runner map: one sub-agent loop per kind. Each kind's
	 *  runner narrows the union input itself (dispatch-time inputs are
	 *  kind-correct by construction; transcript fallbacks are cast after). */
	/** The engine one job runs on: test override first (the old seam —
	 *  tests swap scripted engines without touching deps), then the injected
	 *  settings-resolved engineFor. undefined = the BYOK chain came up
	 *  empty (owner, 2026-09-22) — runJob refuses below, honestly. */
	function pickEngine(kind: BuiltinJobKind): PiEngine | undefined {
		const testOverride: Record<string, { current?: PiEngine } | undefined> = {
			researcher: researchModelOverride,
			demoBuilder: demoModelOverride,
			visualMaker: visualModelOverride,
			pdfReader: pdfModelOverride,
		};
		return testOverride[KIND_ROLE[kind]]?.current ?? deps.engineFor?.(KIND_ROLE[kind]);
	}

	const KIND_RUNNERS: Record<
		BuiltinJobKind,
		(jobId: string, engine: PiEngine, input: JobToolInput | undefined, loop: LoopContext) => Promise<void>
	> = {
		research: (jobId, engine, input, loop) => runResearchJob(jobId, engine, input, loop),
		demo: (jobId, engine, input, loop) => runDemoJob(jobId, engine, input, loop),
		visual: (jobId, engine, input, loop) => runVisualJob(jobId, engine, input, loop),
		pdf: (jobId, engine, input, loop) => runPdfJob(jobId, engine, input, loop),
	};

	async function runJob(jobId: string, input?: JobToolInput): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) {
			console.error(`[job ${jobId}] not found — nothing to run`);
			return;
		}
		if (job.status !== "running" || !isBuiltinJobKind(job.kind)) return; // plugin tasks never enter the core runner
		const run = KIND_RUNNERS[job.kind];
		if (!run) {
			console.error(`[job ${jobId}] unknown kind: ${job.kind}`);
			jobStore.updateJob(jobId, { status: "error", error: `unknown kind ${job.kind}`, activity: "failed" });
			return;
		}
		// The per-need refusal guards (BYOK 2026-09-22 / provider-key
		// interlude 2026-09-25): no engine for the kind's tier, or the
		// resolved engine's provider key gone — both refuse through the SAME
		// convention as every other failed job: record the honest error (no
		// status flip: finalizeJob owns the terminal flip after delivery),
		// then steer the kind's failure shape through finishJob so the wake
		// pipeline resumes the lesson and the teacher reads the refusal
		// instead of waiting forever on a job it already dispatched.
		const refuse = async (reason: string): Promise<void> => {
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, failureFor(job, input, reason));
		};
		if (isJobLive(jobId)) return; // this process is already executing it
		if (leaseHeldElsewhere(job, undefined)) {
			// Another server instance holds a live claim (it renews while it
			// runs): never compute beside it. Its lapse is what recovery waits on.
			console.info(`[job ${jobId}] skipped — claimed by ${job.lease?.owner} until ${new Date(job.lease!.until).toISOString()}`);
			return;
		}
		const attempts = (job.attempts ?? 0) + 1;
		if (attempts > jobLeaseTuning.maxAttempts) {
			const reason = outOfTimeReason(job.attempts ?? 0);
			console.error(`[job ${jobId}] giving up — ${reason}`);
			// The checkpoint may have been written by an attempt that was killed
			// before its own finally ran; read the latest record. (No stale
			// outOfTime entry can be present here: a same-process run still
			// executing would have tripped isJobLive above.)
			const current = jobStore.updateJob(jobId, { lease: null }) ?? job;
			const salvaged = checkpointResult(current, input, job.attempts ?? 0);
			if (salvaged) {
				console.info(`[job ${jobId}] delivering the last verified checkpoint instead of failing`);
				await finishJob(jobId, salvaged);
				return;
			}
			await refuse(reason);
			return;
		}
		await runClaimed(jobId, job, input, attempts, run, refuse);
	}

	/** The kind's failure-shaped result for an honest refusal / give-up. */
	function failureFor(job: JobRecord, input: JobToolInput | undefined, reason: string): ResearchResult | DemoResult | VisualResult | PdfResult {
			const resolved = resolveInput(job, input) as
				| ResearchToolInput
				| DemoToolInput
				| VisualToolInput
				| PdfToolInput
				| undefined;
			const pdf = resolved as PdfToolInput | undefined;
			const failure: ResearchResult | DemoResult | VisualResult | PdfResult =
				job.kind === "research"
					? { brief: `Research failed: ${reason}`, sources: [] }
					: job.kind === "demo"
						? {
								title: typeof (resolved as DemoToolInput | undefined)?.title === "string" && (resolved as DemoToolInput).title.trim() ? (resolved as DemoToolInput).title : "Interactive demo",
								html: "",
								tested: true,
								notes: `FAILED: ${reason}`,
							}
						: job.kind === "visual"
							? { svg: "", notes: `FAILED: ${reason}` }
							: {
									path: typeof pdf?.path === "string" ? pdf.path : "",
									question: typeof pdf?.question === "string" ? pdf.question : "",
									brief: `PDF failed: ${reason}`,
									pagesRead: [],
									pagesConsulted: [],
								};
			return failure;
	}

	/** The success result a give-up delivers when the record holds a VERIFIED
	 *  checkpoint (checkpoints wave, 2026-11): the work exists and the maker
	 *  had rendered / headlessly tested exactly that draft, so the attempt cap
	 *  must not throw it away. null = keep the old failure path (another kind,
	 *  no verified checkpoint, or an ANNOTATED visual: its SVG retains the
	 *  learner-image placeholder, which only the visual maker's finish()
	 *  resolves into a deliverable — delivering it raw would leak the
	 *  placeholder as the picture). */
	function checkpointResult(job: JobRecord, input: JobToolInput | undefined, attempts: number): DemoResult | VisualResult | null {
		if (job.kind !== "demo" && job.kind !== "visual") return null;
		const checkpoint = job.checkpoint;
		if (!checkpoint?.verified || !checkpoint.draft) return null;
		const notes = `Delivered the last verified draft: the job hit the hosting time limit ${attempts} times before the maker finished polishing it.`;
		if (job.kind === "visual") {
			if (checkpoint.draft.includes(LEARNER_IMAGE_HREF)) return null;
			return { svg: checkpoint.draft, notes };
		}
		const resolved = resolveInput(job, input) as DemoToolInput | undefined;
		const title = typeof resolved?.title === "string" && resolved.title.trim() ? resolved.title : "Interactive demo";
		return { title, html: checkpoint.draft, tested: true, notes };
	}

	async function runClaimed(
		jobId: string,
		job: JobRecord,
		input: JobToolInput | undefined,
		attempts: number,
		run: (jobId: string, engine: PiEngine, input: JobToolInput | undefined, loop: LoopContext) => Promise<void>,
		refuse: (reason: string) => Promise<void>,
	): Promise<void> {
		if (!isBuiltinJobKind(job.kind)) return; // plugin tasks never enter the core runner
		const kind = job.kind;
		const engine = pickEngine(kind);
		if (!engine) {
			const tier = ROLE_SLOT[KIND_ROLE[kind]];
			const envelope = modelsNotConfigured([tier]);
			console.info(`[job ${jobId}] refused — ${JSON.stringify(envelope)}`);
			await refuse(`${envelope.error} (missing: ${tier})`);
			return;
		}
		// Key presence (2026-09-25): the engine exists, but its provider's
		// key may be gone — refuse the spawn BEFORE the loop, same
		// convention (the injected check reads the key store; absent in
		// engine-injecting tests).
		const keyRefusal =
			deps.providerKeyMissing?.(engine.model.provider, ROLE_SLOT[KIND_ROLE[kind]]) ?? null;
		if (keyRefusal) {
			console.info(`[job ${jobId}] refused — ${JSON.stringify(keyRefusal)}`);
			await refuse(keyRefusal.error);
			return;
		}
		// CLAIM (reliability wave, 2026-11): a durable lease other instances
		// respect, renewed while the loop runs, plus the attempt count that
		// bounds re-runs after hosting kills. Earlier usage is carried over
		// so a resumed job's money channel stays cumulative.
		const owner = `${INSTANCE_ID}:${Math.random().toString(36).slice(2, 8)}`;
		leaseOwners.set(jobId, owner);
		if (job.usage) usageTotals.set(jobId, job.usage);
		jobStore.updateJob(jobId, {
			lease: { owner, until: Date.now() + jobLeaseTuning.ttlMs },
			attempts,
			...(attempts > 1 ? { activity: `resuming (attempt ${attempts} of ${jobLeaseTuning.maxAttempts})`, error: undefined } : {}),
		});
		const loop = makeLoopContext(jobId, engine);
		const renew = setInterval(() => {
			const current = jobStore.getJob(jobId);
			if (!current || current.status !== "running") return;
			if (current.lease && current.lease.owner !== owner) {
				// Someone else re-ran the job (our claim lapsed — e.g. a frozen
				// instance): stop computing; their run owns the record now.
				lostLease.add(jobId);
				loop.controller.abort();
				return;
			}
			jobStore.updateJob(jobId, { lease: { owner, until: Date.now() + jobLeaseTuning.ttlMs } });
		}, jobLeaseTuning.renewMs);
		const budget = deps.budgetMs?.(job);
		const deadline = budget && budget > 0
			? setTimeout(() => {
				if (!stillRunning(jobId)) return;
				console.error(`[job ${jobId}] out of time after ${budget} ms (attempt ${attempts}) — stopping the loop`);
				outOfTime.add(jobId);
				loop.controller.abort();
			}, budget)
			: undefined;
		try {
			await run(jobId, engine, input, loop);
		} finally {
			clearInterval(renew);
			if (deadline) clearTimeout(deadline);
			unregisterJobAbort(jobId);
			// The last usage write may have been mid-flight when the loop died;
			// persist what was folded (the abort path patches only status, so
			// this never resurrects an aborted job — merge patch).
			const usage = usageTotals.get(jobId);
			if (usage) jobStore.updateJob(jobId, { usage });
			usageTotals.delete(jobId);
			leaseOwners.delete(jobId);
			const lost = lostLease.delete(jobId);
			const timedOut = outOfTime.delete(jobId);
			const current = jobStore.getJob(jobId);
			const ours = current?.lease?.owner === owner;
			if (!lost && ours && timedOut && current?.status === "running") {
				if (attempts < jobLeaseTuning.maxAttempts) {
					// Hand the job back for a fresh run with a full budget.
					jobStore.updateJob(jobId, {
						lease: null,
						error: undefined,
						activity: `out of time — resuming in a fresh run (attempt ${attempts + 1} of ${jobLeaseTuning.maxAttempts})`,
					});
					deps.redispatch?.(jobId);
				} else {
					jobStore.updateJob(jobId, { lease: null });
					// Checkpoints wave: a verified draft IS the work. Deliver it
					// instead of failing. (outOfTime.delete ran above, so
					// finishJob's hand-back guard cannot swallow this result.)
					const salvaged = checkpointResult(current ?? job, input, attempts);
					if (salvaged) {
						console.info(`[job ${jobId}] delivering the last verified checkpoint instead of failing`);
						await finishJob(jobId, salvaged);
					} else {
						await refuse(outOfTimeReason(attempts));
					}
				}
			} else if (!lost && ours) {
				jobStore.updateJob(jobId, { lease: null });
			}
		}
	}

	/** Dispatch input wins, then the job's saved arguments. Legacy jobs
	 * without saved input fall back to the durable transcript, which may
	 * lack a call if the dispatching turn died before settlement. */
	function resolveInput(
		job: JobRecord,
		input: JobToolInput | undefined,
	): JobToolInput | undefined {
		if (input) return input;
		if (job.input !== undefined) return job.input as JobToolInput;
		const chat = chatStore.getChat(job.chatId);
		if (!chat) return undefined;
		// Wave D: the record is native history — the scan reads the native
		// assistant blocks directly (a toolCall's arguments are the input).
		for (const m of chat.messages) {
			if ((m as { role?: string }).role !== "assistant") continue;
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<{ type?: string; id?: string; arguments?: unknown }>) {
				if (block.type !== "toolCall" || block.id !== job.toolCallId) continue;
				return block.arguments as JobToolInput | undefined;
			}
		}
		return undefined;
	}

	/**
	 * Save the computation outcome and session delivery obligation together.
	 * Worker liveness ends after cleanup, not after a lesson consumes the result.
	 */
	async function finishJob(jobId: string, result: ResearchResult | DemoResult | VisualResult | PdfResult): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) return;
		// Aborted mid-run (abortJob flips the record before
		// the loop unwinds): no result write, no steer — the abort path owns
		// the record and queues the abort steer itself.
		if (job.status !== "running") return;
		// Reliability wave: a run stopped at its time budget hands the job
		// back (runJob's finally) — its abort-shaped outcome is not a result;
		// a run whose claim another worker took over never writes.
		if (outOfTime.has(jobId) || lostLease.has(jobId)) return;
		if (leaseHeldElsewhere(job, leaseOwners.get(jobId))) {
			console.error(`[job ${jobId}] result dropped — job is claimed by ${job.lease?.owner}`);
			return;
		}
		const failed = isSubagentFailure(job.kind, result);
		jobStore.updateJob(jobId, {
			result,
			status: failed ? "error" : "done",
			activity: failed ? "failed" : "finished",
			delivery: { kind: "result", status: "pending" },
		});
		// The saved result now belongs to the session. Do not keep the worker,
		// abort registration, or temporary resources alive behind a question.
		void deliver(buildSubagentSteer(job, result)).catch((err: unknown) => {
			console.error(`[job ${jobId}] pending delivery:`, err);
		});
	}

	/** Chat-record + input resolution shared by all three runners. */
	function jobContext(jobId: string): { job: JobRecord; chatId: string } | null {
		const job = jobStore.getJob(jobId);
		if (!job || job.status !== "running") return null;
		const chat = chatStore.getChat(job.chatId);
		if (!chat) {
			jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
			return null;
		}
		return { job, chatId: job.chatId };
	}

	// ─── research ───────────────────────────────────────────────────────────

	async function runResearchJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as ResearchToolInput | undefined;
		if (!(typeof input?.question === "string" && input.question.trim())) {
			jobStore.updateJob(jobId, { error: "research question unavailable" });
			await finishJob(jobId, { brief: "Research failed: the research question is unavailable.", sources: [] });
			return;
		}
		const question = input.question;
		const context = typeof input?.context === "string" && input.context.trim() ? input.context : undefined;

		const prompt = [
			`Research question: ${question}`,
			context ? `Context (what this is needed for): ${context}` : null,
			"Produce your final brief in the required format.",
		]
			.filter(Boolean)
			.join("\n\n");

		const fetchedUrls: string[] = [];
		// Per-job PDF dir (researcher PDF wave, 2026-10-07): web_fetch_pdf
		// downloads land here; every pdf tool is scoped to it; it dies with
		// the job (never enters the record).
		const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-research-"));

		try {
			jobStore.updateJob(jobId, { activity: "researching" });
			const brief = await runResearcherAgent(prompt, {
				engine: model,
				search: deps.searchProvider,
				pdfDir,
				abortSignal: loop.abortSignal,
				chatId: loop.chatId,
				// Money channel: each agent step is one model call — fold its
				// usage into the record as it completes (progress write).
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onToolStart: (toolName, args) => {
					const input = args as { query?: string; url?: string } | undefined;
					if (typeof input?.url === "string" && (toolName === "web_fetch" || toolName === "web_fetch_pdf")) {
						fetchedUrls.push(input.url);
					}
					jobStore.updateJob(jobId, { activity: activityLine(toolName, input) });
				},
			});
			if (!brief.trim()) throw new Error("the researcher produced no text");
			const research: ResearchResult = { brief: brief.trim(), sources: parseSources(brief.trim(), fetchedUrls) };
			await finishJob(jobId, research);
		} catch (err) {
			// Real-kill abort (2026-09): the abort path flipped the record and
			// queued the abort steer — unwind silently, keep the usage
			// folded so far (flushed by runJob's finally).
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { brief: `Research failed: ${reason}`, sources: [] });
		} finally {
			await fs.rm(pdfDir, { recursive: true, force: true });
		}
	}

	// ─── demo + visual ──────────────────────────────────────────────────────

	async function runDemoJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as DemoToolInput | undefined;
		const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Interactive demo";
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			jobStore.updateJob(jobId, { activity: "building demo" });
			const result = await runDemoBuilder(
				{ title, brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					chatId: loop.chatId,
					resume: job.checkpoint ? { draft: job.checkpoint.draft, verified: job.checkpoint.verified } : undefined,
					onCheckpoint: (draft, verified) => saveCheckpoint(jobId, draft, verified),
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				},
			);
			if (isDemoFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.notes ?? "demo build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { title, html: "", tested: true, notes: `FAILED: ${reason}` });
		}
	}

	async function runVisualJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as VisualToolInput | undefined;
		const brief = typeof input?.brief === "string" ? input.brief : "";
		const imagePath = typeof input?.image === "string" ? input.image : undefined;

		try {
			// Annotation (issue #363): the learner image is read once, here,
			// and rides into the maker bounded for storage.
			let image: LearnerImage | undefined;
			if (imagePath !== undefined) {
				jobStore.updateJob(jobId, { activity: "loading image" });
				image = await loadLearnerImage(imagePath, loop.abortSignal);
			}
			jobStore.updateJob(jobId, { activity: image ? "annotating image" : "drawing figure" });
			const result = await runVisualMaker(
				{ brief, image },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					chatId: loop.chatId,
					resume: job.checkpoint ? { draft: job.checkpoint.draft, verified: job.checkpoint.verified } : undefined,
					onCheckpoint: (draft, verified) => saveCheckpoint(jobId, draft, verified),
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				},
			);
			if (image && result.svg && stillRunning(jobId)) chatStore.saveImageSnapshot(job.chatId, image.snapshotId, image);
			if (isVisualFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.notes ?? "visual build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { svg: "", notes: `FAILED: ${reason}` });
		}
	}

	// ─── pdf reading (sources v0) ────────────────────────────────────────────

	async function runPdfJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as PdfToolInput | undefined;
		const path = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : "";
		const question = typeof input?.question === "string" ? input.question : "";

		try {
			jobStore.updateJob(jobId, { activity: "reading pdf" });
			const result = await runPdfReaderAgent(
				{ path, question },
			{
				engine: model,
				abortSignal: loop.abortSignal,
				chatId: loop.chatId,
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
			},
			);
			if (isPdfFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.brief.replace(/^PDF failed:\s*/i, "") });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { path, question, brief: `PDF failed: ${reason}`, pagesRead: [], pagesConsulted: [] });
		}
	}

	return { runJob };
}

// ─── module-level pure helpers ──────────────────────────────────────────────

/** Failure shape (W6 brief): html === "" with "FAILED: …" notes. */
function isDemoFailure(result: DemoResult): boolean {
	return typeof result.html !== "string" || result.html.length === 0;
}

function isVisualFailure(result: VisualResult): boolean {
	return typeof result.svg !== "string" || result.svg.length === 0;
}

/** The pdf-reader's failure brief (mirrors the research failure shape). */
function isPdfFailure(result: PdfResult): boolean {
	return /^PDF failed:/i.test(result.brief);
}

/** The activity line shown in the UI: `web_search: "query"` / `web_fetch: host`. */
function activityLine(toolName: string, input: { query?: string; url?: string } | undefined): string {
	if (toolName === "web_search") return `web_search: "${input?.query ?? ""}"`;
	if (toolName === "web_fetch") return `web_fetch: ${hostOf(input?.url)}`;
	return toolName;
}

function hostOf(url: string | undefined): string {
	if (!url) return "(no url)";
	try {
		return new URL(url).hostname;
	} catch {
		return url.slice(0, 40);
	}
}

/** Sources for the result: markdown links cited in the brief, else fetched
 * URLs. Fetched URLs are recorded before the fetch tool validates their scheme;
 * only http(s) sources may become links, including in previously saved jobs. */
export function parseSources(brief: string, fetchedUrls: string[]): ResearchResult["sources"] {
	const sources: ResearchResult["sources"] = [];
	const seen = new Set<string>();
	for (const match of brief.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
		const title = (match[1] ?? "").trim();
		const url = match[2]!;
		if (!title || seen.has(url)) continue;
		seen.add(url);
		sources.push({ title, url });
	}
	if (sources.length === 0) {
		for (const url of fetchedUrls) {
			if (seen.has(url) || !isWebSourceUrl(url)) continue;
			seen.add(url);
			sources.push({ title: hostOf(url), url });
		}
	}
	return sources.slice(0, 10);
}
