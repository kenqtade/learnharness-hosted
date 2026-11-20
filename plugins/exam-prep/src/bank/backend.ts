// Question Bank backend: the operations behind the Question Bank view, the
// BankApi the Exam Simulator uses (same process), and two tutor tools.
// Persistence: ./store.ts (bank.json); AI work: ./pipeline.ts (workers).
import fs from "node:fs";
import type { PluginBackendContext, PluginModelSpec } from "learnharness-plugin-api";
import { Type } from "typebox";
import {
  assertQuestion, FORMATS, type AuthorRequest, type BankApi, type BankJob, type Question, type QuestionFormat,
  type QuestionQuery, type Skill, type VerificationStatus,
} from "../shared/contract.ts";
import { BUILT_IN_EXAMS } from "../shared/exams.ts";
import { newId, nowIso } from "../shared/json-store.ts";
import { createPipeline, TOPIC, type ImportRequest, type SourceRequest } from "./pipeline.ts";
import { STARTER_QUESTIONS } from "./starter.ts";
import { BankStore, type StoredJob } from "./store.ts";
import { examName } from "./taxonomy.ts";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fail = (message: string): never => { throw new Error(message); };
const STATUSES: readonly VerificationStatus[] = ["unverified", "verified", "disputed"];

/** What the list view needs per row (no answer key, no explanation). */
export interface QuestionSummary {
  id: string; exams: string[]; subject: string; skillId: string; skillName: string; domain: string;
  difficulty: number; format: QuestionFormat; stem: string; status: VerificationStatus;
  source: Question["source"]["kind"]; sourceUrl?: string; attempts: number; correct: number; updatedAt: string;
}

export interface ListFilter {
  exam?: string; skillId?: string; domain?: string; status?: VerificationStatus; format?: QuestionFormat;
  difficulty?: number; search?: string; offset?: number; limit?: number;
}

/** Public view of a job (the internal plan stays on the server). */
export const publicJob = (job: StoredJob): BankJob => {
  const { plan: _plan, ...rest } = job;
  return rest;
};

