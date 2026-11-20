// Exam Simulator engine: pure functions for assembly (blueprint → bank questions),
// adaptive routing, the server-side clock and scoring. No I/O; unit-tested.
import {
  gradeResponse, scale, type Attempt, type AttemptModuleState, type AttemptSetup, type BankApi, type ExamProfile, type ModuleSpec,
  type Question, type QuestionFormat, type ScoreScale, type SectionSpec, type Skill,
} from "../shared/contract.ts";

/** Largest-remainder split of `total` by shares (keys keep their order). */
export function apportion<K extends string>(total: number, shares: { key: K; share: number }[]): Map<K, number> {
  const out = new Map<K, number>();
  const positive = shares.filter(s => s.share > 0);
  const sum = positive.reduce((n, s) => n + s.share, 0);
  if (!positive.length || sum <= 0 || total <= 0) return out;
  const raw = positive.map(s => ({ key: s.key, exact: (s.share / sum) * total }));
  let used = 0;
  for (const r of raw) { const n = Math.floor(r.exact); out.set(r.key, n); used += n; }
  for (const r of [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1)).slice(0, total - used)) out.set(r.key, (out.get(r.key) ?? 0) + 1);
  return out;
}

export function moduleCount(module: ModuleSpec, setup: Pick<AttemptSetup, "questionCountScale">): number {
  const scaleBy = Math.min(1, Math.max(0.05, setup.questionCountScale ?? 1));
  return Math.max(1, Math.round(module.questionCount * scaleBy));
}

export function moduleSeconds(module: ModuleSpec, setup: Pick<AttemptSetup, "timeMultiplier" | "questionCountScale">, count: number): number {
  if (!setup.timeMultiplier || !module.minutes) return 0;
  // Shorter custom tests keep the official time per question.
  const perQuestion = (module.minutes * 60) / module.questionCount;
  return Math.round(perQuestion * count * setup.timeMultiplier);
}

/** Skills of one section of a profile (built-in ids are exam.section.domain.name). */
export function sectionSkills(skills: Skill[], profile: ExamProfile, section: SectionSpec): Skill[] {
  const prefix = `${profile.id}.${section.id}.`;
  const domains = new Set((section.modules.flatMap(m => m.blueprint ?? [])).map(b => b.domain));
  const own = skills.filter(s => s.exam === profile.id && s.id.startsWith(prefix));
  return own.length ? own : skills.filter(s => s.exam === profile.id && domains.has(s.domain));
}

export interface Slot { domain: string; format: QuestionFormat; difficulty: number[] }
export interface Shortage { domain: string; format: QuestionFormat; difficulty: number[]; missing: number; skillIds: string[] }

/** Blueprint slots for one module (domains × formats). */
export function moduleSlots(module: ModuleSpec, count: number, difficulty: number[], sectionDomains: string[]): Slot[] {
  const blueprint = module.blueprint?.length ? module.blueprint : sectionDomains.map(domain => ({ domain, share: 1 }));
  const domains = apportion(count, blueprint.map(b => ({ key: b.domain, share: b.share })));
  const formats = apportion(count, module.formats.map(f => ({ key: f.format, share: f.share })));
  // Deal formats round-robin across domains so every domain sees the format mix.
  const formatQueue: QuestionFormat[] = [];
  for (const [format, n] of formats) for (let i = 0; i < n; i++) formatQueue.push(format);
  const domainQueue: string[] = [];
  const left = new Map(domains);
  while (domainQueue.length < count && [...left.values()].some(n => n > 0)) {
    for (const [domain, n] of left) if (n > 0) { domainQueue.push(domain); left.set(domain, n - 1); }
  }
  return domainQueue.map((domain, i) => ({ domain, format: formatQueue[i % Math.max(1, formatQueue.length)] ?? module.formats[0]?.format ?? "mcq", difficulty }));
}

