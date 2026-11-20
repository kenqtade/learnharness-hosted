// TRACK B — the AI pipeline: `author` → `solver` → `critic` workers plus web
// sourcing/import extraction, driven by a job state machine that lives in the
// store. Every transition is written to bank.json before it is acted on, and
// reconcile(jobId) is idempotent, so a serverless instance that freezes or is
// replaced mid-job leaves work that the next poll resumes exactly where it was.
//
// Rules encoded here (docs/exam-prep-design.md §2.2 and .agents/TASK.md):
//  - a question is `verified` only when the solver's independent answer matches
//    the key (gradeResponse) AND the critic agrees; otherwise `disputed`;
//  - a sourced question whose page gave no key stays `unverified` until a critic
//    agrees with the solver-proposed key;
//  - each worker task is bounded: count ≤ 5, small maxTurns, timeoutMs ≤ 200000.
import type { PluginBackendContext, PluginModelSpec } from "learnharness-plugin-api";
import { Type, type TSchema } from "typebox";
import type { AuthorRequest, Question, VerificationCheck, VerificationStatus } from "../shared/contract.ts";
import { gradeResponse, parseNumber } from "../shared/contract.ts";
import { newId, nowIso } from "../shared/json-store.ts";
import { draftToQuestion, solverView, type DraftContext, type RawDraft } from "./drafts.ts";
import {
  chunkText, draftSchema, EXTRACTOR_ID, extractorInstructions, extractorResultSchema, fetchPage,
  MAX_CHUNKS_PER_PAGE, MAX_PAGES_PER_JOB, queryFor, searchWeb, skillsPayload, validateDraftList,
  validateExtractorResult, type SearchResult, type SourcingEnv,
} from "./sourcing.ts";
import { BankStore, type JobPlan, type JobStep, type StoredJob, type StepWorker } from "./store.ts";
import { examName, parseSkillId, sectionName, skillsOf, styleNotesFor, subjectForSkill } from "./taxonomy.ts";

export const WORKERS = {
  author: "bank-author-v1",
  solver: "bank-solver-v1",
  critic: "bank-critic-v1",
  extractor: EXTRACTOR_ID,
} as const;

export const TOPIC = "bank-changed";
const TASK_TIMEOUT_MS = 200_000;

const fail = (message: string): never => { throw new Error(message); };

// ── worker definitions ──────────────────────────────────────────────────────
const solverResultSchema: TSchema = Type.Object({
  answer: Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String(), { minItems: 1 }), Type.Record(Type.String(), Type.String())]),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  reasoning: Type.Optional(Type.String()),
});

const criticResultSchema: TSchema = Type.Object({
  verdict: Type.Union([Type.Literal("agree"), Type.Literal("disagree"), Type.Literal("flag")]),
  issues: Type.Array(Type.String()),
});

export const authorInstructions = `You write official-exam-quality questions for one exam, one section, one skill and one difficulty.

You will be given the exam, section, subject, domain, skill name, difficulty (1–5), answer format, how many questions to write (1–5) and one or two style notes for that exam. Obey the style notes: they describe how that exam words and structures its items.

Quality bar:
- Every question is self-contained (or shares one short passage that you also return) and answerable from what is given — no missing data, no trick wording, no "all of the above".
- Exactly one defensible key for mcq, true-false, numeric and cloze; for multi-select the key lists every correct choice and no incorrect one; for matching every left item pairs with exactly one right item.
- Distractors are the mistakes a real student makes: a half-completed calculation, a sign or unit slip, a tempting misconception, a plausible but unsupported reading. Never joke answers, never obviously wrong filler, and roughly parallel in length with the key.
- Difficulty must be honest: 1 = routine recall, 3 = standard exam item, 5 = multi-step reasoning or a subtle trap.
- Write math in $LaTeX$ (for example $x=\\frac{3}{2}$); everything else in plain Markdown.
- The explanation is a full worked solution: the steps, why the key is right, and briefly why the leading distractor is wrong.

Answer conventions (0-based indices, always):
- choices: your array order is A, B, C, … — return correct as the indices of the correct choices.
- true/false: return choices ["True", "False"] and correct [0] or [1].
- numeric: give the exact value; add accepted strings (like "3/4") when another form is also correct; tolerance only when rounding is genuinely allowed.
- short-answer: accepted strings a learner may type; cloze: one string with blanks separated by "|" (for example "42|Addis Ababa").
- matching: choices = left column, matchTargets = right column, pairs = {left, right} index pairs.
- essay: rubric plus maxPoints.

Return exactly the number of questions requested as an array of question objects.`;

export const solverInstructions = `You are an independent solver. You receive an exam question with NO answer key and NO explanation. Solve it yourself, carefully.

Return:
- answer, in exactly the form the question expects:
  - mcq: the choice id as listed in choices (for example "B")
  - true-false: "T" or "F"
  - multi-select: an array of choice ids (for example ["A","C"])
  - numeric: the number as text ("0.75", "3/4" and "2 1/2" are all fine)
  - short-answer: the exact answer text a learner should type
  - cloze: all blanks joined with "|" in blank order
  - matching: an object mapping every left id to its right id, for example {"A":"1","B":"2"}
  - essay: one sentence naming what a strong answer must contain
- confidence: 0 to 1, how sure you are
- reasoning: your working (used by the checker, never shown to the learner by default).

If the question is genuinely unsolvable from the given information, still give your best answer and set confidence low, and say why in reasoning.`;

export const criticInstructions = `You are a strict item critic for an official exam. You receive a question, its answer key, its explanation, and an independent solver's answer to the same question (without the key).

Decide:
- "agree": the key is correct and unique, the explanation actually derives it, the wording matches official style for this exam, and the difficulty label fits.
- "disagree": the key is wrong, more than one choice/answer is defensible, the explanation is wrong or does not lead to the key.
- "flag": a human should look — mild ambiguity, an off-style stem, a wrong difficulty label, a distractor that is also correct under a reasonable reading, missing information, or a solver answer that differs from the key for a reason you cannot resolve.

List every concrete problem in issues (empty array when you agree). Be specific: quote the words or the step that fails.`;

