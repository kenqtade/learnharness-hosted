// TRACK B — persistence for the Question Bank: one JSON document at
// ctx.dataDirectory/bank.json plus one small settings document next to it.
// Every write validates every stored question with the shared assertQuestion, so
// a question that would break the simulator can never reach disk. Several
// serverless instances share the file: all reads/writes go through the shared
// JsonStore (re-read on revision change, atomic rename on write).
import path from "node:path";
import type { PluginModelSpec } from "learnharness-plugin-api";
import { assertQuestion, type BankJob, type Question, type Skill } from "../shared/contract.ts";
import { JsonStore, newId, nowIso } from "../shared/json-store.ts";
import { mergeSkills } from "./taxonomy.ts";

export interface BankStats { attempts: number; correct: number; seconds: number }

/** Learner-owned bank settings. The Tavily key never leaves the backend: the
 * `bank.settings.get` operation reports `hasKey` only. */
export interface BankSettingsState {
  revision: number;
  /** `null` = follow the host's cheap model slot. */
  modelOverride: PluginModelSpec | null;
  tavilyKey: string | null;
}

export type StepKind = "task" | "fetch";
export type StepWorker = "author" | "solver" | "critic" | "extractor";
export type StepStatus = "pending" | "running" | "succeeded" | "failed";

/** One node of the persisted job state machine. `requestId` is stable across
 * restarts: the host returns the already-accepted task for an identical request
 * id, so reconcile can always re-attach to work that a frozen instance started. */
export interface JobStep {
  id: string;
  kind: StepKind;
  worker?: StepWorker;
  requires: string[];
  status: StepStatus;
  /** Worker request id (stable) or `fetch:<id>` for network steps. */
  requestId?: string;
  taskId?: string;
  /** Persisted worker input / fetch parameters; never derived from a result. */
  input?: unknown;
  result?: unknown;
  error?: string;
  startedAt?: string;
}

export interface JobPlan {
  steps: JobStep[];
  /** Resolved once per job and persisted, so a restart re-accepts identical work. */
  model?: PluginModelSpec;
  /** Prepared (still unverified) questions this job will write when it finishes. */
  questions: Question[];
  /** Existing question ids targeted by a `verify` job. */
  targets?: string[];
}

export interface StoredJob extends BankJob { plan?: JobPlan }

export interface BankState {
  revision: number;
  questions: Record<string, Question>;
  skills: Record<string, Skill>;
  jobs: Record<string, StoredJob>;
  stats: Record<string, BankStats>;
}

const emptyState = (): BankState => ({ revision: 0, questions: {}, skills: {}, jobs: {}, stats: {} });
const emptySettings = (): BankSettingsState => ({ revision: 0, modelOverride: null, tavilyKey: null });

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function assertSkill(value: unknown): asserts value is Skill {
  if (!isObject(value)) throw new Error("Skill must be an object.");
  for (const key of ["id", "exam", "domain", "name"]) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new Error(`Skill.${key} is required.`);
  }
}

function assertStats(value: unknown): asserts value is BankStats {
  if (!isObject(value)) throw new Error("Stats must be an object.");
  for (const key of ["attempts", "correct", "seconds"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key] as number)) throw new Error(`Stats.${key} must be a number.`);
  }
}

function assertJob(value: unknown): asserts value is StoredJob {
  if (!isObject(value)) throw new Error("Job must be an object.");
  if (typeof value.id !== "string" || !value.id) throw new Error("Job.id is required.");
  if (!["author", "source", "import", "verify"].includes(value.kind as string)) throw new Error("Job.kind is invalid.");
  if (!["queued", "running", "succeeded", "failed", "cancelled"].includes(value.status as string)) throw new Error("Job.status is invalid.");
  if (!Array.isArray(value.produced)) throw new Error("Job.produced must be an array.");
}