/** Deterministic shuffle (seeded) so a reassembly picks the same order. */
export function shuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    const j = (h >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Fill slots from the bank; returns question ids (slot order) and what is missing. */
export function pickQuestions(bank: Pick<BankApi, "query" | "skills">, profile: ExamProfile, section: SectionSpec, slots: Slot[], opts: { allowUnverified: boolean; exclude: Set<string>; seed: string }): { ids: string[]; shortages: Shortage[] } {
  const skills = sectionSkills(bank.skills(profile.id), profile, section);
  const byDomain = new Map<string, string[]>();
  for (const s of skills) byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s.id]);
  const status = opts.allowUnverified ? (["verified", "unverified"] as const) : (["verified"] as const);
  const allSkillIds = skills.map(s => s.id);
  const pool = (skillIds: string[], formats: QuestionFormat[] | undefined, difficulty: number[] | undefined) => skillIds.length
    ? shuffle(bank.query({ exam: profile.id, skillIds, ...(formats ? { formats } : {}), ...(difficulty?.length ? { difficulty } : {}), status: [...status], excludeIds: [...opts.exclude], limit: 500 }), `${opts.seed}:${skillIds.length}:${formats?.join() ?? ""}:${difficulty?.join() ?? ""}`)
    : [];
  const ids: string[] = [];
  const missing = new Map<string, Shortage>();
  for (const slot of slots) {
    const domainSkills = byDomain.get(slot.domain) ?? [];
    // Relax step by step: exact → any difficulty → any format in the module → any domain of the section.
    const tries: [string[], QuestionFormat[] | undefined, number[] | undefined][] = [
      [domainSkills, [slot.format], slot.difficulty], [domainSkills, [slot.format], undefined], [domainSkills, undefined, slot.difficulty],
      [allSkillIds, [slot.format], slot.difficulty], [domainSkills, undefined, undefined], [allSkillIds, undefined, undefined],
    ];
    let found: Question | undefined;
    for (const [skillIds, formats, difficulty] of tries) {
      found = pool(skillIds, formats, difficulty).find(q => !opts.exclude.has(q.id));
      if (found) break;
    }
    if (found) { ids.push(found.id); opts.exclude.add(found.id); }
    const key = `${slot.domain}|${slot.format}`;
    if (!found || !domainSkills.length || found.format !== slot.format || !domainSkills.includes(found.skillId)) {
      // Count as a shortage of the exact kind (even if a substitute filled it) only when nothing was found.
      if (!found) {
        const entry = missing.get(key) ?? { domain: slot.domain, format: slot.format, difficulty: slot.difficulty, missing: 0, skillIds: domainSkills.length ? domainSkills : allSkillIds };
        entry.missing++; missing.set(key, entry);
      }
    }
  }
  return { ids, shortages: [...missing.values()] };
}

export function sectionDomains(profile: ExamProfile, section: SectionSpec, skills: Skill[]): string[] {
  const fromBlueprint = [...new Set(section.modules.flatMap(m => m.blueprint ?? []).map(b => b.domain))];
  return fromBlueprint.length ? fromBlueprint : [...new Set(sectionSkills(skills, profile, section).map(s => s.domain))];
}

// ── clock ──────────────────────────────────────────────────────────────────
export function elapsedSeconds(module: AttemptModuleState, now: number): number {
  if (!module.startedAt) return 0;
  const end = module.submittedAt ? Date.parse(module.submittedAt) : module.pausedAt ? Date.parse(module.pausedAt) : now;
  return Math.max(0, (end - Date.parse(module.startedAt)) / 1000 - (module.pausedSeconds ?? 0));
}

/** Remaining seconds, or undefined when untimed. */
export function remainingSeconds(module: AttemptModuleState, now: number): number | undefined {
  if (!module.timeLimitSeconds) return undefined;
  return Math.max(0, module.timeLimitSeconds - elapsedSeconds(module, now));
}

/** Seconds of grace after the deadline for answers that were in flight. */
export const GRACE_SECONDS = 5;

export function isExpired(module: AttemptModuleState, now: number): boolean {
  return !!module.timeLimitSeconds && !module.submittedAt && !module.pausedAt && elapsedSeconds(module, now) >= module.timeLimitSeconds + GRACE_SECONDS;
}

