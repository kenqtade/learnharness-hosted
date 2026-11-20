// Exam Simulator backend: profiles (built-in + AI-built), attempts with a
// server-side clock, adaptive routing, auto-grading, AI essay grading and tutor
// tools. Reads questions only through the BankApi contract.
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { Type } from "typebox";
import {
  gradeResponse, TOOLS, type Attempt, type AttemptModuleState, type AttemptSetup, type BankApi, type ExamProfile, type Question, type QuestionFormat,
  type SectionSpec, type Skill, type ToolId,
} from "../shared/contract.ts";
import { slug } from "../shared/exams.ts";
import { JsonStore, newId, nowIso } from "../shared/json-store.ts";
import { fetchPage, searchWeb } from "../bank/sourcing.ts";
import {
  isExpired, moduleCount, moduleFraction, moduleSeconds, moduleSlots, pickQuestions, remainingSeconds, route, scoreAttempt, sectionDomains, type Shortage,
} from "./engine.ts";
import { assertProfile, BUILT_IN_PROFILES } from "./profiles.ts";

export const SIM_TOPIC = "sim-changed";
export const SIM_WORKERS = { grader: "essay-grader-v1", builder: "profile-builder-v1" } as const;
const MAX_PREP_JOBS = 12;
const PREP_TIMEOUT_MS = 15 * 60_000;

interface ProfileBuild {
  id: string; status: "searching" | "running" | "ready" | "failed" | "saved"; request: { name: string; country?: string; notes?: string };
  taskId?: string; requestId: string; sources: { title: string; url: string }[]; profile?: ExamProfile; skills?: Skill[]; error?: string; createdAt: string; updatedAt: string;
}
interface SimState {
  revision: number;
  profiles: Record<string, ExamProfile>;      // custom profiles + edited built-ins
  hidden: string[];                            // built-ins the learner removed
  attempts: Record<string, Attempt & { prepStartedAt?: string; prepJobs?: string[] }>;
  builds: Record<string, ProfileBuild>;
}
const emptyState = (): SimState => ({ revision: 0, profiles: {}, hidden: [], attempts: {}, builds: {} });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fail = (message: string): never => { throw new Error(message); };

const graderInstructions = `You grade one exam response with the official rubric you are given, like a trained examiner.
Read the task, the rubric and the response. Award points from 0 to maxPoints (half points allowed only if the rubric uses bands such as IELTS 0–9 in steps of 0.5).
Be calibrated: do not inflate. A response far below the required length or off-topic scores low.
Return feedback for the learner: 3–6 short sentences naming what earned points, what cost points, and the single most useful improvement.
Optionally return per-criterion scores. Submit with submit_result.`;

const builderInstructions = `You design an exam profile for an exam simulator from research notes about an official exam.
Use the notes (search results and page extracts). When a detail is missing, use your best knowledge of the exam and say so in the rules.
Return JSON with:
- profile: { id (lowercase slug), name, country (ISO code or "International"), organization, language (BCP-47), description,
  sections: [{ id (slug), name, subject, tools (from: ${TOOLS.join(", ")} — only what the official exam allows), referenceSheet? (Markdown + LaTeX if a formula sheet is provided), breakAfterMinutes?, notSimulated? (reason, for listening/speaking/practical parts; give modules []),
    modules: [{ id, name, questionCount, minutes, formats: [{ format, share }], blueprint: [{ domain, share }], difficulty?: [1..5], adaptive?: { from, threshold, easier, harder } }] }],
  scoring: { min, max, step?, combine ("sum" | "average" | "none"), label, curve? [[fraction, score]...], perSection? { sectionId: { min, max } }, bands? [{ min, label }] },
  rules: [learner-facing rules: timing, tools, penalties, scoring notes], sourceUrls: [urls you relied on] }
- skills: [{ section (section id), domain (exactly as used in blueprints), name }] — 3–6 skills per domain, the way the official syllabus names them.
Question formats: mcq, multi-select, numeric, short-answer, essay, true-false, matching, cloze.
Keep counts and minutes faithful to the official exam. Submit with submit_result.`;

