import assert from "node:assert/strict";
import { test } from "node:test";
import { assertQuestion, gradeResponse } from "../src/shared/contract.ts";
import { BUILT_IN_EXAMS } from "../src/shared/exams.ts";
import { activateBankBackend, queryQuestions } from "../src/bank/backend.ts";
import { STARTER_QUESTIONS } from "../src/bank/starter.ts";
import { buildSkills } from "../src/bank/taxonomy.ts";
import { fakeContext } from "./fake-context.ts";

const skillIds = new Set(buildSkills().map(s => s.id));

test("starter questions are valid, linked to real skills, cover every built-in exam, and their keys grade correct", () => {
  const ids = new Set<string>();
  for (const q of STARTER_QUESTIONS) {
    assertQuestion(q);
    assert.ok(skillIds.has(q.skillId), `unknown skill ${q.skillId}`);
    assert.ok(!ids.has(q.id)); ids.add(q.id);
    const key = q.answer;
    const answer = key.kind === "choice" ? key.correct : key.kind === "numeric" ? String(key.value) : key.kind === "text" ? key.accepted[0] : undefined;
    if (answer !== undefined) assert.equal(gradeResponse(q, answer), true, q.id);
  }
  for (const exam of BUILT_IN_EXAMS) assert.ok(STARTER_QUESTIONS.some(q => q.exams.includes(exam.id)), `no starter for ${exam.id}`);
});

test("first activation seeds skills and starter questions; the overview counts them", async () => {
  const f = fakeContext();
  try {
    activateBankBackend(f.ctx);
    const overview = await f.call("bank.overview");
    assert.equal(overview.total, STARTER_QUESTIONS.length);
    assert.equal(overview.byStatus.verified, STARTER_QUESTIONS.length);
    const sat = overview.exams.find((e: any) => e.id === "sat");
    assert.ok(sat.skills > 20 && sat.questions >= 10);
    assert.ok(f.workers.size === 4, "author/solver/critic/extractor workers registered");
  } finally { f.dispose(); }
});

test("deleting every question does not bring the starter set back on the next activation", async () => {
  const f = fakeContext();
  try {
    activateBankBackend(f.ctx);
    await f.call("bank.delete", { ids: STARTER_QUESTIONS.map(q => q.id) });
    const again = fakeContext({ dir: f.dir });
    activateBankBackend(again.ctx);
    assert.equal((await again.call("bank.overview")).total, 0);
  } finally { f.dispose(); }
});

test("list filters, get, manual save/edit, status changes and delete", async () => {
  const f = fakeContext();
  try {
    activateBankBackend(f.ctx);
    const math = await f.call("bank.list", { exam: "sat", domain: "Algebra" });
    assert.ok(math.total >= 3 && math.questions.every((q: any) => q.domain === "Algebra"));
    assert.equal(math.questions[0].answer, undefined, "list rows never carry the key");
    const search = await f.call("bank.list", { search: "waggle" });
    assert.equal(search.total, 1);
    const one = await f.call("bank.get", { id: search.questions[0].id });
    assert.equal(one.question.answer.kind, "choice");

    const skillId = "sat.math.algebra.linear-functions";
    const saved = await f.call("bank.save", { question: {
      skillId, difficulty: 2, format: "mcq", stem: "What is the slope of $y = 4x - 1$?",
      choices: [{ text: "$-1$" }, { text: "$4$" }, { text: "$1/4$" }], answer: { kind: "choice", correct: ["B"] },
      explanation: "In $y = mx + b$, the slope is $m = 4$.",
    } });
    assert.equal(saved.exams[0], "sat"); assert.equal(saved.subject, "Math");
    assert.equal(saved.verification.status, "verified"); assert.equal(saved.source.kind, "manual");
    assert.deepEqual(saved.choices.map((c: any) => c.id), ["A", "B", "C"]);
    const edited = await f.call("bank.save", { id: saved.id, question: { ...saved, stem: "Slope of $y=4x-1$?" } });
    assert.equal(edited.id, saved.id); assert.equal(edited.revision, 2); assert.equal(edited.createdAt, saved.createdAt);
    await assert.rejects(f.call("bank.save", { question: { ...saved, id: undefined, answer: { kind: "choice", correct: ["Z"] } } }), /key that names them/);
    await assert.rejects(f.call("bank.save", { question: { ...saved, id: undefined, skillId: "nope" } }), /Choose a skill/);

    const disputed = await f.call("bank.setStatus", { id: saved.id, status: "disputed", note: "two answers work" });
    assert.equal(disputed.verification.status, "disputed");
    assert.equal(disputed.verification.checks.at(-1).notes, "two answers work");
    assert.equal((await f.call("bank.delete", { id: saved.id })).removed, 1);
    await assert.rejects(f.call("bank.get", { id: saved.id }), /no longer exists/);
  } finally { f.dispose(); }
});