// ── adaptive routing ─────────────────────────────────────────────────────────
export function moduleFraction(attempt: Attempt, moduleIndex: number, questions: Map<string, Question>): number {
  const m = attempt.modules[moduleIndex];
  if (!m || !m.questionIds.length) return 0;
  let points = 0;
  for (const id of m.questionIds) {
    const q = questions.get(id);
    const r = attempt.responses[id];
    if (!q || !r) continue;
    const verdict = r.correct ?? gradeResponse(q, r.answer);
    if (verdict === true) points++;
  }
  return points / m.questionIds.length;
}

export function route(spec: NonNullable<ModuleSpec["adaptive"]>, fraction: number): { route: "easier" | "harder"; difficulty: number[] } {
  return fraction >= spec.threshold ? { route: "harder", difficulty: spec.harder } : { route: "easier", difficulty: spec.easier };
}

// ── scoring ──────────────────────────────────────────────────────────────────
/** Points earned for one response (0…1). Rubric answers use points / maxPoints. */
export function responsePoints(q: Question, r: Attempt["responses"][string] | undefined): { points: number; pending: boolean } {
  if (!r || r.answer === undefined || r.answer === null || r.answer === "") return { points: 0, pending: false };
  if (q.answer.kind === "rubric") {
    if (typeof r.points !== "number") return { points: 0, pending: true };
    return { points: Math.max(0, Math.min(1, r.points / q.answer.maxPoints)), pending: false };
  }
  const verdict = r.correct ?? gradeResponse(q, r.answer);
  return { points: verdict ? 1 : 0, pending: false };
}

/** The easier adaptive route caps the section (SAT-style): its points weigh less. */
export const EASIER_ROUTE_WEIGHT = 0.8;

export function bandFor(scoring: ScoreScale, total: number | undefined): string | undefined {
  if (total === undefined || !scoring.bands?.length) return undefined;
  return [...scoring.bands].sort((a, b) => b.min - a.min).find(b => total >= b.min)?.label;
}

export function scoreAttempt(profile: ExamProfile, attempt: Attempt, questions: Map<string, Question>): NonNullable<Attempt["score"]> {
  const sections: NonNullable<Attempt["score"]>["sections"] = {};
  const skills: NonNullable<Attempt["score"]>["skills"] = {};
  let pending = 0;
  const bySection = new Map<string, AttemptModuleState[]>();
  for (const m of attempt.modules) bySection.set(m.sectionId, [...(bySection.get(m.sectionId) ?? []), m]);
  const scaledList: number[] = [];
  for (const [sectionId, modules] of bySection) {
    let raw = 0, max = 0, weighted = 0, weightMax = 0;
    for (const m of modules) {
      const weight = m.route === "easier" ? EASIER_ROUTE_WEIGHT : 1;
      for (const id of m.questionIds) {
        const q = questions.get(id);
        if (!q) continue;
        const { points, pending: waiting } = responsePoints(q, attempt.responses[id]);
        if (waiting) pending++;
        raw += points; max += 1; weighted += points * weight; weightMax += 1;
        const s = skills[q.skillId] ?? { correct: 0, total: 0 };
        s.total += 1; s.correct += points; skills[q.skillId] = s;
      }
    }
    const per = profile.scoring.perSection?.[sectionId];
    const sectionScale: { min: number; max: number; step?: number; curve?: [number, number][] } = per ?? { min: profile.scoring.min, max: profile.scoring.max, step: profile.scoring.step, curve: profile.scoring.curve };
    const fraction = weightMax ? weighted / weightMax : 0;
    const scaled = scale(fraction, { ...sectionScale, step: per ? (profile.scoring.step ?? 1) : sectionScale.step });
    sections[sectionId] = { raw: Math.round(raw * 100) / 100, max, scaled };
    scaledList.push(scaled);
  }
  let total: number | undefined;
  const step = profile.scoring.step ?? 1;
  if (scaledList.length) {
    if (profile.scoring.combine === "sum") total = scaledList.reduce((a, b) => a + b, 0);
    else if (profile.scoring.combine === "average" || !profile.scoring.combine) total = Math.round(scaledList.reduce((a, b) => a + b, 0) / scaledList.length / step) * step;
  }
  const band = bandFor(profile.scoring, total);
  return { ...(total !== undefined ? { total } : {}), ...(band ? { band } : {}), ...(pending ? { pending } : {}), sections, skills };
}
