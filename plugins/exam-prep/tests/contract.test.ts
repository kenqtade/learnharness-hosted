import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertQuestion, gradeResponse, parseNumber, scale, type Question } from "../src/shared/contract.ts";
import { JsonStore } from "../src/shared/json-store.ts";

const base: Question = {
  id: "q1", revision: 1, exams: ["sat"], subject: "Math", skillId: "sat.math.algebra.linear", difficulty: 2, format: "mcq",
  stem: "If $2x+3=11$, what is $x$?", choices: [{ id: "A", text: "3" }, { id: "B", text: "4" }, { id: "C", text: "7" }, { id: "D", text: "8" }],
  answer: { kind: "choice", correct: ["B"] }, explanation: "$2x=8$, so $x=4$.", source: { kind: "ai" },
  verification: { status: "verified", checks: [] }, createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z",
};

test("assertQuestion accepts a valid question and rejects broken keys", () => {
  assertQuestion(base);
  assert.throws(() => assertQuestion({ ...base, answer: { kind: "choice", correct: ["E"] } }));
  assert.throws(() => assertQuestion({ ...base, answer: { kind: "choice", correct: ["A", "B"] } }), /exactly one/);
  assert.throws(() => assertQuestion({ ...base, source: { kind: "web" } }), /source URL/);
});

test("gradeResponse and parseNumber", () => {
  assert.equal(gradeResponse(base, "B"), true);
  assert.equal(gradeResponse(base, "A"), false);
  const numeric: Question = { ...base, format: "numeric", choices: undefined, answer: { kind: "numeric", value: 0.75, accepted: ["3/4"] } };
  for (const given of ["3/4", ".75", "0.75"]) assert.equal(gradeResponse(numeric, given), true, given);
  assert.equal(gradeResponse(numeric, "0.7"), false);
  assert.equal(parseNumber("2 1/2"), 2.5);
  assert.equal(parseNumber("-2 1/2"), -2.5);
  assert.equal(parseNumber("1/0"), undefined);
});

test("scale maps a raw fraction through the curve", () => {
  assert.equal(scale(0, { min: 200, max: 800, step: 10 }), 200);
  assert.equal(scale(1, { min: 200, max: 800, step: 10 }), 800);
  assert.equal(scale(0.5, { min: 200, max: 800, step: 10, curve: [[0, 200], [0.5, 560], [1, 800]] }), 560);
});

test("JsonStore: two instances share one file; revisions increase; a stale instance re-reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exam-store-"));
  try {
    const file = path.join(dir, "bank.json");
    const a = new JsonStore(file, () => ({ revision: 0, items: [] as string[] }));
    const b = new JsonStore(file, () => ({ revision: 0, items: [] as string[] }));
    a.change(d => { d.items.push("one"); });
    b.change(d => { d.items.push("two"); });
    assert.deepEqual(a.get().items, ["one", "two"]);
    assert.equal(a.get().revision, 2);
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith(".tmp")).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
