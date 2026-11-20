import assert from "node:assert/strict";
import { test } from "node:test";
import { activateBankBackend } from "../src/bank/backend.ts";
import { BUILT_IN_EXAMS } from "../src/shared/exams.ts";
import type { Attempt, ExamProfile, Question } from "../src/shared/contract.ts";
import { activateSimBackend } from "../src/sim/backend.ts";
import { apportion, moduleSlots, remainingSeconds, route, scoreAttempt, shuffle } from "../src/sim/engine.ts";
import { assertProfile, BUILT_IN_PROFILES } from "../src/sim/profiles.ts";
import { STARTER_QUESTIONS } from "../src/bank/starter.ts";
import { fakeContext } from "./fake-context.ts";

test("built-in profiles are valid and their blueprint domains match the bank taxonomy", () => {
  assert.equal(BUILT_IN_PROFILES.length, 7);
  for (const p of BUILT_IN_PROFILES) {
    assertProfile(p);
    const exam = BUILT_IN_EXAMS.find(e => e.id === p.id);
    assert.ok(exam, p.id);
    for (const s of p.sections.filter(x => x.modules.length)) {
      const domains = exam.sections.find(x => x.id === s.id)?.domains ?? [];
      assert.ok(domains.length, `${p.id}.${s.id} missing from the catalog`);
      for (const m of s.modules) for (const b of m.blueprint ?? []) assert.ok(domains.includes(b.domain), `${p.id}.${s.id}: ${b.domain}`);
    }
  }
  const sat = BUILT_IN_PROFILES.find(p => p.id === "sat")!;
  assert.deepEqual(sat.sections.map(s => s.modules.map(m => [m.questionCount, m.minutes])), [[[27, 32], [27, 32]], [[22, 35], [22, 35]]]);
  assert.ok(sat.sections[1]!.tools.includes("graphing-calculator") && !sat.sections[0]!.tools.includes("graphing-calculator"));
});

test("apportion, slots, shuffle, routing and the clock", () => {
  assert.deepEqual([...apportion(10, [{ key: "a", share: 0.35 }, { key: "b", share: 0.35 }, { key: "c", share: 0.15 }, { key: "d", share: 0.15 }]).values()].reduce((a, b) => a + b, 0), 10);
  const slots = moduleSlots(BUILT_IN_PROFILES[0]!.sections[1]!.modules[0]!, 22, [1, 2, 3], []);
  assert.equal(slots.length, 22);
  assert.ok([5, 6].includes(slots.filter(s => s.format === "numeric").length));
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], "x"), shuffle([1, 2, 3, 4, 5], "x"));
  assert.equal(route({ from: "m1", threshold: 0.6, easier: [1, 2], harder: [4, 5] }, 0.7).route, "harder");
  assert.equal(route({ from: "m1", threshold: 0.6, easier: [1, 2], harder: [4, 5] }, 0.5).route, "easier");
  const start = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(remainingSeconds({ sectionId: "s", moduleId: "m", questionIds: [], timeLimitSeconds: 600, startedAt: new Date(start).toISOString(), pausedSeconds: 60 }, start + 120_000), 540);
  assert.equal(remainingSeconds({ sectionId: "s", moduleId: "m", questionIds: [], timeLimitSeconds: 0 }, start), undefined);
});

