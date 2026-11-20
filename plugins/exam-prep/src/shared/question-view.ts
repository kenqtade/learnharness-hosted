// Renders one question (passage, stem, answer input for every format) for the
// Question Bank "try it" panel and the Exam Simulator. No backend calls here.
import type { Question } from "./contract.ts";
import { h, type MarkdownMount } from "./dom.ts";

export interface QuestionViewOptions {
  md: MarkdownMount;
  answer?: unknown;
  eliminated?: string[];
  /** Show the strike-out control on each choice. */
  eliminator?: boolean;
  disabled?: boolean;
  /** Called on every change with the current answer. */
  onAnswer?: (answer: unknown) => void;
  onEliminate?: (eliminated: string[]) => void;
  /** Show the stem only (passage rendered elsewhere, e.g. the split exam layout). */
  hidePassage?: boolean;
  /** After grading: mark correct/incorrect choices. */
  reveal?: boolean;
}

export const FORMAT_LABEL: Record<Question["format"], string> = {
  mcq: "Multiple choice", "multi-select": "Select all that apply", numeric: "Student-produced response", "short-answer": "Short answer",
  essay: "Essay", "true-false": "True / False", matching: "Matching", cloze: "Fill in the blanks",
};

export function mountQuestion(container: HTMLElement, q: Question, options: QuestionViewOptions): { answer(): unknown } {
  let answer: unknown = options.answer;
  let eliminated = new Set(options.eliminated ?? []);
  const emit = () => options.onAnswer?.(answer);
  const root = h("div", { class: "ep-question" });
  container.append(root);
  if (q.passage && !options.hidePassage) {
    const passage = h("div", { class: "ep-passage" });
    root.append(passage);
    options.md(passage, q.passage);
  }
  const stem = h("div", { class: "ep-stem" });
  root.append(stem);
  options.md(stem, q.stem);

  const correct = q.answer.kind === "choice" ? new Set(q.answer.correct) : new Set<string>();
  switch (q.format) {
    case "mcq": case "true-false": case "multi-select": {
      const multi = q.format === "multi-select";
      const list = h("div", { class: "ep-choices", role: multi ? "group" : "radiogroup" });
      root.append(list);
      const selected = () => new Set<string>(Array.isArray(answer) ? (answer as unknown[]).map(String) : answer ? [String(answer)] : []);
      const render = () => {
        list.replaceChildren();
        const chosen = selected();
        for (const choice of q.choices ?? []) {
          const isOn = chosen.has(choice.id), isOut = eliminated.has(choice.id);
          const row = h("div", { class: `ep-choice-row${isOut ? " is-eliminated" : ""}` });
          const button = h("button", {
            type: "button", class: `ep-choice${isOn ? " is-selected" : ""}${options.reveal && correct.has(choice.id) ? " is-correct" : ""}${options.reveal && isOn && !correct.has(choice.id) ? " is-wrong" : ""}`,
            role: multi ? "checkbox" : "radio", "aria-checked": String(isOn), disabled: options.disabled,
            onclick: () => {
              const next = selected();
              if (multi) { if (next.has(choice.id)) next.delete(choice.id); else next.add(choice.id); answer = [...next].sort(); }
              else answer = isOn ? "" : choice.id;
              if (eliminated.has(choice.id)) { eliminated.delete(choice.id); options.onEliminate?.([...eliminated]); }
              render(); emit();
            },
          }, h("span", { class: "ep-choice-letter" }, choice.id));
          const text = h("span", { class: "ep-choice-text" });
          button.append(text);
          options.md(text, choice.text);
          row.append(button);
          if (options.eliminator && !options.disabled) row.append(h("button", {
            type: "button", class: "ep-eliminate", title: isOut ? "Undo strike-out" : "Strike out this choice", "aria-label": `Strike out choice ${choice.id}`,
            onclick: () => { if (eliminated.has(choice.id)) eliminated.delete(choice.id); else eliminated.add(choice.id); options.onEliminate?.([...eliminated]); render(); },
          }, isOut ? "↺" : "⊘"));
          list.append(row);
        }
      };
      render();
      break;
    }
    case "numeric": case "short-answer": {
      const input = h("input", {
        class: "ep-input", type: "text", inputmode: q.format === "numeric" ? "decimal" : "text", value: answer === undefined ? "" : String(answer),
        placeholder: q.format === "numeric" ? "Your answer (e.g. 12, -3.5 or 3/4)" : "Your answer", disabled: options.disabled, "aria-label": "Your answer",
      });
      input.addEventListener("input", () => { answer = input.value; emit(); });
      root.append(input);
      break;
    }
    case "cloze": {
      const blanks = Math.max(1, (q.answer.kind === "text" ? (q.answer.accepted[0] ?? "") : "").split("|").length);
      const values = String(answer ?? "").split("|");
      const wrap = h("div", { class: "ep-cloze" });
      const inputs = Array.from({ length: blanks }, (_, i) => {
        const input = h("input", { class: "ep-input", type: "text", value: values[i] ?? "", placeholder: `Blank ${i + 1}`, disabled: options.disabled });
        input.addEventListener("input", () => { answer = inputs.map(x => x.value.trim()).join("|"); emit(); });
        wrap.append(input);
        return input;
      });
      root.append(wrap);
      break;
    }
    case "essay": {
      const area = h("textarea", { class: "ep-essay", rows: 14, placeholder: "Write your response here…", disabled: options.disabled, "aria-label": "Essay response" });
      area.value = typeof answer === "string" ? answer : "";
      const count = h("div", { class: "ep-hint" });
      const update = () => { const words = area.value.trim() ? area.value.trim().split(/\s+/).length : 0; count.textContent = `${words} word${words === 1 ? "" : "s"}`; };
      area.addEventListener("input", () => { answer = area.value; update(); emit(); });
      update();
      root.append(area, count);
      break;
    }
    case "matching": {
      const current: Record<string, string> = typeof answer === "object" && answer && !Array.isArray(answer) ? { ...(answer as Record<string, string>) } : {};
      const table = h("div", { class: "ep-matching" });
      for (const left of q.choices ?? []) {
        const label = h("div", { class: "ep-match-left" }, h("strong", {}, `${left.id}. `));
        const text = h("span");
        label.append(text);
        options.md(text, left.text);
        const sel = h("select", { class: "ep-input", disabled: options.disabled, "aria-label": `Match for ${left.id}` },
          h("option", { value: "" }, "—"),
          ...(q.matchTargets ?? []).map(t => h("option", { value: t.id, selected: current[left.id] === t.id }, `${t.id}. ${t.text.replace(/\$/g, "")}`)));
        sel.addEventListener("change", () => { if (sel.value) current[left.id] = sel.value; else delete current[left.id]; answer = { ...current }; emit(); });
        table.append(h("div", { class: "ep-match-row" }, label, sel));
      }
      root.append(table);
      break;
    }
  }
  return { answer: () => answer };
}