export function activateSimBackend(ctx: PluginBackendContext, bank: BankApi): void {
  const store = new JsonStore<SimState>(path.join(ctx.dataDirectory, "sim.json"), emptyState, value => {
    if (!isObject(value) || typeof value.revision !== "number") throw new Error("sim.json is damaged.");
    const v = value as unknown as SimState;
    v.profiles ??= {}; v.hidden ??= []; v.attempts ??= {}; v.builds ??= {};
    return v;
  });
  const notify = () => { try { ctx.events.emit(SIM_TOPIC, { at: nowIso() }); } catch { /* best effort */ } };

  // ── profiles ───────────────────────────────────────────────────────────
  const profiles = (): ExamProfile[] => {
    const s = store.get();
    const builtIns = BUILT_IN_PROFILES.filter(p => !s.hidden.includes(p.id)).map(p => s.profiles[p.id] ?? p);
    const custom = Object.values(s.profiles).filter(p => !BUILT_IN_PROFILES.some(b => b.id === p.id));
    return [...builtIns, ...custom.sort((a, b) => a.name.localeCompare(b.name))];
  };
  const profile = (id: string) => profiles().find(p => p.id === id) ?? fail("That exam profile no longer exists.");

  const sanitize = (q: Question): Question => {
    const key = q.answer;
    const answer: Question["answer"] = key.kind === "choice" ? { kind: "choice", correct: [] } : key.kind === "numeric" ? { kind: "numeric", value: 0 }
      : key.kind === "text" ? { kind: "text", accepted: [q.format === "cloze" ? "|".repeat(Math.max(0, (key.accepted[0] ?? "").split("|").length - 1)) : ""] }
      : key.kind === "matching" ? { kind: "matching", pairs: {} } : { kind: "rubric", rubric: "", maxPoints: key.maxPoints };
    return { ...q, answer, explanation: "", source: { kind: q.source.kind }, verification: { status: q.verification.status, checks: [] } };
  };

  // ── workers ────────────────────────────────────────────────────────────
  const gradeSchema = Type.Object({
    points: Type.Number({ minimum: 0 }), feedback: Type.String({ minLength: 1 }),
    criteria: Type.Optional(Type.Array(Type.Object({ name: Type.String(), score: Type.Number(), comment: Type.Optional(Type.String()) }))),
  });
  const builderSchema = Type.Object({ profile: Type.Any(), skills: Type.Array(Type.Object({ section: Type.String(), domain: Type.String(), name: Type.String() })) });
  const offGrader = ctx.workers.register({
    id: SIM_WORKERS.grader, instructions: graderInstructions, resultSchema: gradeSchema,
    validateResult: (result, context) => {
      const max = Number((context.input as { maxPoints?: number })?.maxPoints ?? 0);
      const points = (result as { points?: number }).points;
      if (typeof points !== "number" || points < 0 || points > max) throw new Error(`points must be between 0 and ${max}.`);
    },
  });
  const offBuilder = ctx.workers.register({
    id: SIM_WORKERS.builder, instructions: builderInstructions, resultSchema: builderSchema,
    validateResult: result => {
      const r = result as { profile?: ExamProfile; skills?: { section: string; domain: string; name: string }[] };
      const p = { ...(r.profile as ExamProfile), builtIn: false, revision: 1, updatedAt: nowIso() };
      assertProfile(p);
      const domains = new Set(p.sections.flatMap(s => s.modules.flatMap(m => m.blueprint ?? []).map(b => `${s.id}|${b.domain}`)));
      const covered = new Set((r.skills ?? []).map(s => `${s.section}|${s.domain}`));
      const missing = [...domains].filter(d => !covered.has(d));
      if (missing.length) throw new Error(`Give skills for every blueprint domain; missing: ${missing.slice(0, 5).join(", ")}`);
    },
  });
  ctx.cleanup(() => { offGrader(); offBuilder(); });
  const safeTask = (id: string | undefined) => { if (!id) return undefined; try { return ctx.workers.get(id); } catch { return undefined; } };

  // ── assembly ───────────────────────────────────────────────────────────
  function sectionsOf(p: ExamProfile, ids: string[]): SectionSpec[] {
    const chosen = p.sections.filter(s => s.modules.length && (!ids.length || ids.includes(s.id)));
    if (!chosen.length) fail("Choose at least one section that can be simulated.");
    return chosen;
  }
  function moduleSpec(p: ExamProfile, m: AttemptModuleState) {
    const section = p.sections.find(s => s.id === m.sectionId) ?? fail("This attempt's exam profile changed; start a new attempt.");
    const spec = section.modules.find(x => x.id === m.moduleId) ?? fail("This attempt's exam profile changed; start a new attempt.");
    return { section, spec };
  }
  /** Assemble every module that does not wait for adaptive routing. */
  function assemble(attempt: Attempt, p: ExamProfile, generateFor: Shortage[] | undefined): void {
    const exclude = new Set(attempt.modules.flatMap(m => m.questionIds));
    const allSkills = bank.skills(p.id);
    for (const m of attempt.modules) {
      if (m.submittedAt) continue;
      const { section, spec } = moduleSpec(p, m);
      const planned = m.planned ?? moduleCount(spec, attempt.setup);
      if (spec.adaptive && !m.route) {
        // Not routed yet: only measure what both routes would need.
        if (generateFor) {
          const slots = moduleSlots(spec, planned, [...new Set([...spec.adaptive.easier, ...spec.adaptive.harder])], sectionDomains(p, section, allSkills));
          const probe = pickQuestions(bank, p, section, slots, { allowUnverified: !!attempt.setup.allowUnverified, exclude: new Set(exclude), seed: attempt.id + m.moduleId });
          generateFor.push(...probe.shortages);
        }
        continue;
      }
      if (m.questionIds.length >= planned) continue;
      const difficulty = spec.difficulty ?? [1, 2, 3, 4, 5];
      const slots = moduleSlots(spec, planned - m.questionIds.length, difficulty, sectionDomains(p, section, allSkills));
      const picked = pickQuestions(bank, p, section, slots, { allowUnverified: !!attempt.setup.allowUnverified, exclude, seed: attempt.id + m.moduleId });
      m.questionIds.push(...picked.ids);
      m.planned = planned;
      m.timeLimitSeconds = moduleSeconds(spec, attempt.setup, Math.max(1, m.questionIds.length || planned));
      if (generateFor) generateFor.push(...picked.shortages);
    }
  }
  function routeModule(attempt: Attempt, p: ExamProfile, index: number, questions: Map<string, Question>): void {
    const m = attempt.modules[index];
    if (!m || m.route || m.questionIds.length) return;
    const { section, spec } = moduleSpec(p, m);
    if (!spec.adaptive) return;
    const fromIndex = attempt.modules.findIndex(x => x.sectionId === m.sectionId && x.moduleId === spec.adaptive!.from);
    const r = route(spec.adaptive, moduleFraction(attempt, fromIndex, questions));
    m.route = r.route;
    const planned = m.planned ?? moduleCount(spec, attempt.setup);
    const slots = moduleSlots(spec, planned, r.difficulty, sectionDomains(p, section, bank.skills(p.id)));
    const exclude = new Set(attempt.modules.flatMap(x => x.questionIds));
    m.questionIds = pickQuestions(bank, p, section, slots, { allowUnverified: !!attempt.setup.allowUnverified, exclude, seed: attempt.id + m.moduleId + r.route }).ids;
    m.planned = planned;
    m.timeLimitSeconds = moduleSeconds(spec, attempt.setup, Math.max(1, m.questionIds.length));
  }
  function startGeneration(p: ExamProfile, shortages: Shortage[]): string[] {
    const jobs: string[] = [];
    const subjectOf = (skillId: string) => p.sections.find(s => skillId.startsWith(`${p.id}.${s.id}.`))?.subject ?? p.sections[0]?.subject ?? "General";
    for (const short of shortages) {
      let left = short.missing, turn = 0;
      while (left > 0 && jobs.length < MAX_PREP_JOBS) {
        const count = Math.min(5, left);
        const skillId = short.skillIds[turn % Math.max(1, short.skillIds.length)];
        if (!skillId) break;
        const difficulty = (short.difficulty[turn % Math.max(1, short.difficulty.length)] ?? 3) as Question["difficulty"];
        try { jobs.push(bank.author({ exam: p.id, subject: subjectOf(skillId), skillId, difficulty, format: short.format, count }).id); }
        catch { break; }
        left -= count; turn++;
      }
    }
    return jobs;
  }

  // ── attempt life cycle ─────────────────────────────────────────────────
  function questionMap(attempt: Attempt): Map<string, Question> {
    return new Map(bank.get(attempt.modules.flatMap(m => m.questionIds)).map(q => [q.id, q]));
  }
  function gradeModule(attempt: Attempt, m: AttemptModuleState, questions: Map<string, Question>) {
    for (const id of m.questionIds) {
      const q = questions.get(id), r = attempt.responses[id];
      if (q && r && q.answer.kind !== "rubric") r.correct = gradeResponse(q, r.answer);
      if (q && r && q.answer.kind === "rubric") r.correct = null;
    }
  }
  /** Submit the current module and move on (routing, breaks, finishing). */
  function advance(attempt: Attempt, p: ExamProfile, now: number): void {
    const index = attempt.current.module;
    const m = attempt.modules[index];
    if (!m) return;
    const questions = questionMap(attempt);
    if (!m.submittedAt) { m.submittedAt = new Date(now).toISOString(); delete m.pausedAt; gradeModule(attempt, m, questions); }
    const next = attempt.modules[index + 1];
    if (!next) { finish(attempt, p); return; }
    routeModule(attempt, p, index + 1, questions);
    attempt.current = { module: index + 1, question: 0 };
    const { section } = moduleSpec(p, m);
    if (next.sectionId !== m.sectionId && section.breakAfterMinutes) attempt.breakUntil = new Date(now + section.breakAfterMinutes * 60_000).toISOString();
    else next.startedAt = new Date(now).toISOString();
  }
  function finish(attempt: Attempt, p: ExamProfile): void {
    const now = nowIso();
    const questions = questionMap(attempt);
    for (const m of attempt.modules) {
      if (!m.startedAt) m.startedAt = now;
      if (!m.submittedAt) { m.submittedAt = now; delete m.pausedAt; }
      gradeModule(attempt, m, questions);
    }
    delete attempt.breakUntil;
    // Rubric questions → essay-grader tasks.
    const grading: Record<string, string> = { ...(attempt.grading ?? {}) };
    let model: Promise<import("learnharness-plugin-api").PluginModelSpec> | undefined;
    const pendingStarts: { q: Question; text: string }[] = [];
    for (const q of questions.values()) {
      const r = attempt.responses[q.id];
      if (q.answer.kind !== "rubric" || grading[q.id] || !r || typeof r.answer !== "string" || !r.answer.trim()) continue;
      pendingStarts.push({ q, text: r.answer });
    }
    attempt.status = pendingStarts.length || Object.keys(grading).some(id => typeof attempt.responses[id]?.points !== "number") ? "submitted" : "scored";
    attempt.score = scoreAttempt(p, attempt, questions);
    if (pendingStarts.length) {
      model = bank.resolveModel();
      void model.then(spec => {
        const started: Record<string, string> = {};
        for (const { q, text } of pendingStarts) {
          if (q.answer.kind !== "rubric") continue;
          try {
            const task = ctx.workers.start(SIM_WORKERS.grader, {
              requestId: `grade:${attempt.id}:${q.id}`, purpose: "user", model: spec, maxTurns: 4, timeoutMs: 200_000,
              input: { maxPoints: q.answer.maxPoints },
              prompt: `## Task\n${q.passage ? `${q.passage}\n\n` : ""}${q.stem}\n\n## Rubric (max ${q.answer.maxPoints} points)\n${q.answer.rubric}\n\n## Learner's response (${text.trim().split(/\s+/).length} words)\n${text}`,
            });
            started[q.id] = task.id;
          } catch { /* grading can be retried from the results page */ }
        }
        store.change(draft => { const a = draft.attempts[attempt.id]; if (a) a.grading = { ...(a.grading ?? {}), ...started }; });
        notify();
      }).catch(error => {
        store.change(draft => { const a = draft.attempts[attempt.id]; if (a) a.notes = `${a.notes ? `${a.notes}\n` : ""}Essay grading could not start: ${(error as Error).message}`; });
      });
    }
    attempt.grading = grading;
    // Stats for per-skill mastery in the bank.
    try {
      bank.recordResponses(Object.values(attempt.responses).filter(r => questions.has(r.questionId) && r.answer !== undefined && r.answer !== "").map(r => ({ questionId: r.questionId, correct: r.correct ?? null, seconds: r.seconds })));
    } catch { /* stats are best effort */ }
  }
  /** Bring an attempt up to date: preparation, expired clocks, grading results. */
  function reconcile(id: string): Attempt {
    const current = store.get().attempts[id] ?? fail("That attempt no longer exists.");
    const now = Date.now();
    const needs = current.status === "preparing" || (current.status === "in-progress" && current.modules.some(m => isExpired(m, now))) || (current.status === "submitted");
    if (!needs) return current;
    let changed = false;
    const updated = store.change(draft => {
      const a = draft.attempts[id]!;
      const p = profile(a.setup.profileId);
      if (a.status === "preparing") {
        const jobs = (a.prepJobs ?? []).map(j => bank.job(j));
        const done = jobs.filter(j => !j || ["succeeded", "failed", "cancelled"].includes(j.status)).length;
        a.preparing = { jobIds: a.prepJobs ?? [], done, total: jobs.length };
        const timedOut = a.prepStartedAt && now - Date.parse(a.prepStartedAt) > PREP_TIMEOUT_MS;
        if (done === jobs.length || timedOut) {
          assemble(a, p, undefined);
          a.status = a.modules.some(m => m.questionIds.length || moduleSpec(p, m).spec.adaptive) ? "ready" : "abandoned";
          if (a.status === "abandoned") a.notes = "No questions could be found or written for this test. Add questions in the Question Bank and try again.";
        }
        changed = true;
      }
      if (a.status === "in-progress") {
        let guard = 0;
        while (a.status === "in-progress" && guard++ < 20) {
          const m = a.modules[a.current.module];
          if (!m || !isExpired(m, now)) break;
          advance(a, p, now); changed = true;
        }
      }
      if (a.status === "submitted") {
        const questions = questionMap(a);
        let pending = false;
        for (const [qid, taskId] of Object.entries(a.grading ?? {})) {
          const r = a.responses[qid];
          if (!r || typeof r.points === "number") continue;
          const task = safeTask(taskId);
          if (task?.status === "succeeded") {
            const result = task.result as { points: number; feedback: string; criteria?: { name: string; score: number; comment?: string }[] };
            r.points = result.points;
            r.feedback = `${result.feedback}${result.criteria?.length ? `\n\n${result.criteria.map(c => `- **${c.name}:** ${c.score}${c.comment ? ` — ${c.comment}` : ""}`).join("\n")}` : ""}`;
            changed = true;
          } else if (!task || ["failed", "cancelled", "interrupted"].includes(task.status)) {
            r.points = 0; r.feedback = `Automatic grading failed${task?.error?.message ? `: ${task.error.message}` : ""}. Compare your answer with the rubric.`; changed = true;
          } else pending = true;
        }
        const ungraded = [...questions.values()].some(q => q.answer.kind === "rubric" && typeof a.responses[q.id]?.answer === "string" && String(a.responses[q.id]?.answer).trim() && !(a.grading ?? {})[q.id]);
        if (!pending && !ungraded) { a.status = "scored"; changed = true; }
        a.score = scoreAttempt(p, a, questions);
      }
      if (changed) { a.revision++; a.updatedAt = nowIso(); }
      return a;
    });
    if (changed) notify();
    return updated;
  }

  function view(a: Attempt) {
    const p = profiles().find(x => x.id === a.setup.profileId);
    const now = Date.now();
    const m = a.modules[a.current.module];
    const finished = a.status === "scored" || a.status === "submitted" || a.status === "abandoned";
    const section = m && p ? p.sections.find(s => s.id === m.sectionId) : undefined;
    const spec = section?.modules.find(x => x.id === m?.moduleId);
    const live = a.status === "in-progress" && m && !a.breakUntil ? bank.get(m.questionIds).map(sanitize) : [];
    return {
      attempt: a,
      profile: p ? { id: p.id, name: p.name, scoring: p.scoring, rules: p.rules ?? [] } : undefined,
      modules: a.modules.map(x => {
        const s = p?.sections.find(y => y.id === x.sectionId);
        return { sectionId: x.sectionId, sectionName: s?.name ?? x.sectionId, moduleName: s?.modules.find(y => y.id === x.moduleId)?.name ?? x.moduleId, count: x.questionIds.length, planned: x.planned ?? x.questionIds.length, minutes: Math.round(x.timeLimitSeconds / 60), route: x.route, submitted: !!x.submittedAt };
      }),
      current: !finished && m ? {
        sectionName: section?.name ?? m.sectionId, moduleName: spec?.name ?? m.moduleId, subject: section?.subject ?? "",
        tools: a.setup.tools.filter(t => a.setup.mode === "practice" || (section?.tools ?? []).includes(t)),
        referenceSheet: section?.referenceSheet, remainingSeconds: remainingSeconds(m, now), timeLimitSeconds: m.timeLimitSeconds,
        paused: !!m.pausedAt, questions: live, breakUntil: a.breakUntil,
        nextSection: a.breakUntil ? p?.sections.find(s => s.id === a.modules[a.current.module]?.sectionId)?.name : undefined,
      } : undefined,
      serverTime: nowIso(),
    };
  }

  const mutateAttempt = <R>(id: string, fn: (a: SimState["attempts"][string], p: ExamProfile) => R): R => {
    reconcile(id);
    const result = store.change(draft => {
      const a = draft.attempts[id] ?? fail("That attempt no longer exists.");
      const r = fn(a, profile(a.setup.profileId));
      a.revision++; a.updatedAt = nowIso();
      return r;
    });
    notify();
    return result;
  };

  function createAttempt(input: Record<string, unknown>): Attempt {
    const p = profile(str(input.profileId));
    const sections = sectionsOf(p, Array.isArray(input.sectionIds) ? input.sectionIds.map(String) : []);
    const mode = input.mode === "practice" ? "practice" : "strict";
    const multiplier = mode === "strict" ? 1 : [0, 1, 1.25, 1.5, 2].includes(Number(input.timeMultiplier)) ? Number(input.timeMultiplier) : 1;
    const official = [...new Set(sections.flatMap(s => s.tools))];
    const requested = Array.isArray(input.tools) ? input.tools.map(String).filter((t): t is ToolId => (TOOLS as readonly string[]).includes(t)) : official;
    const setup: AttemptSetup = {
      profileId: p.id, sectionIds: sections.map(s => s.id), mode, timeMultiplier: multiplier,
      tools: mode === "strict" ? official : [...new Set(requested)],
      questionCountScale: Math.min(1, Math.max(0.05, Number(input.questionCountScale) || 1)),
      allowUnverified: typeof input.allowUnverified === "boolean" ? input.allowUnverified : mode === "practice",
      generate: input.generate !== false,
    };
    const now = nowIso();
    const attempt: SimState["attempts"][string] = {
      id: newId("att"), revision: 1, setup, status: "ready", current: { module: 0, question: 0 }, responses: {}, createdAt: now, updatedAt: now,
      modules: sections.flatMap(s => s.modules.map(m => ({ sectionId: s.id, moduleId: m.id, questionIds: [], timeLimitSeconds: moduleSeconds(m, setup, moduleCount(m, setup)), planned: moduleCount(m, setup) }))),
    };
    const shortages: Shortage[] = [];
    assemble(attempt, p, shortages);
    const missing = shortages.reduce((n, s) => n + s.missing, 0);
    if (missing && setup.generate) {
      const jobs = startGeneration(p, shortages);
      if (jobs.length) { attempt.status = "preparing"; attempt.prepJobs = jobs; attempt.prepStartedAt = now; attempt.preparing = { jobIds: jobs, done: 0, total: jobs.length }; }
    }
    if (attempt.status === "ready" && !attempt.modules.some(m => m.questionIds.length)) fail("The bank has no questions for this test yet. Turn on “write missing questions with AI”, or add questions in the Question Bank.");
    store.change(draft => { draft.attempts[attempt.id] = attempt; });
    notify();
    return attempt;
  }

  // ── profile builder ────────────────────────────────────────────────────
  async function buildProfile(input: Record<string, unknown>): Promise<ProfileBuild> {
    const name = str(input.name) || fail("Name the exam (for example “Kenya KCSE Mathematics” or “TOEFL iBT”).");
    const request = { name, ...(str(input.country) ? { country: str(input.country) } : {}), ...(str(input.notes) ? { notes: str(input.notes) } : {}) };
    const build: ProfileBuild = { id: newId("build"), status: "searching", request, requestId: newId("pb"), sources: [], createdAt: nowIso(), updatedAt: nowIso() };
    store.change(draft => { draft.builds[build.id] = build; });
    notify();
    let notes = "";
    try {
      const results = await searchWeb(`${name} ${request.country ?? ""} exam format sections number of questions time allowed scoring`, {}, { signal: ctx.signal, timeoutMs: 12_000 });
      build.sources = results.slice(0, 6).map(r => ({ title: r.title, url: r.url }));
      notes += results.slice(0, 8).map(r => `- ${r.title} (${r.url}): ${r.description ?? ""}`).join("\n");
      for (const r of results.slice(0, 2)) {
        try { const page = await fetchPage(r.url, { signal: ctx.signal, timeoutMs: 12_000 }); notes += `\n\n### ${page.title} (${page.url})\n${page.text.slice(0, 6000)}`; }
        catch { /* skip unreadable pages */ }
      }
    } catch (error) { notes += `\n(Web research was unavailable: ${(error as Error).message}. Use your own knowledge and say so in the rules.)`; }
    try {
      const model = await bank.resolveModel();
      const task = ctx.workers.start(SIM_WORKERS.builder, {
        requestId: build.requestId, purpose: "user", model, maxTurns: 5, timeoutMs: 220_000, input: request,
        prompt: `Build a simulator profile for: **${name}**${request.country ? ` (${request.country})` : ""}.\n${request.notes ? `Learner's notes: ${request.notes}\n` : ""}\n## Research notes\n${notes || "(none)"}`,
      });
      build.taskId = task.id; build.status = "running";
    } catch (error) { build.status = "failed"; build.error = (error as Error).message; }
    build.updatedAt = nowIso();
    store.change(draft => { draft.builds[build.id] = build; });
    notify();
    return build;
  }
  function reconcileBuild(id: string): ProfileBuild {
    const build = store.get().builds[id] ?? fail("That profile build no longer exists.");
    if (build.status !== "running") return build;
    const task = safeTask(build.taskId);
    if (!task || ["queued", "running"].includes(task.status)) {
      if (Date.now() - Date.parse(build.updatedAt) < 6 * 60_000) return build;
    }
    return store.change(draft => {
      const b = draft.builds[id]!;
      if (task?.status === "succeeded") {
        const r = task.result as { profile: ExamProfile; skills: { section: string; domain: string; name: string }[] };
        const base = slug(r.profile.id || b.request.name).slice(0, 40) || "custom-exam";
        const taken = new Set(profiles().map(p => p.id));
        let pid = base, n = 2;
        while (taken.has(pid)) pid = `${base}-${n++}`;
        const p: ExamProfile = { ...r.profile, id: pid, builtIn: false, revision: 1, updatedAt: nowIso(), sourceUrls: [...new Set([...(r.profile.sourceUrls ?? []), ...b.sources.map(s => s.url)])] };
        b.profile = p;
        b.skills = r.skills.map(s => ({ id: `${pid}.${slug(s.section)}.${slug(s.domain)}.${slug(s.name)}`, exam: pid, domain: s.domain, name: s.name }));
        b.status = "ready";
      } else { b.status = "failed"; b.error = task?.error?.message ?? "The profile builder did not finish. Try again."; }
      b.updatedAt = nowIso();
      return b;
    });
  }

  // ── operations ─────────────────────────────────────────────────────────
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    "sim.profiles": () => {
      const attempts = Object.values(store.get().attempts);
      return profiles().map(p => {
        const verified = bank.query({ exam: p.id, limit: 500 }).length;
        const mine = attempts.filter(a => a.setup.profileId === p.id && a.status === "scored").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return {
          id: p.id, name: p.name, country: p.country, organization: p.organization, description: p.description, builtIn: p.builtIn,
          sections: p.sections.map(s => ({ id: s.id, name: s.name, questions: s.modules.reduce((n, m) => n + m.questionCount, 0), minutes: s.modules.reduce((n, m) => n + m.minutes, 0), tools: s.tools, notSimulated: s.notSimulated })),
          verifiedQuestions: verified, attempts: mine.length, best: mine.length ? Math.max(...mine.map(a => a.score?.total ?? 0)) : undefined, scoreLabel: p.scoring.label,
        };
      });
    },
    "sim.profile": input => profile(str(input.id)),
    "sim.saveProfile": input => {
      const raw = (isObject(input.profile) ? input.profile : input) as unknown as ExamProfile;
      const builtIn = BUILT_IN_PROFILES.some(b => b.id === raw.id);
      const existing = store.get().profiles[raw.id];
      const p: ExamProfile = { ...raw, builtIn, revision: (existing?.revision ?? 0) + 1, updatedAt: nowIso() };
      assertProfile(p);
      const skills = Array.isArray(input.skills) ? (input.skills as Skill[]).filter(s => isObject(s) && s.id && s.exam === p.id && s.domain && s.name) : [];
      if (skills.length) bank.upsertSkills(skills);
      store.change(draft => {
        draft.profiles[p.id] = p; draft.hidden = draft.hidden.filter(h => h !== p.id);
        if (str(input.buildId) && draft.builds[str(input.buildId)]) draft.builds[str(input.buildId)]!.status = "saved";
      });
      notify();
      return p;
    },
    "sim.deleteProfile": input => {
      const id = str(input.id);
      store.change(draft => {
        const builtIn = BUILT_IN_PROFILES.some(b => b.id === id);
        if (builtIn && draft.profiles[id] && !input.hide) delete draft.profiles[id];   // reset an edited built-in
        else if (builtIn) draft.hidden = [...new Set([...draft.hidden, id])];
        else delete draft.profiles[id];
      });
      notify();
      return { ok: true };
    },
    "sim.restoreProfiles": () => { store.change(draft => { draft.hidden = []; }); notify(); return { ok: true }; },
    "sim.buildProfile": input => buildProfile(input),
    "sim.builds": () => Object.keys(store.get().builds).map(reconcileBuild).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    "sim.build": input => reconcileBuild(str(input.id)),
    "sim.deleteBuild": input => { store.change(draft => { delete draft.builds[str(input.id)]; }); return { ok: true }; },
    "sim.suggestTools": input => {
      const p = profile(str(input.profileId));
      const sections = sectionsOf(p, Array.isArray(input.sectionIds) ? input.sectionIds.map(String) : []);
      const official = [...new Set(sections.flatMap(s => s.tools))];
      const mathy = sections.some(s => /math|physics|chem|quant|science|economics/i.test(`${s.subject} ${s.name}`));
      const practice = [...new Set<ToolId>([...official, "notes", "highlighter", "answer-eliminator", ...(mathy && !official.some(t => t.endsWith("calculator")) ? (["scientific-calculator"] as ToolId[]) : [])])];
      return { official, practice, perSection: Object.fromEntries(sections.map(s => [s.id, s.tools])) };
    },
    "sim.createAttempt": input => view(createAttempt(input)),
    "sim.attempt": input => view(reconcile(str(input.id))),
    "sim.start": input => view(mutateAttempt(str(input.id), (a, p) => {
      if (a.status === "preparing") {
        // Start with what is there; remaining generation keeps filling the bank.
        assemble(a, p, undefined);
        if (!a.modules.some(m => m.questionIds.length || moduleSpec(p, m).spec.adaptive)) fail("No questions are ready yet. Wait for preparation to finish.");
        a.status = "ready";
      }
      if (a.status === "ready") {
        a.status = "in-progress";
        // Skip modules that have no questions (e.g. an empty bank for that section).
        while (a.modules[a.current.module] && !a.modules[a.current.module]!.questionIds.length && !moduleSpec(p, a.modules[a.current.module]!).spec.adaptive) a.current.module++;
        const m = a.modules[a.current.module] ?? fail("This test has no questions.");
        m.startedAt ??= nowIso();
      } else if (a.status === "in-progress" && a.breakUntil) {
        delete a.breakUntil;
        const m = a.modules[a.current.module];
        if (m) m.startedAt ??= nowIso();
      } else if (a.status !== "in-progress") fail("This attempt is already finished.");
      return a;
    })),
    "sim.answer": input => mutateAttempt(str(input.id), (a) => {
      if (a.status !== "in-progress" || a.breakUntil) fail("This module is not open for answers.");
      const m = a.modules[a.current.module] ?? fail("No module is open.");
      if (m.pausedAt) fail("The test is paused. Resume to keep answering.");
      if (isExpired(m, Date.now())) fail("Time is up for this module.");
      const questionId = str(input.questionId);
      if (!m.questionIds.includes(questionId)) fail("That question is not in the current module.");
      const prev = a.responses[questionId];
      a.responses[questionId] = {
        questionId, answer: "answer" in input ? input.answer : prev?.answer, flagged: typeof input.flagged === "boolean" ? input.flagged : prev?.flagged ?? false,
        ...(Array.isArray(input.eliminated) ? { eliminated: input.eliminated.map(String) } : prev?.eliminated ? { eliminated: prev.eliminated } : {}),
        seconds: Math.max(prev?.seconds ?? 0, Math.min(36_000, Number(input.seconds) || 0)),
      };
      if (typeof input.position === "number") a.current.question = Math.max(0, Math.min(m.questionIds.length - 1, Math.floor(input.position)));
      return { ok: true, savedAt: nowIso() };
    }),
    "sim.notes": input => mutateAttempt(str(input.id), a => { a.notes = String(input.notes ?? "").slice(0, 20_000); return { ok: true }; }),
    "sim.submitModule": input => view(mutateAttempt(str(input.id), (a, p) => {
      if (a.status !== "in-progress") fail("This attempt is not in progress.");
      if (a.breakUntil) fail("Resume after the break first.");
      advance(a, p, Date.now());
      return a;
    })),
    "sim.finish": input => view(mutateAttempt(str(input.id), (a, p) => {
      if (a.status === "scored" || a.status === "submitted") return a;
      if (a.status === "abandoned") fail("This attempt was abandoned.");
      finish(a, p);
      return a;
    })),
    "sim.pause": input => view(mutateAttempt(str(input.id), a => {
      if (a.setup.mode !== "practice") fail("Pausing is only available in practice mode — the real exam does not stop.");
      const m = a.modules[a.current.module] ?? fail("No module is open.");
      if (input.resume) { if (m.pausedAt) { m.pausedSeconds = (m.pausedSeconds ?? 0) + (Date.now() - Date.parse(m.pausedAt)) / 1000; delete m.pausedAt; } }
      else if (!m.pausedAt && m.startedAt && !m.submittedAt) m.pausedAt = nowIso();
      return a;
    })),
    "sim.abandon": input => view(mutateAttempt(str(input.id), a => { if (a.status !== "scored") a.status = "abandoned"; return a; })),
    "sim.deleteAttempt": input => { store.change(draft => { delete draft.attempts[str(input.id)]; }); notify(); return { ok: true }; },
    "sim.review": input => {
      const a = reconcile(str(input.id));
      if (!["scored", "submitted"].includes(a.status)) fail("Finish the test to see the review.");
      const p = profiles().find(x => x.id === a.setup.profileId);
      const questions = bank.get(a.modules.flatMap(m => m.questionIds));
      const skills = new Map(bank.skills(a.setup.profileId).map(s => [s.id, s]));
      return { ...view(a), questions, skills: Object.fromEntries([...new Set(questions.map(q => q.skillId))].map(id => [id, skills.get(id) ?? { id, exam: a.setup.profileId, domain: "", name: id }])), sections: p?.sections.map(s => ({ id: s.id, name: s.name })) ?? [] };
    },
    "sim.history": () => Object.values(store.get().attempts).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(a => {
      const p = profiles().find(x => x.id === a.setup.profileId);
      return { id: a.id, profileId: a.setup.profileId, profileName: p?.name ?? a.setup.profileId, status: a.status, mode: a.setup.mode, sections: a.setup.sectionIds.map(id => p?.sections.find(s => s.id === id)?.name ?? id), score: a.score, scoreLabel: p?.scoring.label, createdAt: a.createdAt, updatedAt: a.updatedAt, questions: a.modules.reduce((n, m) => n + m.questionIds.length, 0) };
    }),
  };
  for (const [name, handler] of Object.entries(handlers)) ctx.handle(name, input => handler(isObject(input) ? input : {}));

  // ── tutor tools: results + let the AI prepare a test ───────────────────────
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: value });
  ctx.registerTools({
    agents: ["teacher", "practice"],
    create: () => [
      {
        name: "exam_results_recent", label: "Recent exam results",
        description: "The learner's recent Exam Simulator results: exam, score, section scores and their weakest skills. Use it to plan what to teach next.",
        parameters: Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
        execute: async (_id: string, params: Record<string, unknown>) => {
          const scored = Object.values(store.get().attempts).filter(a => a.score && (a.status === "scored" || a.status === "submitted")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, Math.min(10, Number(params.limit) || 3)));
          if (!scored.length) return text("The learner has not finished any simulated exam yet.");
          return text(scored.map(a => {
            const p = profiles().find(x => x.id === a.setup.profileId);
            const skills = new Map(bank.skills(a.setup.profileId).map(s => [s.id, s]));
            const weak = Object.entries(a.score!.skills).filter(([, s]) => s.total >= 1).sort((x, y) => x[1].correct / x[1].total - y[1].correct / y[1].total).slice(0, 6)
              .map(([id, s]) => ({ skill: skills.get(id)?.name ?? id, domain: skills.get(id)?.domain, correct: Math.round(s.correct * 10) / 10, total: s.total }));
            return { exam: p?.name ?? a.setup.profileId, date: a.updatedAt, mode: a.setup.mode, total: a.score!.total, band: a.score!.band, scale: p?.scoring.label, sections: a.score!.sections, weakestSkills: weak };
          }));
        },
      },
      {
        name: "exam_prepare_test", label: "Prepare a practice test",
        description: "Prepare a simulated exam for the learner in Exam Simulator: choose the exam profile, sections, strict or practice mode, length and which tools are allowed (e.g. the graphing calculator for SAT Math). Missing questions are written in the background. The learner then opens Exam Simulator to take it.",
        parameters: Type.Object({
          exam: Type.String({ description: `Profile id: ${BUILT_IN_PROFILES.map(p => p.id).join(", ")} or a custom profile id` }),
          sections: Type.Optional(Type.Array(Type.String(), { description: "Section ids; omit for the full test" })),
          mode: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("practice")])),
          length: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1, description: "Fraction of the official question count (1 = full length)" })),
          timeMultiplier: Type.Optional(Type.Number({ description: "Practice only: 1, 1.25, 1.5, 2, or 0 for untimed" })),
          tools: Type.Optional(Type.Array(Type.String(), { description: `Practice only: allowed tools from ${TOOLS.join(", ")}` })),
        }),
        execute: async (_id: string, params: Record<string, unknown>) => {
          try {
            const a = createAttempt({ profileId: params.exam, sectionIds: params.sections ?? [], mode: params.mode ?? "practice", questionCountScale: params.length ?? 1, timeMultiplier: params.timeMultiplier ?? 1, ...(Array.isArray(params.tools) ? { tools: params.tools } : {}) });
            const p = profile(a.setup.profileId);
            return text({ attemptId: a.id, exam: p.name, status: a.status, questions: a.modules.reduce((n, m) => n + (m.planned ?? m.questionIds.length), 0), tools: a.setup.tools, mode: a.setup.mode, message: "Tell the learner to open Exam Simulator (sidebar) — the test is listed under “Your tests”." });
          } catch (error) { return text(`Could not prepare the test: ${(error as Error).message}`); }
        },
      },
    ],
  });
  ctx.registerInstructions({
    agents: ["teacher", "practice"],
    text: "Exam Simulator is installed. Use exam_results_recent to see the learner's latest simulated exam scores and weakest skills, and teach those skills first. When the learner wants a mock test, use exam_prepare_test (choose sections, mode, length and the allowed tools exactly as the exam allows, or extra tools for practice) and tell them to open Exam Simulator.",
  });
}

export type { QuestionFormat };