test("scoring: SAT sections sum, the easier route caps, bands and pending essays", () => {
  const sat = BUILT_IN_PROFILES.find(p => p.id === "sat")!;
  const qs = STARTER_QUESTIONS.filter(q => q.exams.includes("sat"));
  const map = new Map(qs.map(q => [q.id, q]));
  const math = qs.filter(q => q.subject === "Math"), rw = qs.filter(q => q.subject !== "Math");
  const key = (q: Question) => q.answer.kind === "choice" ? q.answer.correct : q.answer.kind === "numeric" ? String(q.answer.value) : "";
  const attempt: Attempt = {
    id: "a", revision: 1, status: "submitted", current: { module: 0, question: 0 }, createdAt: "", updatedAt: "",
    setup: { profileId: "sat", sectionIds: ["rw", "math"], mode: "strict", timeMultiplier: 1, tools: [] },
    modules: [{ sectionId: "rw", moduleId: "m1", questionIds: rw.map(q => q.id), timeLimitSeconds: 0 }, { sectionId: "math", moduleId: "m1", questionIds: math.map(q => q.id), timeLimitSeconds: 0 }],
    responses: Object.fromEntries(qs.map(q => [q.id, { questionId: q.id, answer: key(q), flagged: false, seconds: 10 }])),
  };
  const perfect = scoreAttempt(sat, attempt, map);
  assert.equal(perfect.total, 1600);
  assert.equal(perfect.sections.math!.scaled, 800);
  attempt.modules[1]!.route = "easier";
  assert.ok(scoreAttempt(sat, attempt, map).sections.math!.scaled! < 800);
  const ielts = BUILT_IN_PROFILES.find(p => p.id === "ielts-academic")!;
  const essay = STARTER_QUESTIONS.find(q => q.format === "essay")!;
  const eAttempt: Attempt = { ...attempt, setup: { ...attempt.setup, profileId: "ielts-academic" }, modules: [{ sectionId: "writing", moduleId: "m1", questionIds: [essay.id], timeLimitSeconds: 0 }], responses: { [essay.id]: { questionId: essay.id, answer: "My essay", flagged: false, seconds: 5 } } };
  assert.equal(scoreAttempt(ielts, eAttempt, new Map([[essay.id, essay]])).pending, 1);
  eAttempt.responses[essay.id]!.points = 7;
  assert.equal(scoreAttempt(ielts, eAttempt, new Map([[essay.id, essay]])).total, 7);
  const alevel: ExamProfile = BUILT_IN_PROFILES.find(p => p.id === "a-level-maths")!;
  assert.equal(scoreAttempt(alevel, { ...attempt, modules: [{ sectionId: "pure-2", moduleId: "m1", questionIds: [], timeLimitSeconds: 0 }] }, map).band, "U");
});

test("a full practice attempt: create, start, answer, adaptive routing, finish, review, history, tutor tool", async () => {
  const f = fakeContext();
  try {
    const bank = activateBankBackend(f.ctx);
    activateSimBackend(f.ctx, bank);
    const profiles = await f.call("sim.profiles");
    assert.equal(profiles.length, 7);
    const tools = await f.call("sim.suggestTools", { profileId: "sat", sectionIds: ["math"] });
    assert.ok(tools.official.includes("graphing-calculator"));

    // Short SAT Math practice, no generation: uses the starter questions.
    const created = await f.call("sim.createAttempt", { profileId: "sat", sectionIds: ["math"], mode: "practice", questionCountScale: 0.2, generate: false, tools: ["graphing-calculator", "notes"] });
    assert.equal(created.attempt.status, "ready");
    assert.deepEqual(created.attempt.setup.tools, ["graphing-calculator", "notes"]);
    let v = await f.call("sim.start", { id: created.attempt.id });
    assert.equal(v.attempt.status, "in-progress");
    assert.ok(v.current.questions.length >= 3);
    assert.ok(v.current.remainingSeconds > 0);
    for (const q of v.current.questions as Question[]) {
      assert.equal(q.explanation, "", "keys and explanations are hidden during the test");
      const real = STARTER_QUESTIONS.find(x => x.id === q.id)!;
      const answer = real.answer.kind === "choice" ? real.answer.correct[0] : real.answer.kind === "numeric" ? String(real.answer.value) : "";
      await f.call("sim.answer", { id: created.attempt.id, questionId: q.id, answer, seconds: 30 });
    }
    await assert.rejects(f.call("sim.answer", { id: created.attempt.id, questionId: "nope", answer: "A" }), /not in the current module/);
    v = await f.call("sim.pause", { id: created.attempt.id });
    assert.equal(v.current.paused, true);
    v = await f.call("sim.pause", { id: created.attempt.id, resume: true });
    v = await f.call("sim.submitModule", { id: created.attempt.id });
    // Module 1 was all correct → module 2 is routed harder.
    assert.equal(v.modules[1].route, "harder");
    assert.equal(v.attempt.current.module, 1);
    v = await f.call("sim.finish", { id: created.attempt.id });
    assert.equal(v.attempt.status, "scored");
    assert.ok(v.attempt.score.total >= 200);
    const review = await f.call("sim.review", { id: created.attempt.id });
    assert.ok(review.questions.length >= 3 && review.questions[0].explanation);
    const history = await f.call("sim.history");
    assert.equal(history[0].id, created.attempt.id);
    const [results] = f.tools().filter((t: any) => t.name === "exam_results_recent");
    const out = await results.execute("t", {});
    assert.equal(out.details[0].exam, "Digital SAT");

    // Strict mode ignores requested extra tools.
    const strict = await f.call("sim.createAttempt", { profileId: "sat", sectionIds: ["rw"], mode: "strict", questionCountScale: 0.1, generate: false, tools: ["graphing-calculator"] });
    assert.ok(!strict.attempt.setup.tools.includes("graphing-calculator"));
    await assert.rejects(f.call("sim.pause", { id: strict.attempt.id }), /practice mode/);
  } finally { f.dispose(); }
});

