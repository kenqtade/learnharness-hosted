// Exam Prep — the contract between the Question Bank (src/bank/**) and the
// Exam Simulator (src/sim/**). Owned by the integration owner: tracks B and C
// READ this file; propose changes in .agents/REPORT.md instead of editing it.
// Pure data + validators: no DOM, no node:* imports (used by both frontends and backends).

export const CONTRACT_VERSION = 1 as const;

// ── Questions ──────────────────────────────────────────────────────────────
export type QuestionFormat =
  | "mcq"            // exactly one correct choice
  | "multi-select"   // one or more correct choices
  | "numeric"        // student-produced response / grid-in (number, fraction allowed)
  | "short-answer"   // short text, matched against accepted answers
  | "essay"          // free writing, graded by rubric (AI)
  | "true-false"
  | "matching"       // pairs left → right
  | "cloze";         // fill the blanks in a passage

export interface Choice { id: string; text: string } // id: "A", "B", …; text: Markdown + $LaTeX$

export type AnswerKey =
  | { kind: "choice"; correct: string[] }                                   // mcq, multi-select, true-false ("T"/"F")
  | { kind: "numeric"; value: number; tolerance?: number; accepted?: string[] } // accepted: "3/4", ".75"
  | { kind: "text"; accepted: string[]; caseSensitive?: boolean }           // short-answer, cloze (one per blank, "|" separates blanks)
  | { kind: "matching"; pairs: Record<string, string> }
  | { kind: "rubric"; rubric: string; maxPoints: number };                  // essay

export type ToolId =
  | "graphing-calculator" | "scientific-calculator" | "four-function-calculator" | "matrix-calculator"
  | "reference-sheet" | "notes" | "highlighter" | "answer-eliminator";

export interface Skill {
  /** Stable id, e.g. "sat.math.algebra.linear-equations-one-variable". */
  id: string;
  exam: string;      // profile id, e.g. "sat"
  domain: string;    // e.g. "Algebra"
  name: string;      // e.g. "Linear equations in one variable"
}

export type SourceKind = "ai" | "web" | "upload" | "manual";
export interface QuestionSource {
  kind: SourceKind;
  url?: string;          // web: the page the question was copied from
  title?: string;        // page / paper title
  publisher?: string;
  license?: string;      // what the page says, if anything ("unknown" otherwise)
  retrievedAt?: string;  // ISO date
  model?: string;        // ai: author model "provider/id"
  note?: string;
}

export type VerificationStatus = "unverified" | "verified" | "disputed";
export interface VerificationCheck {
  by: "solver" | "critic" | "human";
  model?: string;
  verdict: "agree" | "disagree" | "flag";
  answer?: string;       // solver's own answer (normalized)
  notes?: string;
  at: string;            // ISO
}