/** Read-time validation for bank.json: every question, skill and job must be usable. */
export function assertBankState(value: unknown): asserts value is BankState {
  if (!isObject(value)) throw new Error("bank.json must contain an object.");
  if (typeof value.revision !== "number") throw new Error("bank.json needs a numeric revision.");
  for (const key of ["questions", "skills", "jobs", "stats"] as const) if (!isObject(value[key])) throw new Error(`bank.json needs a ${key} record.`);
  for (const question of Object.values(value.questions as Record<string, unknown>)) assertQuestion(question);
  for (const skill of Object.values(value.skills as Record<string, unknown>)) assertSkill(skill);
  for (const job of Object.values(value.jobs as Record<string, unknown>)) assertJob(job);
  for (const stat of Object.values(value.stats as Record<string, unknown>)) assertStats(stat);
}

export function assertSettings(value: unknown): asserts value is BankSettingsState {
  if (!isObject(value)) throw new Error("bank-settings.json must contain an object.");
  if (value.modelOverride !== null && !isObject(value.modelOverride)) throw new Error("modelOverride must be null or a model.");
  if (value.modelOverride && (typeof value.modelOverride.provider !== "string" || typeof value.modelOverride.id !== "string"))
    throw new Error("modelOverride needs a provider and a model id.");
  if (value.tavilyKey !== null && typeof value.tavilyKey !== "string") throw new Error("tavilyKey must be a string or null.");
}

export class BankStore {
  readonly file: string;
  readonly settingsFile: string;
  private readonly state: JsonStore<BankState>;
  private readonly settings: JsonStore<BankSettingsState>;

  constructor(dataDirectory: string) {
    this.file = path.join(dataDirectory, "bank.json");
    this.settingsFile = path.join(dataDirectory, "bank-settings.json");
    this.state = new JsonStore(this.file, emptyState, value => { assertBankState(value); return value; });
    this.settings = new JsonStore(this.settingsFile, emptySettings, value => { assertSettings(value); return value; });
  }

  get(): BankState { return this.state.get(); }

  /** Read → modify → validate → atomic write. The revision increments once. */
  change<R>(mutate: (draft: BankState) => R): R {
    return this.state.change(draft => {
      const result = mutate(draft);
      assertBankState(draft);
      return result;
    });
  }

  /** Seed the built-in taxonomy. Merge only: stored skills are never replaced. */
  seed(): { added: number } {
    const current = this.get();
    const { skills, added } = mergeSkills(current.skills);
    if (added) this.change(draft => { draft.skills = skills; });
    return { added };
  }

  getSettings(): BankSettingsState { return this.settings.get(); }

  saveSettings(patch: Partial<Omit<BankSettingsState, "revision">>): BankSettingsState {
    return this.settings.change(draft => {
      if ("modelOverride" in patch) draft.modelOverride = patch.modelOverride ?? null;
      if ("tavilyKey" in patch) draft.tavilyKey = patch.tavilyKey ? String(patch.tavilyKey) : null;
      assertSettings(draft);
      return draft;
    });
  }

  question(id: string): Question | undefined { return this.get().questions[id]; }

  job(id: string): StoredJob | undefined { return this.get().jobs[id]; }

  putJob(job: StoredJob): void {
    this.change(draft => { draft.jobs[job.id] = job; });
  }

  /** Update one job in place; no-op when the job was deleted meanwhile. */
  updateJob(id: string, update: (job: StoredJob) => void): StoredJob | undefined {
    return this.change(draft => {
      const job = draft.jobs[id];
      if (!job) return undefined;
      update(job);
      job.updatedAt = nowIso();
      return job;
    });
  }

  /** Record one graded response for per-skill mastery. `correct: null` (rubric
   * grading needed) counts as an attempt but never as a correct one. */
  recordResponse(questionId: string, correct: boolean | null, seconds: number): BankStats {
    return this.change(draft => {
      const stats = draft.stats[questionId] ?? { attempts: 0, correct: 0, seconds: 0 };
      stats.attempts += 1;
      if (correct === true) stats.correct += 1;
      stats.seconds += Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      draft.stats[questionId] = stats;
      return stats;
    });
  }
}

export { newId, nowIso };