test("missing questions start bank authoring jobs and the attempt waits in preparing", async () => {
  const f = fakeContext();
  try {
    const bank = activateBankBackend(f.ctx);
    activateSimBackend(f.ctx, bank);
    const v = await f.call("sim.createAttempt", { profileId: "act", sectionIds: ["science"], mode: "practice", questionCountScale: 0.25 });
    assert.equal(v.attempt.status, "preparing");
    assert.ok(v.attempt.preparing.total >= 1 && v.attempt.preparing.total <= 12);
    const jobs = await f.call("bank.jobs");
    assert.ok(jobs.length >= 1 && jobs.every((j: any) => j.kind === "author"));
    // Starting early uses what exists.
    const started = await f.call("sim.start", { id: v.attempt.id });
    assert.equal(started.attempt.status, "in-progress");
  } finally { f.dispose(); }
});

test("custom profiles: save with skills, edit/reset built-ins, hide/restore", async () => {
  const f = fakeContext();
  try {
    const bank = activateBankBackend(f.ctx);
    activateSimBackend(f.ctx, bank);
    const custom: ExamProfile = {
      id: "toefl-ibt", name: "TOEFL iBT", country: "International", organization: "ETS", language: "en-US", description: "x", builtIn: false, revision: 1, updatedAt: "",
      sections: [{ id: "reading", name: "Reading", subject: "English", tools: ["notes"], modules: [{ id: "m1", name: "Reading", questionCount: 20, minutes: 35, formats: [{ format: "mcq", share: 1 }], blueprint: [{ domain: "Comprehension", share: 1 }] }] }],
      scoring: { min: 0, max: 30, combine: "sum", label: "Score" },
    };
    await f.call("sim.saveProfile", { profile: custom, skills: [{ id: "toefl-ibt.reading.comprehension.main-idea", exam: "toefl-ibt", domain: "Comprehension", name: "Main idea" }] });
    assert.ok((await f.call("sim.profiles")).some((p: any) => p.id === "toefl-ibt"));
    assert.equal(bank.skills("toefl-ibt").length, 1);
    await assert.rejects(f.call("sim.saveProfile", { profile: { ...custom, sections: [] } }), /at least one section/);
    const sat = await f.call("sim.profile", { id: "sat" });
    await f.call("sim.saveProfile", { profile: { ...sat, name: "My SAT" } });
    assert.equal((await f.call("sim.profile", { id: "sat" })).name, "My SAT");
    await f.call("sim.deleteProfile", { id: "sat" });
    assert.equal((await f.call("sim.profile", { id: "sat" })).name, "Digital SAT");
    await f.call("sim.deleteProfile", { id: "sat", hide: true });
    assert.ok(!(await f.call("sim.profiles")).some((p: any) => p.id === "sat"));
    await f.call("sim.restoreProfiles");
    assert.ok((await f.call("sim.profiles")).some((p: any) => p.id === "sat"));
  } finally { f.dispose(); }
});
