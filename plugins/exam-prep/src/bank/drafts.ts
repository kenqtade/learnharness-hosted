// TRACK B — worker output → shared Question. The AI returns a deliberately
// simple draft (choice *indices*, not ids); this module turns it into a Question
// that satisfies the shared contract's assertQuestion, so a malformed model
// answer fails the worker's validator instead of reaching the bank.
import type { AnswerKey, Choice, Question, QuestionFormat, QuestionSource, VerificationStatus } from "../shared/contract.ts";
import { assertQuestion } from "../shared/contract.ts";

export type DraftAnswer =
  | { kind: "choice"; correct: number[] }
  | { kind: "numeric"; value: number; tolerance?: number; accepted?: string[] }
  | { kind: "text"; accepted: string[]; caseSensitive?: boolean }
  | { kind: "matching"; pairs: { left: number; right: number }[] }
  | { kind: "rubric"; rubric: string; maxPoints?: number };

/** What the `author` and `extractor` workers return, one per question. */
export interface RawDraft {
  stem: string;
  passage?: string;
  choices?: string[];
  matchTargets?: string[];
  answer: DraftAnswer;
  explanation: string;
  estimatedSeconds?: number;
  /** extractor only: the question's own format/difficulty/skill. */
  format?: QuestionFormat;
  difficulty?: number;
  skillId?: string;
  subject?: string;
  tags?: string[];
}

export const CHOICE_FORMATS: readonly QuestionFormat[] = ["mcq", "multi-select", "true-false", "matching"];
export const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export interface DraftContext {
  id: string;
  exams: string[];
  subject: string;
  skillId: string;
  difficulty: number;
  format: QuestionFormat;
  source: QuestionSource;
  status?: VerificationStatus;
}

const difficultyOf = (value: number | undefined, fallback: number): 1 | 2 | 3 | 4 | 5 => {
  const chosen = Number.isInteger(value) && value! >= 1 && value! <= 5 ? value! : fallback;
  return chosen as 1 | 2 | 3 | 4 | 5;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
};

function buildChoices(draft: RawDraft, format: QuestionFormat): { choices?: Choice[]; matchTargets?: Choice[] } {
  if (format === "true-false") {
    const given = Array.isArray(draft.choices) && draft.choices.length >= 2 ? draft.choices : ["True", "False"];
    return { choices: [{ id: "T", text: String(given[0]) }, { id: "F", text: String(given[1]) }] };
  }
  if (format === "matching") {
    const left = draft.choices ?? [];
    const right = draft.matchTargets ?? [];
    if (left.length < 2) throw new Error("A matching question needs at least two left-hand items.");
    if (right.length < 2) throw new Error("A matching question needs at least two right-hand items.");
    if (left.length > 8 || right.length > 8) throw new Error("Keep matching questions to eight items per column.");
    return {
      choices: left.map((value, index) => ({ id: LETTERS[index]!, text: String(value) })),
      matchTargets: right.map((value, index) => ({ id: String(index + 1), text: String(value) })),
    };
  }
  if (["mcq", "multi-select"].includes(format)) {
    const values = draft.choices ?? [];
    if (values.length < 2) throw new Error("A multiple-choice question needs at least two answer choices.");
    if (values.length > 8) throw new Error("Keep answer choices to eight or fewer.");
    return { choices: values.map((value, index) => ({ id: LETTERS[index]!, text: String(value) })) };
  }
  return {};
}