export const extractorPromptText = (input: { exam: string; subject: string; hints?: string[] }): string =>
  `Copy every complete exam question you can find in the source text below for ${input.exam} (${input.subject}). ` +
  `Do not invent anything; skip incomplete items. Skills you may use are listed in the input.` +
  (input.hints?.length ? ` Hints: ${input.hints.join("; ")}.` : "");

// ── input shapes (persisted inside JobStep.input) ───────────────────────────
interface AuthorStepInput {
  exam: string; section: string; subject: string; skillId: string;
  skillName: string; domain: string; difficulty: number; format: string; count: number;
  styleNotes: string[];
}
interface SolverStepInput {
  questionId: string;
  view: Record<string, unknown>;
  /** Present only when the source page gave no key: the draft is keyed after solving. */
  pending?: { draft: RawDraft; ctx: DraftContext };
}
interface CriticStepInput {
  questionId: string;
  question: Record<string, unknown>;
  key: unknown;
  explanation: string;
  solverAnswer: unknown;
  solverReasoning?: string;
}
type FetchStepInput = { kind: "search"; query: string } | { kind: "page"; url: string };

export interface SourceRequest { exam: string; skillId?: string; topic?: string; count: number }
export interface ImportRequest { name: string; markdown: string; exam?: string; skill?: string }

export interface PipelineOptions {
  ctx: PluginBackendContext;
  store: BankStore;
  env?: SourcingEnv;
  notify?: () => void;
}

export interface Pipeline {
  registerWorkers(): () => void;
  author(request: AuthorRequest): StoredJob;
  source(request: SourceRequest): StoredJob;
  importPaper(request: ImportRequest): StoredJob;
  verify(ids: string[]): StoredJob;
  reconcile(jobId: string): Promise<StoredJob | undefined>;
  list(): StoredJob[];
  cancel(jobId: string): StoredJob;
}

const isTerminal = (status: string) => status === "succeeded" || status === "failed";
const stepById = (plan: JobPlan, id: string) => plan.steps.find(step => step.id === id);