test("BankApi: verified-only query with filters and exclusions, skills, response stats", async () => {
  const f = fakeContext();
  try {
    const bank = activateBankBackend(f.ctx);
    const sat = bank.query({ exam: "sat", subject: "Math", limit: 100 });
    assert.ok(sat.length >= 9 && sat.every(q => q.subject === "Math" && q.verification.status === "verified"));
    const excluded = bank.query({ exam: "sat", subject: "Math", excludeIds: [sat[0]!.id], limit: 100 });
    assert.equal(excluded.length, sat.length - 1);
    assert.equal(bank.query({ exam: "sat", formats: ["numeric"], difficulty: [4] }).length, 1);
    assert.equal(bank.query({ exam: "sat", status: ["unverified"] }).length, 0);
    assert.ok(bank.skills("act").every(s => s.exam === "act") && bank.skills("act").length > 10);
    bank.recordResponses([{ questionId: sat[0]!.id, correct: true, seconds: 40 }, { questionId: sat[0]!.id, correct: null, seconds: 10 }]);
    const stats = (await f.call("bank.get", { id: sat[0]!.id })).stats;
    assert.deepEqual(stats, { attempts: 2, correct: 1, seconds: 50 });
    assert.equal(queryQuestions(sat, { limit: 2 }).length, 2);
  } finally { f.dispose(); }
});

test("author validates its request and starts an author worker task; jobs are listed without the internal plan", async () => {
  const f = fakeContext();
  try {
    activateBankBackend(f.ctx);
    await assert.rejects(f.call("bank.author", { exam: "sat", skillId: "sat.math.algebra.linear-functions", difficulty: 2, format: "mcq", count: 9 }), /at most 5/);
    await assert.rejects(f.call("bank.author", { exam: "act", skillId: "sat.math.algebra.linear-functions", difficulty: 2, format: "mcq", count: 2 }), /different exam/);
    const job = await f.call("bank.author", { exam: "sat", skillId: "sat.math.algebra.linear-functions", difficulty: 3, format: "mcq", count: 2 });
    assert.equal(job.kind, "author"); assert.equal(job.plan, undefined);
    for (let i = 0; i < 20 && !f.started.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.started[0]?.definitionId, "bank-author-v1");
    const jobs = await f.call("bank.jobs");
    assert.equal(jobs[0].id, job.id); assert.equal(jobs[0].plan, undefined);
    const cancelled = await f.call("bank.cancel", { id: job.id });
    assert.equal(cancelled.status, "cancelled");
  } finally { f.dispose(); }
});

test("tutor tools search without keys and get with the key; instructions are registered", async () => {
  const f = fakeContext();
  try {
    activateBankBackend(f.ctx);
    const [search, get] = f.tools();
    assert.equal(search.name, "exam_bank_search"); assert.equal(get.name, "exam_bank_get");
    const found = await search.execute("t1", { exam: "et-esslce-natural", query: "pH of a" });
    assert.equal(found.details.length, 1); assert.equal(found.details[0].answer, undefined);
    const full = await get.execute("t2", { id: found.details[0].id });
    assert.equal(full.details.answer.correct[0], "C");
    assert.match(f.instructions[0]!, /exam_bank_search/);
  } finally { f.dispose(); }
});

test("settings never return the search key itself; export/import round-trips", async () => {
  const f = fakeContext();
  try {
    activateBankBackend(f.ctx);
    assert.deepEqual(await f.call("bank.settings.set", { searchKey: "tvly-secret" }), { modelOverride: null, hasSearchKey: true });
    assert.equal(JSON.stringify(await f.call("bank.settings.get")).includes("tvly"), false);
    const exported = await f.call("bank.export", { exam: "ib-math-aa" });
    assert.ok(exported.questions.length >= 3);
    await f.call("bank.delete", { ids: exported.questions.map((q: any) => q.id) });
    const imported = await f.call("bank.importJson", { questions: [...exported.questions, { bad: true }] });
    assert.equal(imported.added, exported.questions.length); assert.equal(imported.errors.length, 1);
  } finally { f.dispose(); }
});