function buildKey(draft: RawDraft, format: QuestionFormat, choices: Choice[] | undefined, targets: Choice[] | undefined): AnswerKey {
  const answer = draft.answer as DraftAnswer | undefined;
  if (!answer || typeof answer !== "object") throw new Error("Each question needs an answer key.");
  switch (answer.kind) {
    case "choice": {
      if (!choices) throw new Error(`A ${format} question cannot use a choice answer.`);
      const ids = [...new Set((answer.correct ?? []).map(index => choices[index]?.id).filter((id): id is string => !!id))];
      if (!ids.length) throw new Error("The answer key must name at least one choice.");
      if (answer.correct.length !== ids.length) throw new Error("The answer key repeats a choice index.");
      if (format === "mcq" && ids.length !== 1) throw new Error("A multiple-choice question has exactly one correct choice.");
      if (format === "multi-select" && ids.length < 2) throw new Error("A multi-select question needs at least two correct choices.");
      if (format === "true-false" && ids.length !== 1) throw new Error("A true/false question has one correct option.");
      return { kind: "choice", correct: ids };
    }
    case "numeric": {
      if (typeof answer.value !== "number" || !Number.isFinite(answer.value)) throw new Error("A numeric question needs a finite value.");
      const key: AnswerKey = { kind: "numeric", value: answer.value };
      if (Number.isFinite(answer.tolerance)) key.tolerance = answer.tolerance;
      if (Array.isArray(answer.accepted) && answer.accepted.length) key.accepted = answer.accepted.map(String);
      return key;
    }
    case "text": {
      const accepted = (answer.accepted ?? []).map(value => String(value).trim()).filter(Boolean);
      if (!accepted.length) throw new Error("A text question needs at least one accepted answer.");
      const key: AnswerKey = { kind: "text", accepted };
      if (answer.caseSensitive === true) key.caseSensitive = true;
      return key;
    }
    case "matching": {
      if (!choices || !targets) throw new Error("A matching question needs both columns.");
      const pairs: Record<string, string> = {};
      for (const pair of answer.pairs ?? []) {
        const left = choices[pair.left]?.id, right = targets[pair.right]?.id;
        if (!left || !right) throw new Error("A matching pair points outside the item lists.");
        if (pairs[left]) throw new Error("A matching item is paired twice.");
        pairs[left] = right;
      }
      if (Object.keys(pairs).length < 2) throw new Error("A matching question needs at least two pairs.");
      return { kind: "matching", pairs };
    }
    case "rubric": {
      const rubric = String(answer.rubric ?? "").trim();
      if (!rubric) throw new Error("An essay question needs a rubric.");
      return { kind: "rubric", rubric, maxPoints: Number.isFinite(answer.maxPoints) && answer.maxPoints! > 0 ? answer.maxPoints! : 10 };
    }
    default:
      throw new Error(`Unknown answer kind: ${JSON.stringify(answer)}`);
  }
}

/** Convert one draft into a contract-valid Question (throws a learner-readable error). */
export function draftToQuestion(draft: RawDraft, ctx: DraftContext): Question {
  if (!draft || typeof draft !== "object") throw new Error("A question draft must be an object.");
  const format = (draft.format && ["mcq", "multi-select", "numeric", "short-answer", "essay", "true-false", "matching", "cloze"].includes(draft.format))
    ? draft.format : ctx.format;
  const { choices, matchTargets } = buildChoices(draft, format);
  const answer = buildKey(draft, format, choices, matchTargets);
  const now = new Date().toISOString();
  const question: Question = {
    id: ctx.id,
    revision: 1,
    exams: [...ctx.exams],
    subject: draft.subject && typeof draft.subject === "string" && draft.subject.trim() ? draft.subject.trim() : ctx.subject,
    skillId: typeof draft.skillId === "string" && draft.skillId.trim() ? draft.skillId.trim() : ctx.skillId,
    difficulty: difficultyOf(draft.difficulty, ctx.difficulty),
    format,
    stem: text(draft.stem, "Question stem"),
    answer,
    explanation: text(draft.explanation, "Explanation"),
    source: ctx.source,
    verification: { status: ctx.status ?? "unverified", checks: [] },
    createdAt: now,
    updatedAt: now,
  };
  if (draft.passage && String(draft.passage).trim()) question.passage = String(draft.passage).trim();
  if (choices) question.choices = choices;
  if (matchTargets) question.matchTargets = matchTargets;
  if (Number.isFinite(draft.estimatedSeconds) && draft.estimatedSeconds! > 0) question.estimatedSeconds = Math.round(draft.estimatedSeconds!);
  if (Array.isArray(draft.tags) && draft.tags.length) question.tags = draft.tags.map(String).filter(Boolean).slice(0, 12);
  assertQuestion(question);
  return question;
}

/** The solver's view: everything needed to answer, nothing that reveals the key. */
export function solverView(question: Question): Record<string, unknown> {
  const view: Record<string, unknown> = {
    exam: question.exams[0],
    subject: question.subject,
    skillId: question.skillId,
    difficulty: question.difficulty,
    format: question.format,
    stem: question.stem,
  };
  if (question.passage) view.passage = question.passage;
  if (question.choices) view.choices = question.choices;
  if (question.matchTargets) view.matchTargets = question.matchTargets;
  return view;
}