export interface Question {
  id: string;
  revision: number;
  exams: string[];                 // profile ids this question fits
  subject: string;                 // "Math", "Reading and Writing", "Physics", …
  skillId: string;                 // Skill.id
  difficulty: 1 | 2 | 3 | 4 | 5;   // 1 easiest
  format: QuestionFormat;
  passage?: string;                // shared reading passage / data (Markdown + LaTeX)
  stem: string;                    // Markdown + $LaTeX$
  choices?: Choice[];              // mcq / multi-select / true-false / matching (left items)
  matchTargets?: Choice[];         // matching: right items
  answer: AnswerKey;
  explanation: string;             // full worked solution (Markdown + LaTeX)
  tools?: ToolId[];                // tools the question assumes (e.g. graphing-calculator)
  estimatedSeconds?: number;
  source: QuestionSource;
  verification: { status: VerificationStatus; checks: VerificationCheck[] };
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/** What the simulator may ask of the bank (backend-to-backend, same process). */
export interface QuestionQuery {
  exam?: string;
  subject?: string;
  skillIds?: string[];
  difficulty?: number[];            // allowed difficulties
  formats?: QuestionFormat[];
  status?: VerificationStatus[];    // default ["verified"]
  excludeIds?: string[];
  limit?: number;                   // default 50
}

export interface AuthorRequest {
  exam: string;
  subject: string;
  skillId: string;
  difficulty: Question["difficulty"];
  format: QuestionFormat;
  count: number;                    // ≤ 5 per job task (hosted 240 s budget)
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface BankJob {
  id: string;
  kind: "author" | "source" | "import" | "verify";
  status: JobStatus;
  request: unknown;
  createdAt: string;
  updatedAt: string;
  produced: string[];               // question ids
  error?: string;
  progress?: { done: number; total: number; stage?: string };
}

/** Implemented by src/bank/backend.ts and handed to src/sim/backend.ts. */
export interface BankApi {
  query(query: QuestionQuery): Question[];
  get(ids: string[]): Question[];
  skills(exam?: string): Skill[];
  upsertSkills(skills: Skill[]): void;
  /** Start background authoring (author → solver → critic). Returns the job at once. */
  author(request: AuthorRequest): BankJob;
  job(id: string): BankJob | undefined;
  /** Record that a learner answered (for per-skill mastery and question stats). */
  recordResponses(responses: { questionId: string; correct: boolean | null; seconds: number }[]): void;
}

// ── Exam profiles ──────────────────────────────────────────────────────────
export interface ModuleSpec {
  id: string;
  name: string;
  questionCount: number;
  minutes: number;
  /** Blueprint: share of questions per skill domain (sums ≈ 1). */
  blueprint?: { domain: string; share: number }[];
  formats: { format: QuestionFormat; share: number }[];
  difficulty?: number[];            // allowed difficulties for this module
  /** Adaptive routing: this module's difficulty depends on the previous module. */
  adaptive?: { from: string; threshold: number; easier: number[]; harder: number[] };
}

export interface SectionSpec {
  id: string;
  name: string;
  subject: string;
  modules: ModuleSpec[];
  tools: ToolId[];                  // allowed in strict mode
  referenceSheet?: string;          // Markdown + LaTeX
  breakAfterMinutes?: number;       // break offered after this section
  notSimulated?: string;            // e.g. IELTS Listening: why it is skipped
}

export interface ScoreScale {
  min: number;
  max: number;
  step?: number;
  /** Raw % → scaled, piecewise-linear points [[0,min], …, [1,max]]. */
  curve?: [number, number][];
  /** Per-section scales when the total is a sum (SAT: 200–800 each). */
  perSection?: Record<string, { min: number; max: number; curve?: [number, number][] }>;
  combine?: "sum" | "average" | "none";
  label?: string;                   // "Total score", "Band", "Grade"
}

export interface ExamProfile {
  id: string;                       // "sat", "act", "ielts-academic", "a-level-maths", "ib-math-aa", "et-esslce-natural", …
  name: string;
  country: string;                  // ISO country or "International"
  organization: string;             // College Board, ACT Inc., …
  language: string;                 // BCP-47
  description: string;
  sections: SectionSpec[];
  scoring: ScoreScale;
  rules?: string[];                 // learner-facing rules
  sourceUrls?: string[];            // where the format was taken from
  builtIn: boolean;
  revision: number;
  updatedAt: string;
}

// ── Attempts (one exam sitting) ────────────────────────────────────────────
export interface AttemptSetup {
  profileId: string;
  sectionIds: string[];             // subset = section practice
  mode: "strict" | "practice";
  timeMultiplier: number;           // 1, 1.5, 2; 0 = untimed
  tools: ToolId[];                  // effective tool list (strict = profile's)
  questionCountScale?: number;      // 0.25…1 for short custom tests
}

export interface AttemptResponse {
  questionId: string;
  answer: unknown;                  // shape per format: string[], number|string, string, Record<string,string>, essay text
  flagged: boolean;
  eliminated?: string[];
  seconds: number;
  correct?: boolean | null;         // null = needs rubric grading
  points?: number;
}

export interface AttemptModuleState {
  sectionId: string;
  moduleId: string;
  questionIds: string[];
  startedAt?: string;
  submittedAt?: string;
  timeLimitSeconds: number;         // 0 = untimed
}

export interface Attempt {
  id: string;
  revision: number;
  setup: AttemptSetup;
  status: "preparing" | "ready" | "in-progress" | "submitted" | "scored" | "abandoned";
  preparing?: { jobIds: string[]; done: number; total: number };
  modules: AttemptModuleState[];
  current: { module: number; question: number };
  responses: Record<string, AttemptResponse>;
  notes?: string;
  score?: {
    total?: number;
    sections: Record<string, { raw: number; max: number; scaled?: number }>;
    skills: Record<string, { correct: number; total: number }>;
  };
  createdAt: string;
  updatedAt: string;
}

// ── Validators shared by both sides ───────────────────────────────────────
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
export const FORMATS: readonly QuestionFormat[] = ["mcq", "multi-select", "numeric", "short-answer", "essay", "true-false", "matching", "cloze"];
export const TOOLS: readonly ToolId[] = ["graphing-calculator", "scientific-calculator", "four-function-calculator", "matrix-calculator", "reference-sheet", "notes", "highlighter", "answer-eliminator"];

/** Throws with a learner-readable message when a question is structurally invalid. */
export function assertQuestion(q: unknown): asserts q is Question {
  if (!isObject(q)) throw new Error("Question must be an object.");
  for (const key of ["id", "subject", "skillId", "stem", "explanation", "createdAt", "updatedAt"]) if (!nonEmpty(q[key])) throw new Error(`Question.${key} is required.`);
  if (!Array.isArray(q.exams) || !q.exams.every(nonEmpty)) throw new Error("Question.exams must list profile ids.");
  if (![1, 2, 3, 4, 5].includes(q.difficulty as number)) throw new Error("Question.difficulty must be 1–5.");
  if (!FORMATS.includes(q.format as QuestionFormat)) throw new Error(`Unknown question format: ${String(q.format)}`);
  const answer = q.answer as AnswerKey | undefined;
  if (!isObject(answer)) throw new Error("Question.answer is required.");
  const choices = Array.isArray(q.choices) ? (q.choices as Choice[]) : [];
  const ids = new Set(choices.map(c => c.id));
  switch (q.format) {
    case "mcq": case "multi-select": case "true-false":
      if (answer.kind !== "choice" || !answer.correct.length || !answer.correct.every(id => ids.has(id))) throw new Error("Choice questions need choices and a key that names them.");
      if (q.format === "mcq" && answer.correct.length !== 1) throw new Error("A multiple-choice question has exactly one correct choice.");
      if (choices.length < 2) throw new Error("Choice questions need at least two choices.");
      break;
    case "numeric": if (answer.kind !== "numeric" || !Number.isFinite(answer.value)) throw new Error("Numeric questions need a numeric key."); break;
    case "short-answer": case "cloze": if (answer.kind !== "text" || !answer.accepted.length) throw new Error("Text questions need accepted answers."); break;
    case "matching": if (answer.kind !== "matching" || !Object.keys(answer.pairs).length) throw new Error("Matching questions need pairs."); break;
    case "essay": if (answer.kind !== "rubric" || !nonEmpty(answer.rubric)) throw new Error("Essays need a rubric."); break;
  }
  const source = q.source as QuestionSource | undefined;
  if (!isObject(source) || !["ai", "web", "upload", "manual"].includes(source.kind)) throw new Error("Question.source.kind is required.");
  if (source.kind === "web" && !nonEmpty(source.url)) throw new Error("A web-sourced question must keep its source URL.");
  const verification = q.verification as Question["verification"] | undefined;
  if (!isObject(verification) || !["unverified", "verified", "disputed"].includes(verification.status) || !Array.isArray(verification.checks)) throw new Error("Question.verification is required.");
}

/** Auto-grade one response; null when a rubric (AI/human) is needed. */
export function gradeResponse(q: Question, answer: unknown): boolean | null {
  const key = q.answer;
  if (answer === undefined || answer === null || answer === "") return false;
  switch (key.kind) {
    case "choice": {
      const given = (Array.isArray(answer) ? answer : [answer]).map(String).sort();
      return given.length === key.correct.length && [...key.correct].sort().every((id, i) => id === given[i]);
    }
    case "numeric": {
      const text = String(answer).trim();
      if (key.accepted?.some(a => a.replace(/\s/g, "") === text.replace(/\s/g, ""))) return true;
      const value = parseNumber(text);
      return value !== undefined && Math.abs(value - key.value) <= (key.tolerance ?? 1e-9 + Math.abs(key.value) * 1e-9);
    }
    case "text": {
      const norm = (s: string) => (key.caseSensitive ? s : s.toLowerCase()).replace(/\s+/g, " ").trim();
      return key.accepted.some(a => norm(a) === norm(String(answer)));
    }
    case "matching": {
      if (!isObject(answer)) return false;
      return Object.entries(key.pairs).every(([left, right]) => answer[left] === right);
    }
    case "rubric": return null;
  }
}

/** "3/4", "-1.5", ".75", "2 1/2" → number. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim();
  let m = /^(-?\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) { const whole = Number(m[1]), sign = whole < 0 ? -1 : 1; return whole + sign * Number(m[2]) / Number(m[3]); }
  m = /^(-?\d*\.?\d+)\/(\d*\.?\d+)$/.exec(t);
  if (m) return Number(m[2]) === 0 ? undefined : Number(m[1]) / Number(m[2]);
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : undefined;
}

/** Piecewise-linear raw fraction (0…1) → scaled score. */
export function scale(fraction: number, s: { min: number; max: number; step?: number; curve?: [number, number][] }): number {
  const curve = s.curve?.length ? s.curve : [[0, s.min], [1, s.max]] as [number, number][];
  const f = Math.min(1, Math.max(0, fraction));
  let value = curve[curve.length - 1]![1];
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1]!, [x1, y1] = curve[i]!;
    if (f <= x1) { value = y0 + (y1 - y0) * (x1 === x0 ? 1 : (f - x0) / (x1 - x0)); break; }
  }
  const step = s.step ?? 1;
  return Math.round(value / step) * step;
}