export function filterQuestions(questions: Question[], skills: Record<string, Skill>, filter: ListFilter): Question[] {
  const search = str(filter.search).toLowerCase();
  return questions.filter(q =>
    (!filter.exam || q.exams.includes(filter.exam)) &&
    (!filter.skillId || q.skillId === filter.skillId) &&
    (!filter.domain || skills[q.skillId]?.domain === filter.domain) &&
    (!filter.status || q.verification.status === filter.status) &&
    (!filter.format || q.format === filter.format) &&
    (!filter.difficulty || q.difficulty === filter.difficulty) &&
    (!search || `${q.stem}\n${q.passage ?? ""}\n${(q.choices ?? []).map(c => c.text).join("\n")}\n${(q.tags ?? []).join(" ")}`.toLowerCase().includes(search)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** BankApi.query semantics (shared with tests): verified only unless asked, newest first, capped. */
export function queryQuestions(questions: Question[], query: QuestionQuery): Question[] {
  const statuses = query.status?.length ? query.status : ["verified"];
  const exclude = new Set(query.excludeIds ?? []);
  const skills = query.skillIds?.length ? new Set(query.skillIds) : undefined;
  return questions.filter(q =>
    !exclude.has(q.id) && statuses.includes(q.verification.status) &&
    (!query.exam || q.exams.includes(query.exam)) &&
    (!query.subject || q.subject === query.subject) &&
    (!skills || skills.has(q.skillId)) &&
    (!query.difficulty?.length || query.difficulty.includes(q.difficulty)) &&
    (!query.formats?.length || query.formats.includes(q.format)))
    .slice(0, Math.max(1, Math.min(500, query.limit ?? 50)));
}

/** A learner-written or edited question → a stored question (validated). */
export function normalizeManual(input: unknown, existing: Question | undefined, skills: Record<string, Skill>): Question {
  if (!isObject(input)) fail("Send the question as an object.");
  const q = input as Record<string, unknown>;
  const skill = skills[str(q.skillId)] ?? fail("Choose a skill for this question.");
  const now = nowIso();
  const source = isObject(q.source) ? q.source as unknown as Question["source"] : existing?.source ?? { kind: "manual" as const };
  const question = {
    ...(existing ?? {}),
    id: existing?.id ?? newId("q"),
    revision: (existing?.revision ?? 0) + 1,
    exams: Array.isArray(q.exams) && q.exams.length ? (q.exams as unknown[]).map(String) : [skill.exam],
    subject: str(q.subject) || existing?.subject || BUILT_IN_EXAMS.find(e => e.id === skill.exam)?.sections.find(s => skill.id.startsWith(`${skill.exam}.${s.id}.`))?.subject || "General",
    skillId: skill.id,
    difficulty: Number(q.difficulty) as Question["difficulty"],
    format: q.format as QuestionFormat,
    ...(str(q.passage) ? { passage: str(q.passage) } : { passage: undefined }),
    stem: str(q.stem),
    ...(Array.isArray(q.choices) ? { choices: (q.choices as unknown[]).map((c, i) => ({ id: str((c as Record<string, unknown>)?.id) || String.fromCharCode(65 + i), text: str((c as Record<string, unknown>)?.text) })) } : {}),
    ...(Array.isArray(q.matchTargets) ? { matchTargets: q.matchTargets as Question["matchTargets"] } : {}),
    answer: q.answer as Question["answer"],
    explanation: str(q.explanation),
    ...(Array.isArray(q.tools) ? { tools: q.tools as Question["tools"] } : {}),
    ...(Array.isArray(q.tags) ? { tags: (q.tags as unknown[]).map(String).filter(Boolean) } : {}),
    source,
    // A learner-written key counts as checked by a human; an edit keeps prior checks.
    verification: existing?.verification ?? { status: source.kind === "manual" ? "verified" : "unverified", checks: source.kind === "manual" ? [{ by: "human", verdict: "agree", at: now }] : [] },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } as Question;
  if (question.passage === undefined) delete question.passage;
  if (!FORMATS.includes(question.format)) fail(`Unknown question format: ${String(q.format)}`);
  assertQuestion(question);
  return question;
}

export function activateBankBackend(ctx: PluginBackendContext): BankApi {
  const store = new BankStore(ctx.dataDirectory);
  const firstRun = !fs.existsSync(store.file);
  store.seed();
  // First activation only: a small starter set (written for this app) so the bank
  // and the simulator are usable before any AI generation.
  if (firstRun) {
    store.change(draft => {
      for (const q of STARTER_QUESTIONS) if (draft.skills[q.skillId]) draft.questions[q.id] = q;
    });
  }
  const notify = () => ctx.events.emit(TOPIC, { at: nowIso() });
  const pipeline = createPipeline({ ctx, store, notify });
  ctx.cleanup(pipeline.registerWorkers());

  const summary = (q: Question): QuestionSummary => {
    const skill = store.get().skills[q.skillId];
    const stats = store.get().stats[q.id];
    return {
      id: q.id, exams: q.exams, subject: q.subject, skillId: q.skillId, skillName: skill?.name ?? q.skillId, domain: skill?.domain ?? "",
      difficulty: q.difficulty, format: q.format, stem: q.stem.length > 280 ? `${q.stem.slice(0, 277)}…` : q.stem,
      status: q.verification.status, source: q.source.kind, ...(q.source.url ? { sourceUrl: q.source.url } : {}),
      attempts: stats?.attempts ?? 0, correct: stats?.correct ?? 0, updatedAt: q.updatedAt,
    };
  };
  const all = () => Object.values(store.get().questions);
  const reconcileActive = async () => {
    for (const job of pipeline.list()) if (job.status === "queued" || job.status === "running") await pipeline.reconcile(job.id).catch(() => undefined);
  };

  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    "bank.overview": async () => {
      await reconcileActive();
      const questions = all(), skills = store.get().skills;
      const exams = BUILT_IN_EXAMS.map(e => {
        const mine = questions.filter(q => q.exams.includes(e.id));
        return {
          id: e.id, name: e.name, country: e.country, organization: e.organization,
          sections: e.sections.map(s => ({ id: s.id, name: s.name, subject: s.subject, domains: s.domains })),
          skills: Object.values(skills).filter(s => s.exam === e.id).length,
          questions: mine.length, verified: mine.filter(q => q.verification.status === "verified").length,
        };
      });
      // Custom exams (profiles the simulator built) that have questions.
      for (const exam of new Set(questions.flatMap(q => q.exams))) if (!exams.some(e => e.id === exam)) {
        const mine = questions.filter(q => q.exams.includes(exam));
        exams.push({ id: exam, name: examName(exam), country: "", organization: "", sections: [], skills: Object.values(skills).filter(s => s.exam === exam).length, questions: mine.length, verified: mine.filter(q => q.verification.status === "verified").length });
      }
      const jobs = pipeline.list();
      return {
        total: questions.length,
        byStatus: Object.fromEntries(STATUSES.map(s => [s, questions.filter(q => q.verification.status === s).length])),
        exams, activeJobs: jobs.filter(j => j.status === "queued" || j.status === "running").length,
      };
    },
    "bank.list": input => {
      const filter = input as ListFilter;
      const rows = filterQuestions(all(), store.get().skills, filter);
      const offset = Math.max(0, Number(filter.offset) || 0), limit = Math.max(1, Math.min(200, Number(filter.limit) || 50));
      return { total: rows.length, questions: rows.slice(offset, offset + limit).map(summary) };
    },
    "bank.get": input => {
      const q = store.question(str(input.id)) ?? fail("That question no longer exists.");
      const skill = store.get().skills[q.skillId];
      return { question: q, skill, stats: store.get().stats[q.id] ?? { attempts: 0, correct: 0, seconds: 0 } };
    },
    "bank.skills": input => {
      const exam = str(input.exam);
      const questions = all();
      const stats = store.get().stats;
      return Object.values(store.get().skills).filter(s => !exam || s.exam === exam)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(s => {
          const mine = questions.filter(q => q.skillId === s.id);
          const attempts = mine.reduce((n, q) => n + (stats[q.id]?.attempts ?? 0), 0);
          const correct = mine.reduce((n, q) => n + (stats[q.id]?.correct ?? 0), 0);
          return { ...s, questions: mine.length, verified: mine.filter(q => q.verification.status === "verified").length, attempts, correct };
        });
    },
    "bank.save": input => {
      const existing = input.id ? store.question(str(input.id)) : undefined;
      if (input.id && !existing) fail("That question no longer exists.");
      const question = normalizeManual(input.question ?? input, existing, store.get().skills);
      store.change(draft => { draft.questions[question.id] = question; });
      notify();
      return question;
    },
    "bank.delete": input => {
      const ids = (Array.isArray(input.ids) ? input.ids : [input.id]).map(String).filter(Boolean);
      if (!ids.length) fail("Choose a question to delete.");
      const removed = store.change(draft => ids.filter(id => { const had = !!draft.questions[id]; delete draft.questions[id]; delete draft.stats[id]; return had; }).length);
      notify();
      return { removed };
    },
    "bank.setStatus": input => {
      const id = str(input.id), status = input.status as VerificationStatus;
      if (!STATUSES.includes(status)) fail("Status must be unverified, verified or disputed.");
      const q = store.change(draft => {
        const q = draft.questions[id] ?? fail("That question no longer exists.");
        q.verification = { status, checks: [...q.verification.checks, { by: "human", verdict: status === "verified" ? "agree" : status === "disputed" ? "disagree" : "flag", ...(str(input.note) ? { notes: str(input.note) } : {}), at: nowIso() }] };
        q.updatedAt = nowIso();
        return q;
      });
      notify();
      return q;
    },
    "bank.author": input => publicJob(pipeline.author({
      exam: str(input.exam), subject: str(input.subject), skillId: str(input.skillId),
      difficulty: Number(input.difficulty) as AuthorRequest["difficulty"], format: input.format as QuestionFormat, count: Number(input.count) || 1,
    })),
    "bank.source": input => publicJob(pipeline.source({ exam: str(input.exam), ...(str(input.skillId) ? { skillId: str(input.skillId) } : {}), ...(str(input.topic) ? { topic: str(input.topic) } : {}), count: Number(input.count) || 5 } as SourceRequest)),
    "bank.import": input => publicJob(pipeline.importPaper({ name: str(input.name) || "Pasted paper", markdown: String(input.markdown ?? ""), exam: str(input.exam), ...(str(input.skill) ? { skill: str(input.skill) } : {}) } as ImportRequest)),
    "bank.verify": input => publicJob(pipeline.verify((Array.isArray(input.ids) ? input.ids : []).map(String))),
    "bank.jobs": async () => { await reconcileActive(); return pipeline.list().slice(0, 50).map(publicJob); },
    "bank.job": async input => {
      const job = await pipeline.reconcile(str(input.id)) ?? fail("That job no longer exists.");
      return { job: publicJob(job), questions: job.produced.map(id => store.question(id)).filter((q): q is Question => !!q).map(summary) };
    },
    "bank.cancel": input => publicJob(pipeline.cancel(str(input.id))),
    "bank.clearJobs": () => {
      const removed = store.change(draft => {
        let n = 0;
        for (const [id, job] of Object.entries(draft.jobs)) if (["succeeded", "failed", "cancelled"].includes(job.status)) { delete draft.jobs[id]; n++; }
        return n;
      });
      notify();
      return { removed };
    },
    "bank.settings.get": () => {
      const s = store.getSettings();
      return { modelOverride: s.modelOverride, hasSearchKey: !!s.tavilyKey };
    },
    "bank.settings.set": input => {
      const patch: { modelOverride?: PluginModelSpec | null; tavilyKey?: string | null } = {};
      if ("modelOverride" in input) patch.modelOverride = (input.modelOverride as PluginModelSpec | null) ?? null;
      if ("searchKey" in input) patch.tavilyKey = str(input.searchKey) || null;
      const s = store.saveSettings(patch);
      return { modelOverride: s.modelOverride, hasSearchKey: !!s.tavilyKey };
    },
    "bank.export": input => {
      const exam = str(input.exam);
      return { version: 1, exportedAt: nowIso(), questions: all().filter(q => !exam || q.exams.includes(exam)) };
    },
    "bank.importJson": input => {
      const list = Array.isArray(input.questions) ? input.questions : fail("Send { questions: [...] } as exported by the Question Bank.");
      let added = 0;
      const errors: string[] = [];
      store.change(draft => {
        for (const raw of list) {
          try {
            assertQuestion(raw);
            if (!draft.skills[raw.skillId]) throw new Error(`unknown skill ${raw.skillId}`);
            draft.questions[raw.id] = raw; added++;
          } catch (error) { if (errors.length < 10) errors.push((error as Error).message); }
        }
      });
      notify();
      return { added, errors };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ctx.handle(name, input => handler(isObject(input) ? input : {}));
  }

  // ── Tutor tools: let the teacher/practice agent use bank questions ─────────
  const searchSchema = Type.Object({
    exam: Type.Optional(Type.String({ description: "Exam id, e.g. sat, act, ielts-academic, a-level-maths, ib-math-aa, et-esslce-natural, et-esslce-social" })),
    query: Type.Optional(Type.String({ description: "Words to look for in the question text or skill name" })),
    skillId: Type.Optional(Type.String()),
    difficulty: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  });
  const getSchema = Type.Object({ id: Type.String({ description: "Question id from exam_bank_search" }) });
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: value });
  ctx.registerTools({
    agents: ["teacher", "practice"],
    create: () => [
      {
        name: "exam_bank_search", label: "Search question bank",
        description: "Search the learner's Exam Prep question bank (official-exam-style questions linked to skills). Returns ids, skills, difficulty and the question text without answers.",
        parameters: searchSchema,
        execute: async (_id: string, params: Record<string, unknown>) => {
          const query = str(params.query).toLowerCase();
          const skills = store.get().skills;
          const rows = filterQuestions(all(), skills, { exam: str(params.exam) || undefined, skillId: str(params.skillId) || undefined, difficulty: Number(params.difficulty) || undefined })
            .filter(q => !query || `${q.stem} ${skills[q.skillId]?.name ?? ""} ${skills[q.skillId]?.domain ?? ""}`.toLowerCase().includes(query))
            .slice(0, Math.max(1, Math.min(10, Number(params.limit) || 5)));
          return text(rows.length ? rows.map(q => ({ id: q.id, exam: q.exams.join(","), skill: skills[q.skillId]?.name, difficulty: q.difficulty, format: q.format, status: q.verification.status, stem: q.stem, choices: q.choices })) : "No matching questions in the bank.");
        },
      },
      {
        name: "exam_bank_get", label: "Get bank question",
        description: "Get one Question Bank question with its answer key, worked explanation and source. Use after the learner has answered, or to prepare a hint.",
        parameters: getSchema,
        execute: async (_id: string, params: Record<string, unknown>) => {
          const q = store.question(str(params.id));
          return text(q ?? "No question with that id.");
        },
      },
    ],
  });
  ctx.registerInstructions({
    agents: ["teacher", "practice"],
    text: "Exam Prep is installed. When the learner prepares for a standardized exam (SAT, ACT, IELTS, A-Level, IB, the Ethiopian national exam or similar), use exam_bank_search to find official-style practice questions for the skill you are teaching, ask them one at a time in your own message (do not reveal the key), then use exam_bank_get to check the answer and explain. Tell the learner they can take a full timed simulation in Exam Simulator.",
  });

  return {
    query: query => queryQuestions(all(), query),
    get: ids => ids.map(id => store.question(id)).filter((q): q is Question => !!q),
    skills: exam => Object.values(store.get().skills).filter(s => !exam || s.exam === exam),
    upsertSkills: skills => { store.change(draft => { for (const s of skills) draft.skills[s.id] = s; }); notify(); },
    author: request => publicJob(pipeline.author(request)),
    job: id => {
      const job = store.job(id);
      // Nudge it forward here too: on a hosted server the instance that started it may be gone.
      if (job && (job.status === "queued" || job.status === "running")) void pipeline.reconcile(id).catch(() => undefined);
      return job ? publicJob(job) : undefined;
    },
    recordResponses: responses => {
      if (!responses.length) return;
      store.change(draft => {
        for (const r of responses) {
          if (!draft.questions[r.questionId]) continue;
          const stats = draft.stats[r.questionId] ?? { attempts: 0, correct: 0, seconds: 0 };
          stats.attempts += 1; if (r.correct === true) stats.correct += 1;
          stats.seconds += Math.max(0, Number(r.seconds) || 0);
          draft.stats[r.questionId] = stats;
        }
      });
      notify();
    },
  };
}