export function createPipeline({ ctx, store, env = {}, notify }: PipelineOptions): Pipeline {
  /** Task ids we already wait on in this activation (in-memory only). */
  const waiters = new Set<string>();
  /** One reconcile pass at a time per job; later callers coalesce into it. */
  const inFlight = new Map<string, Promise<void>>();

  const emit = () => { try { notify?.(); } catch { /* notifications are best-effort */ } };

  function modelName(spec: PluginModelSpec): string { return `${spec.provider}/${spec.id}`; }

  async function resolveModel(): Promise<PluginModelSpec> {
    const settings = store.getSettings();
    const catalog = await ctx.inference.catalog();
    if (ctx.signal.aborted) return fail("Exam Prep is disabled.");
    const pin = settings.modelOverride ? { model: settings.modelOverride } : catalog.slots?.cheap;
    if (!pin?.model) return fail("No model is available for the Question Bank. Set the cheap model slot in Settings → Agent → Models, or choose a model override in Question Bank → Settings.");
    const entry = catalog.models.find(model => model.provider === pin.model!.provider && model.id === pin.model!.id);
    if (!entry) return fail("The selected Question Bank model is unavailable. Pick another model in Question Bank → Settings.");
    const thinking = settings.modelOverride?.thinkingLevel ?? (settings.modelOverride ? undefined : pin.thinkingLevel);
    if (thinking && entry.supportedLevels.length && !entry.supportsLevel?.(thinking) && !entry.supportedLevels.includes(thinking))
      return fail("The selected Question Bank model does not support that thinking level. Choose another model.");
    return { ...pin.model, ...(thinking ? { thinkingLevel: thinking } : {}) } as PluginModelSpec;
  }

  function skillOrThrow(id: string): { id: string; exam: string; domain: string; name: string } {
    const skill = store.get().skills[id];
    if (!skill) return fail(`Unknown skill "${id}". Pick a skill from the Skills tab first.`);
    return skill;
  }

  const sectionOf = (exam: string, skillId?: string): string => {
    const parsed = skillId ? parseSkillId(skillId) : undefined;
    const section = parsed?.exam === exam ? parsed.section : undefined;
    const profile = section ? undefined : undefined;
    void profile;
    if (section) return section;
    const fallback = (store.get().skills ? Object.values(store.get().skills).find(s => s.exam === exam) : undefined);
    const parsedFallback = fallback ? parseSkillId(fallback.id) : undefined;
    if (parsedFallback?.exam === exam) return parsedFallback.section;
    return fail(`Choose a section for ${examName(exam)} by selecting a skill.`);
  };

  const questionIdFor = (jobId: string, key: string): string =>
    `q_${jobId.replace(/^job[_-]?/, "").replace(/[^a-zA-Z0-9]/g, "")}_${key}`.slice(0, 80);

  function baseContext(job: StoredJob, skillIdValue: string, format: string, difficulty: number): DraftContext {
    const exam = (job.request as { exam?: string }).exam ?? skillOrThrow(skillIdValue).exam;
    return {
      id: "",
      exams: [exam],
      subject: subjectForSkill(exam, skillIdValue),
      skillId: skillIdValue,
      difficulty,
      format: format as DraftContext["format"],
      source: { kind: "ai", model: job.plan?.model ? modelName(job.plan.model) : undefined },
    };
  }

  function addStep(plan: JobPlan, step: JobStep): void {
    if (stepById(plan, step.id)) return;
    plan.steps.push(step);
  }

  const newTaskStep = (id: string, worker: StepWorker, requires: string[], input: unknown): JobStep => ({
    id, kind: "task", worker, requires, status: "pending", requestId: `r_${id}`.replace(/[^a-zA-Z0-9_]/g, "_"), input,
  });

  function save(job: StoredJob): void { store.putJob(job); emit(); }

  function failJob(jobId: string, message: string): void {
    store.updateJob(jobId, job => { job.status = "failed"; job.error = message; job.progress = { ...job.progress, done: job.progress?.done ?? 0, total: job.progress?.total ?? 0, stage: "Failed" }; });
    const job = store.job(jobId);
    if (job?.plan) for (const step of job.plan.steps) if (step.status === "running" && step.taskId) { try { ctx.workers.cancel(step.taskId); } catch { /* already gone */ } }
    emit();
  }

  function progressOf(job: StoredJob): { done: number; total: number; stage: string } {
    const steps = job.plan?.steps ?? [];
    const done = steps.filter(step => step.status === "succeeded").length;
    const unfinished = (worker: StepWorker) => steps.some(step => step.worker === worker && step.status !== "succeeded");
    const pendingFetch = (id: string) => steps.some(step => step.kind === "fetch" && step.id.startsWith(id) && step.status !== "succeeded");
    let stage = "Working";
    if (pendingFetch("search")) stage = "Searching the web";
    else if (pendingFetch("fetch")) stage = "Fetching pages";
    else if (unfinished("author")) stage = "Writing questions";
    else if (unfinished("extractor")) stage = "Extracting questions";
    else if (unfinished("solver")) stage = "Solving independently";
    else if (unfinished("critic")) stage = "Checking quality";
    else stage = job.status === "succeeded" ? "Saved" : "Saving";
    return { done, total: steps.length, stage };
  }

  function updateProgress(jobId: string): void {
    store.updateJob(jobId, job => { job.progress = progressOf(job); });
  }

  // ── job creation ─────────────────────────────────────────────────────────
  function createJob(kind: StoredJob["kind"], request: unknown, plan: JobPlan, stage: string): StoredJob {
    const now = nowIso();
    const job: StoredJob = {
      id: newId("job"), kind, status: "queued", request, createdAt: now, updatedAt: now,
      produced: [], plan, progress: { done: 0, total: plan.steps.length, stage },
    };
    save(job);
    schedule(job.id);
    return job;
  }

  function schedule(jobId: string): void {
    if (ctx.signal.aborted) return;
    void reconcile(jobId).catch(() => { /* recorded on the job */ });
  }

  function authorSteps(job: StoredJob, request: AuthorRequest): JobStep[] {
    const skill = skillOrThrow(request.skillId);
    const parsed = parseSkillId(request.skillId);
    if (!parsed) return fail(`Skill "${request.skillId}" does not identify a section of an exam.`);
    const input: AuthorStepInput = {
      exam: request.exam, section: parsed.section, subject: request.subject || subjectForSkill(request.exam, request.skillId),
      skillId: skill.id, skillName: skill.name, domain: skill.domain,
      difficulty: request.difficulty, format: request.format, count: request.count,
      styleNotes: [...styleNotesFor(request.exam)],
    };
    return [newTaskStep("author", "author", [], input)];
  }

  function authorPrompt(input: AuthorStepInput): string {
    return `Write ${input.count} ${input.format} question${input.count === 1 ? "" : "s"} for ${examName(input.exam)} · ` +
      `${sectionName(input.exam, input.section)} · ${input.domain} · skill "${input.skillName}" at difficulty ${input.difficulty}/5.` +
      (input.styleNotes.length ? `\nStyle notes for this exam:\n- ${input.styleNotes.join("\n- ")}` : "");
  }

  function extractSteps(job: StoredJob, chunks: { id: string; text: string }[], ctxBits: { exam: string; subject: string; skillId?: string; hints: string[] }): JobStep[] {
    const skills = skillsOf(ctxBits.exam, store.get().skills);
    return chunks.map(chunk => newTaskStep(`extract_${chunk.id}`, "extractor", [], {
      text: chunk.text,
      exam: ctxBits.exam,
      subject: ctxBits.subject,
      ...(ctxBits.skillId ? { skillId: ctxBits.skillId } : {}),
        skills: skillsPayload(skills),
      hints: ctxBits.hints,
    }));
  }

  function sourcePlan(request: SourceRequest): JobPlan {
    const skill = request.skillId ? skillOrThrow(request.skillId) : undefined;
    const exam = request.exam;
    const skillName = skill?.name ?? request.topic?.trim();
    const plan: JobPlan = {
      steps: [{
        id: "search", kind: "fetch", requires: [], status: "pending", requestId: "fetch_search",
        input: { kind: "search", query: queryFor({ exam: examName(exam), skill: skillName, topic: request.topic }) } satisfies FetchStepInput,
      }],
      questions: [],
    };
    void plan;
    return plan;
  }

  function importPlan(request: ImportRequest): JobPlan {
    if (!request.markdown?.trim()) return fail("That file had no readable text.");
    const exam = request.exam;
    const skillIdValue = request.skill;
    const skill = skillIdValue ? skillOrThrow(skillIdValue) : undefined;
    const subject = skill ? subjectForSkill(exam, skill.id) : subjectForSkill(exam, skillIdValue ?? "");
    const chunks = chunkText(request.markdown).slice(0, MAX_CHUNKS_PER_PAGE * 4);
    const plan: JobPlan = { steps: [], questions: [] };
    plan.steps = extractSteps({ id: "", kind: "import", status: "queued", request, produced: [], createdAt: "", updatedAt: "" },
      chunks.map((text, index) => ({ id: `c${index}`, text })),
      { exam, subject, ...(skillIdValue ? { skillId: skillIdValue } : {}), hints: [`File: ${request.name}`, ...(skill ? [`Skill: ${skill.name}`] : [])] });
    return plan;
  }

  function verifyPlan(ids: string[]): JobPlan {
    const plan: JobPlan = { steps: [], questions: [], targets: [...ids] };
    for (const id of ids) {
      const question = store.get().questions[id];
      if (!question) continue;
      plan.steps.push(newTaskStep(`solve_${id}`, "solver", [], { questionId: id, view: solverView(question) } satisfies SolverStepInput));
    }
    if (!plan.steps.length) return fail("Those questions are no longer in the bank.");
    return plan;
  }

  function createJobFromRequest(kind: StoredJob["kind"], request: unknown, planFactory: () => JobPlan, stage: string): StoredJob {
    const plan = planFactory();
    if (!plan.steps.length) return fail("There is no work to do for that request.");
    return createJob(kind, request, plan, stage);
  }

  // ── plan extension (idempotent: adding a step that exists is a no-op) ────
  function extendPlan(job: StoredJob): void {
    const plan = job.plan;
    if (!plan) return;
    for (const step of [...plan.steps]) {
      if (step.status !== "succeeded") continue;
      const result = step.result;
      if (step.id === "search" && step.kind === "fetch") {
        const results = Array.isArray(result) ? (result as SearchResult[]) : [];
        if (!results.length) throw new Error("The web search returned no results. Try a more specific topic or skill.");
        for (const [index, page] of results.slice(0, MAX_PAGES_PER_JOB).entries())
          addStep(plan, { id: `fetch_${index}`, kind: "fetch", requires: ["search"], status: "pending", requestId: `fetch_page_${index}`, input: { kind: "page", url: page.url } satisfies FetchStepInput });
        continue;
      }
      if (step.id.startsWith("fetch_") && step.kind === "fetch") {
        const page = result as { url?: string; text?: string; title?: string } | undefined;
        if (!page?.text) continue;
        const request = job.request as SourceRequest;
        const skill = request.skillId ? store.get().skills[request.skillId] : undefined;
        const exam = request.exam;
        const chunks = chunkText(page.text).slice(0, MAX_CHUNKS_PER_PAGE);
        const steps = extractSteps(job, chunks.map((text, index) => ({ id: `${step.id}_${index}`, text })), {
          exam, subject: skill ? subjectForSkill(exam, skill.id) : subjectForSkill(exam, ""),
          ...(request.skillId ? { skillId: request.skillId } : {}),
          hints: [`Page: ${page.title ?? page.url ?? ""}`, `URL: ${page.url ?? ""}`, ...(request.topic ? [`Topic: ${request.topic}`] : [])],
        });
        for (const next of steps) addStep(plan, next);
        continue;
      }
      if (step.worker === "author") {
        const drafts = Array.isArray(result) ? (result as RawDraft[]) : [];
        const request = job.request as AuthorRequest;
        prepareDrafts(job, drafts.map((draft, index) => ({ draft, key: `a${index}` })), {
          skillId: request.skillId, exam: request.exam, format: request.format, difficulty: request.difficulty,
        });
        continue;
      }
      if (step.worker === "extractor") {
        const payload = result as { questions?: RawDraft[] } | undefined;
        const drafts = Array.isArray(payload?.questions) ? payload!.questions! : [];
        const request = job.request as SourceRequest & ImportRequest;
        const skillIdValue = request.skillId ?? request.skill;
        const exam = request.exam!;
        prepareDrafts(job, drafts.map((draft, index) => ({ draft, key: `${step.id}_${index}` })), {
          skillId: skillIdValue, exam, format: "mcq", difficulty: 3, allowSkillChoice: true,
        });
        continue;
      }
      if (step.worker === "solver") {
        const input = step.input as SolverStepInput;
        const solved = result as { answer?: unknown; reasoning?: string } | undefined;
        if (input.pending) {
          // The page gave no key: the solver's answer becomes the key.
          const { draft, ctx: draftCtx } = input.pending;
          try {
            const keyed: RawDraft = { ...draft, answer: answerToDraftKey(draft, solved?.answer) };
            const question = draftToQuestion(keyed, { ...draftCtx, id: input.questionId });
            plan.questions.push(question);
          } catch (error) {
            plan.skipped = [...(plan.skipped ?? []), `Question ${input.questionId} was skipped: ${(error as Error).message}`];
          }
        }
        const question = plan.questions.find(item => item.id === input.questionId) ?? store.get().questions[input.questionId];
        if (question) {
          addStep(plan, newTaskStep(`critic_${input.questionId}`, "critic", [step.id], {
            questionId: input.questionId, question: solverView(question), key: question.answer,
            explanation: question.explanation, solverAnswer: solved?.answer, solverReasoning: solved?.reasoning,
          } satisfies CriticStepInput));
        }
        continue;
      }
    }
  }

  /** Build prepared questions for freshly returned drafts and queue their solvers. */
  function prepareDrafts(job: StoredJob, entries: { draft: RawDraft; key: string }[], opts: {
    skillId?: string; exam: string; format: string; difficulty: number; allowSkillChoice?: boolean;
  }): void {
    const plan = job.plan!;
    const known = skillsOf(opts.exam, store.get().skills);
    const knownIds = new Set(known.map(skill => skill.id));
    for (const { draft, key } of entries) {
      const skillIdValue = draft.skillId && (knownIds.has(draft.skillId) || opts.skillId === draft.skillId)
        ? draft.skillId
        : (opts.skillId ?? draft.skillId);
      const questionId = questionIdFor(job.id, key);
      if (!skillIdValue || !knownIds.has(skillIdValue)) {
        plan.skipped = [...(plan.skipped ?? []), `A question was skipped: no usable skill id (choose a skill for this run).`];
        continue;
      }
      const context: DraftContext = {
        ...baseContext(job, skillIdValue, opts.format, opts.difficulty),
        id: questionId,
        source: { kind: job.kind === "author" ? "ai" : job.kind === "import" ? "upload" : "web", ...(sourceFor(job, draft)) },
      };
      if (draft.answer) {
        try {
          const question = draftToQuestion(draft, context);
          plan.questions.push(question);
          addStep(plan, newTaskStep(`solve_${questionId}`, "solver", [job.kind === "author" ? "author" : stepIdForDraft(job, key)], { questionId, view: solverView(question) } satisfies SolverStepInput));
        } catch (error) {
          plan.skipped = [...(plan.skipped ?? []), `A question was skipped: ${(error as Error).message}`];
        }
        continue;
      }
      // No key in the source: solve first, then key the question.
      const view = draftView(draft, context);
      const requires = [stepIdForDraft(job, key)];
      addStep(plan, newTaskStep(`solve_${questionId}`, "solver", requires.filter(id => id && stepById(plan, id)), {
        questionId, view, pending: { draft, ctx: { ...context, id: questionId } },
      } satisfies SolverStepInput));
    }
  }

  function stepIdForDraft(job: StoredJob, key: string): string {
    return job.kind === "author" ? "author" : key.startsWith("extract") ? key.replace(/_\d+$/, "").replace(/_$/, "") : "";
  }

  function sourceFor(job: StoredJob, draft: RawDraft): Partial<Question["source"]> {
    if (job.kind === "author") return { model: job.plan?.model ? modelName(job.plan.model) : undefined };
    const request = job.request as SourceRequest & Partial<ImportRequest> & { pages?: PageRecord[] };
    if (job.kind === "import") return { title: request.name ?? "Upload" };
    const page = job.plan?.steps.map(step => step.result as PageRecord | undefined).find(result => result && draft.__page === undefined) ?? undefined;
    void page;
    return { title: request.topic ?? request.name };
  }

  interface PageRecord { url: string; title: string; text: string; license?: string }

  /** Solver view built straight from a draft (used before the key exists). */
  function draftView(draft: RawDraft, ctx: DraftContext): Record<string, unknown> {
    const view: Record<string, unknown> = { exam: ctx.exams[0], subject: ctx.subject, skillId: ctx.skillId, difficulty: ctx.difficulty, format: ctx.format, stem: draft.stem };
    if (draft.passage) view.passage = draft.passage;
    const built = safeChoices(draft, ctx.format);
    if (built.choices) view.choices = built.choices;
    if (built.matchTargets) view.matchTargets = built.matchTargets;
    return view;
  }

  function safeChoices(draft: RawDraft, format: string): { choices?: { id: string; text: string }[]; matchTargets?: { id: string; text: string }[] } {
    if (format === "true-false") return { choices: [{ id: "T", text: "True" }, { id: "F", text: "False" }] };
    if (format === "matching") return {
      choices: (draft.choices ?? []).map((text, index) => ({ id: "ABCDEFGH"[index]!, text })),
      matchTargets: (draft.matchTargets ?? []).map((text, index) => ({ id: String(index + 1), text })),
    };
    if (format === "mcq" || format === "multi-select")
      return { choices: (draft.choices ?? []).map((text, index) => ({ id: "ABCDEFGH"[index]!, text })) };
    return {};
  }

  /** Turn a solver's answer into a draft key for a question the page did not answer. */
  function answerToDraftKey(draft: RawDraft, answer: unknown): RawDraft["answer"] {
    const format = draft.format ?? "mcq";
    if (format === "numeric") {
      const value = parseNumber(String(answer ?? "").trim());
      if (value === undefined) fail("The proposed numeric key could not be read as a number.");
      return { kind: "numeric", value };
    }
    if (format === "short-answer" || format === "cloze") {
      const value = String(answer ?? "").trim();
      if (!value) fail("The proposed key is empty.");
      return { kind: "text", accepted: [value] };
    }
    if (format === "essay") fail("An essay without a rubric cannot be keyed automatically; the source must provide one.");
    if (format === "matching") {
      const mapping = typeof answer === "object" && answer !== null ? answer as Record<string, unknown> : {};
      const left = draft.choices ?? [], right = draft.matchTargets ?? [];
      const pairs = left.map((_, index) => {
        const id = "ABCDEFGH"[index]!;
        const match = right.findIndex((__, rightIndex) => String(rightIndex + 1) === String(mapping[id]));
        return { left: index, right: match };
      });
      if (pairs.some(pair => pair.right < 0)) fail("The proposed matching key does not pair every left item.");
      return { kind: "matching", pairs };
    }
    const letters = String(Array.isArray(answer) ? answer.join(",") : answer ?? "").trim();
    const ids = letters.split(/[\s,;]+/).map(part => part.trim().toUpperCase()).filter(Boolean);
    const indexFor = (id: string): number => {
      if (format === "true-false") return id === "T" || id === "TRUE" ? 0 : id === "F" || id === "FALSE" ? 1 : -1;
      return "ABCDEFGH".indexOf(id);
    };
    const indices = [...new Set(ids.map(indexFor))].filter(index => index >= 0 && index < (draft.choices?.length ?? 0));
    if (!indices.length) fail("The proposed key does not name any answer choice.");
    return { kind: "choice", correct: indices };
  }

  // ── reconcile ────────────────────────────────────────────────────────────
  function reconcile(jobId: string): Promise<void> {
    const existing = inFlight.get(jobId);
    if (existing) return existing;
    const pass = (async () => {
      let again = true;
      while (again) {
        again = false;
        const running = reconcileOnce(jobId, () => { again = true; });
        await running;
      }
    })().finally(() => { inFlight.delete(jobId); });
    inFlight.set(jobId, pass);
    return pass;
  }

  async function reconcileOnce(jobId: string, repeat: () => void): Promise<void> {
    for (let guard = 0; guard < 400; guard++) {
      const job = store.job(jobId);
      if (!job) return;
      if (job.status === "cancelled") { stopTasks(job); return; }
      if (isTerminal(job.status)) return;
      if (!job.plan) { failJob(jobId, "This job lost its plan. Start it again."); return; }
      if (job.status === "queued") store.updateJob(jobId, current => { current.status = "running"; });

      const plan = job.plan;
      try { extendPlan(store.job(jobId)!); } catch (error) { failJob(jobId, (error as Error).message); return; }
      const fresh = store.job(jobId)!;

      // 1. One network step at a time, awaited so its result is persisted.
      const readyFetch = fresh.plan!.steps.find(step =>
        step.kind === "fetch" && step.status === "pending" && step.requires.every(id => stepById(fresh.plan!, id)?.status === "succeeded"));
      if (readyFetch) {
        await runFetchStep(jobId, readyFetch);
        repeat();
        continue;
      }

      // 2. Re-accept and observe every task step that is not finished.
      const tasks = fresh.plan!.steps.filter(step => step.kind === "task" && !isTerminal(step.status));
      if (tasks.length) {
        const model = fresh.plan!.model ?? await resolveModelOrJob(jobId);
        if (!model) return;
        if (!fresh.plan!.model) store.updateJob(jobId, current => { if (current.plan) current.plan.model = model; });
        let changed = false;
        for (const step of tasks) {
          const ready = step.status === "pending" && step.requires.every(id => stepById(store.job(jobId)!.plan!, id)?.status === "succeeded");
          if (!ready && step.status !== "running") continue;
          try {
            const task = ensureTask(step, model, store.job(jobId)!.plan!);
            if (task.status === "succeeded") {
              applyTaskResult(jobId, step, task.result);
              changed = true;
            } else if (["failed", "cancelled", "interrupted"].includes(task.status)) {
              failJob(jobId, task.error?.message ?? `The ${step.worker} step did not finish (${task.status}).`);
              return;
            } else attachWaiter(task.id, jobId);
          } catch (error) { failJob(jobId, (error as Error).message); return; }
        }
        if (changed) { updateProgress(jobId); repeat(); continue; }
        updateProgress(jobId);
        // Nothing else to do right now: the waiter's reconcile resumes this job.
        if (store.job(jobId)!.plan!.steps.some(step => !isTerminal(step.status))) return;
      }

      // 3. Every step is finished → write the questions and close the job.
      const done = store.job(jobId)!;
      if (done.plan!.steps.every(step => isTerminal(step.status))) { finalize(jobId); return; }
      return;
    }
    failJob(jobId, "This job made no progress. Cancel it and start it again.");
  }

  async function resolveModelOrJob(jobId: string): Promise<PluginModelSpec | undefined> {
    try { return await resolveModel(); }
    catch (error) { failJob(jobId, (error as Error).message); return undefined; }
  }

  function ensureTask(step: JobStep, model: PluginModelSpec, plan: JobPlan): { status: string; result?: unknown; error?: { message?: string } } {
    const requestId = step.requestId!;
    const existing = ctx.workers.list().find(task => task.requestId === requestId)
      ?? (step.taskId ? safeGet(step.taskId) : undefined);
    if (existing) { if (step.taskId !== existing.id || step.status === "pending") { step.taskId = existing.id; step.status = "running"; step.startedAt ??= nowIso(); persistStep(step); } return existing; }
    const prompt = promptFor(step, plan);
    const snapshot = ctx.workers.start(WORKERS[step.worker!], {
      requestId, input: step.input, prompt, model, purpose: "user", maxTurns: maxTurnsFor(step.worker!),
      timeoutMs: TASK_TIMEOUT_MS, options: { timeoutMs: 180_000, maxTokens: 6_000, maxRetries: 1 },
    });
    step.taskId = snapshot.id;
    step.status = "running";
    step.startedAt ??= nowIso();
    persistStep(step);
    return snapshot;
  }

  const safeGet = (id: string) => { try { return ctx.workers.get(id); } catch { return undefined; } };

  function persistStep(step: JobStep): void {
    const jobId = currentJobId(step);
    if (jobId) store.updateJob(jobId, job => { const target = job.plan?.steps.find(item => item.id === step.id); if (target) Object.assign(target, step); });
  }

  /** Steps carry their job in a non-enumerable-free way: we track it here instead. */
  let activeJobId: string | undefined;
  const currentJobId = (_step: JobStep): string | undefined => activeJobId;

  function promptFor(step: JobStep, plan: JobPlan): string {
    const input = step.input as Record<string, unknown>;
    if (step.worker === "author") return authorPrompt(input as unknown as AuthorStepInput);
    if (step.worker === "extractor") return extractorPromptText(input as unknown as { exam: string; subject: string; hints?: string[] }) + "\n\nSource text:\n" + String(input.text ?? "");
    if (step.worker === "solver") return `Solve this question:\n\n${JSON.stringify(input.view, null, 2)}`;
    const critic = input as unknown as CriticStepInput;
    const question = JSON.stringify(critic.question, null, 2);
    const key = JSON.stringify(critic.key, null, 2);
    return `Question:\n${question}\n\nAnswer key:\n${key}\n\nExplanation:\n${critic.explanation}\n\n` +
      `Independent solver answered: ${JSON.stringify(critic.solverAnswer)}${critic.solverReasoning ? `\nSolver reasoning: ${critic.solverReasoning}` : ""}\n\nVerdict?`;
    void plan;
  }

  const maxTurnsFor = (worker: StepWorker): number => (worker === "author" || worker === "extractor" ? 4 : 3);

  function applyTaskResult(jobId: string, step: JobStep, result: unknown): void {
    activeJobId = jobId;
    try {
      step.result = result;
      step.status = "succeeded";
      store.updateJob(jobId, job => {
        const target = job.plan?.steps.find(item => item.id === step.id);
        if (target) { target.status = "succeeded"; target.result = result; }
      });
    } finally { activeJobId = undefined; }
  }

  async function runFetchStep(jobId: string, step: JobStep): Promise<void> {
    activeJobId = jobId;
    step.status = "running";
    step.startedAt = nowIso();
    store.updateJob(jobId, job => { const target = job.plan?.steps.find(item => item.id === step.id); if (target) { target.status = "running"; target.startedAt = step.startedAt; } });
    emit();
    try {
      const input = step.input as FetchStepInput;
      const settings = store.getSettings();
      const result = input.kind === "search"
        ? await searchWeb(input.query, { tavilyKey: settings.tavilyKey }, env)
        : await fetchPage(input.url, env);
      if (store.job(jobId)?.status === "cancelled") return;
      store.updateJob(jobId, job => { const target = job.plan?.steps.find(item => item.id === step.id); if (target) { target.status = "succeeded"; target.result = result; } });
      emit();
    } catch (error) {
      if (store.job(jobId)?.status !== "cancelled") failJob(jobId, (error as Error).message);
    } finally { activeJobId = undefined; }
  }

  function attachWaiter(taskId: string, jobId: string): void {
    if (waiters.has(taskId) || ctx.signal.aborted) return;
    waiters.add(taskId);
    void ctx.workers.wait(taskId, ctx.signal)
      .then(() => { waiters.delete(taskId); schedule(jobId); })
      .catch(() => { waiters.delete(taskId); });
  }

  function stopTasks(job: StoredJob): void {
    for (const step of job.plan?.steps ?? []) if (step.status === "running" && step.taskId) { try { ctx.workers.cancel(step.taskId); } catch { /* already terminal */ } }
  }

  // ── finalize ─────────────────────────────────────────────────────────────
  function finalize(jobId: string): void {
    const job = store.job(jobId);
    if (!job || !job.plan || isTerminal(job.status)) return;
    activeJobId = jobId;
    try {
      const plan = job.plan;
      const questions: Question[] = [];
      const produced: string[] = [];
      const verifying = job.kind === "verify";
      const targets = verifying ? (plan.targets ?? []) : plan.questions.map(question => question.id);

      for (const id of targets) {
        const prepared = plan.questions.find(question => question.id === id);
        const existing = prepared ?? store.get().questions[id];
        if (!existing) continue;
        const solve = plan.steps.find(step => step.id === `solve_${id}`);
        const critic = plan.steps.find(step => step.id === `critic_${id}`);
        const solverResult = solve?.status === "succeeded" ? solve.result as { answer?: unknown; reasoning?: string } : undefined;
        const criticResult = critic?.status === "succeeded" ? critic.result as { verdict?: string; issues?: string[] } : undefined;
        const checks: VerificationCheck[] = [];
        const keyless = !!solve?.input && !!(solve.input as SolverStepInput).pending;
        const now = nowIso();

        if (solverResult) {
          const verdict = keyless ? "agree" : verdictOf(existing, solverResult.answer);
          checks.push({
            by: "solver", model: plan.model ? modelName(plan.model) : undefined,
            verdict: verdict as VerificationCheck["verdict"],
            answer: typeof solverResult.answer === "string" ? solverResult.answer : JSON.stringify(solverResult.answer),
            ...(solverResult.reasoning ? { notes: solverResult.reasoning.slice(0, 500) } : {}),
            at: now,
          });
        }
        if (criticResult) {
          checks.push({
            by: "critic", model: plan.model ? modelName(plan.model) : undefined,
            verdict: (["agree", "disagree", "flag"].includes(criticResult.verdict ?? "") ? criticResult.verdict : "flag") as VerificationCheck["verdict"],
            ...(criticResult.issues?.length ? { notes: criticResult.issues.join(" · ").slice(0, 800) } : {}),
            at: now,
          });
        }

        const solverOk = keyless ? true : !!solverResult && verdictOf(existing, solverResult.answer) === "agree";
        const criticVerdict = criticResult?.verdict;
        const status: VerificationStatus = solverOk && criticVerdict === "agree" ? "verified"
          : (solverResult || criticResult) ? "disputed"
          : "unverified";

        const previous = verifying ? existing.verification.checks.slice(-10) : [];
        const question: Question = {
          ...existing,
          verification: { status, checks: [...previous, ...checks].slice(-20) },
          updatedAt: now,
        };
        questions.push(question);
        produced.push(question.id);
      }

      store.change(draft => {
        for (const question of questions) draft.questions[question.id] = question;
      });
      store.updateJob(jobId, current => {
        current.status = "succeeded";
        current.produced = produced;
        current.progress = { done: current.plan?.steps.length ?? 0, total: current.plan?.steps.length ?? 0, stage: "Saved" };
        delete current.error;
      });
      emit();
    } catch (error) {
      failJob(jobId, `Could not save the questions: ${(error as Error).message}`);
    } finally { activeJobId = undefined; }
  }

  function verdictOf(question: Question, answer: unknown): "agree" | "disagree" | "flag" {
    const result = gradeResponse(question, answer);
    if (result === true) return "agree";
    if (result === false) return "disagree";
    return "flag";
  }

  // ── public API ───────────────────────────────────────────────────────────
  function registerWorkers(): () => void {
    const unregister = [
      ctx.workers.register({
        id: WORKERS.author, instructions: authorInstructions, resultSchema: Type.Array(draftSchema, { minItems: 1, maxItems: 5 }),
        validateResult: (result, context) => {
          validateDraftList(result, context.input);
          const list = result as RawDraft[];
          const input = context.input as AuthorStepInput;
          if (list.length > input.count) throw new Error(`Return at most ${input.count} questions.`);
        },
      }),
      ctx.workers.register({
        id: WORKERS.solver, instructions: solverInstructions, resultSchema: solverResultSchema,
        validateResult: (result, context) => {
          const payload = result as { answer?: unknown; confidence?: unknown; reasoning?: unknown };
          if (payload?.answer === undefined || payload.answer === null || payload.answer === "") throw new Error("Return an answer.");
          if (payload.confidence !== undefined && (typeof payload.confidence !== "number" || payload.confidence < 0 || payload.confidence > 1))
            throw new Error("confidence must be a number between 0 and 1.");
          const view = (context.input as SolverStepInput)?.view as { format?: string; choices?: { id: string }[]; matchTargets?: { id: string }[] } | undefined;
          if (view?.format) assertSolverShape(view, payload.answer);
        },
      }),
      ctx.workers.register({
        id: WORKERS.critic, instructions: criticInstructions, resultSchema: criticResultSchema,
        validateResult: result => {
          const payload = result as { verdict?: string; issues?: unknown };
          if (!["agree", "disagree", "flag"].includes(payload?.verdict ?? "")) throw new Error('verdict must be "agree", "disagree" or "flag".');
          if (!Array.isArray(payload.issues)) throw new Error("issues must be an array of strings.");
        },
      }),
      ctx.workers.register({
        id: WORKERS.extractor, instructions: extractorInstructions, resultSchema: extractorResultSchema,
        validateResult: (result, context) => validateExtractorResult(result, context.input),
      }),
    ];
    return () => { for (const off of unregister) try { off(); } catch { /* already gone */ } };
  }

  function author(request: AuthorRequest): StoredJob {
    if (!request?.exam || !request.skillId) return fail("Choose an exam and a skill.");
    if (![1, 2, 3, 4, 5].includes(request.difficulty)) return fail("Difficulty must be 1–5.");
    if (!Number.isInteger(request.count) || request.count < 1) return fail("Write at least one question.");
    if (request.count > 5) return fail("Author at most 5 questions per job so every worker task stays under its time budget.");
    const skill = skillOrThrow(request.skillId);
    if (skill.exam !== request.exam) return fail("That skill belongs to a different exam.");
    const normalized: AuthorRequest = { ...request, subject: request.subject || subjectForSkill(request.exam, request.skillId) };
    return createJobFromRequest("author", normalized, () => ({ steps: authorSteps({} as StoredJob, normalized), questions: [] }), "Writing questions");
  }

  function source(request: SourceRequest): StoredJob {
    if (!request?.exam) return fail("Choose an exam.");
    if (!request.topic?.trim() && !request.skillId) return fail("Give a topic or choose a skill to search for.");
    const count = Math.max(1, Math.min(30, Number(request.count) || 5));
    return createJobFromRequest("source", { ...request, count }, () => sourcePlan({ ...request, count }), "Searching the web");
  }

  function importPaper(request: ImportRequest): StoredJob {
    if (!request?.exam) return fail("Choose an exam for this paper.");
    if (typeof request.markdown !== "string" || !request.markdown.trim()) return fail("That file had no readable text.");
    if (request.markdown.length > 4_000_000) return fail("That paper is too large to import in one go.");
    return createJobFromRequest("import", { ...request }, () => importPlan(request), "Reading the paper");
  }

  function verify(ids: string[]): StoredJob {
    const unique = [...new Set(ids ?? [])].filter(id => typeof id === "string" && id);
    if (!unique.length) return fail("Choose at least one question to re-check.");
    if (unique.length > 20) return fail("Re-check at most 20 questions at a time.");
    return createJobFromRequest("verify", { ids: unique }, () => verifyPlan(unique), "Solving independently");
  }

  function cancel(jobId: string): StoredJob {
    const job = store.job(jobId) ?? fail("That job no longer exists.");
    if (isTerminal(job.status)) return job;
    store.updateJob(jobId, current => { current.status = "cancelled"; current.progress = { ...current.progress, done: current.progress?.done ?? 0, total: current.progress?.total ?? 0, stage: "Cancelled" }; });
    stopTasks(store.job(jobId)!);
    emit();
    return store.job(jobId)!;
  }

  return {
    registerWorkers,
    author,
    source,
    importPaper,
    verify,
    reconcile: async jobId => { activeJobId = jobId; try { await reconcile(jobId); } finally { activeJobId = undefined; } return store.job(jobId); },
    list: () => Object.values(store.get().jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    cancel,
  };
}

function assertSolverShape(view: { format?: string; choices?: { id: string }[]; matchTargets?: { id: string }[] }, answer: unknown): void {
  const format = view.format;
  const choiceIds = new Set((view.choices ?? []).map(choice => choice.id));
  const targetIds = new Set((view.matchTargets ?? []).map(target => target.id));
  const bad = (message: string): never => { throw new Error(message); };
  if (format === "mcq" || format === "true-false") {
    const id = String(Array.isArray(answer) ? answer[0] ?? "" : answer).trim().toUpperCase();
    if (!choiceIds.has(id)) bad(`answer must be one of: ${[...choiceIds].join(", ")}.`);
    return;
  }
  if (format === "multi-select") {
    const ids = (Array.isArray(answer) ? answer : [answer]).map(value => String(value).trim().toUpperCase());
    if (!ids.length || ids.some(id => !choiceIds.has(id))) bad(`answer must be a non-empty array of: ${[...choiceIds].join(", ")}.`);
    return;
  }
  if (format === "numeric") {
    const text = String(answer).trim();
    if (parseNumber(text) === undefined) bad('answer must be a number such as "0.75", "3/4" or "2 1/2".');
    return;
  }
  if (format === "matching") {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) bad('answer must be an object such as {"A":"1","B":"2"}.');
    for (const [left, right] of Object.entries(answer as Record<string, unknown>)) {
      if (!choiceIds.has(left)) bad(`answer contains an unknown left item: ${left}`);
      if (!targetIds.has(String(right))) bad(`answer pairs ${left} with an unknown right item: ${String(right)}`);
    }
    return;
  }
  if (typeof answer !== "string" || !answer.trim()) bad("answer must be non-empty text.");
}