/** Learner-readable correct answer. */
export function describeKey(q: Question): string {
  const key = q.answer;
  switch (key.kind) {
    case "choice": return key.correct.map(id => { const c = q.choices?.find(x => x.id === id); return c ? `**${id}.** ${c.text}` : id; }).join("; ");
    case "numeric": return [String(key.value), ...(key.accepted ?? [])].join(" or ") + (key.tolerance ? ` (±${key.tolerance})` : "");
    case "text": return key.accepted.join(" / ");
    case "matching": return Object.entries(key.pairs).map(([l, r]) => `${l} → ${r}`).join(", ");
    case "rubric": return `Graded by rubric (max ${key.maxPoints} points):\n\n${key.rubric}`;
  }
}

/** Learner-readable rendering of a given answer. */
export function describeAnswer(q: Question, answer: unknown): string {
  if (answer === undefined || answer === null || answer === "" || (Array.isArray(answer) && !answer.length)) return "—";
  if (q.format === "essay") { const t = String(answer); return t.length > 400 ? `${t.slice(0, 400)}…` : t; }
  if (Array.isArray(answer)) return answer.join(", ");
  if (typeof answer === "object") return Object.entries(answer as Record<string, string>).map(([l, r]) => `${l} → ${r}`).join(", ");
  return String(answer);
}
