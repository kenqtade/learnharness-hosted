// The live exam screen: one module at a time, server-kept clock, navigator,
// flag for review, answer eliminator, passage highlighter, notes, reference
// sheet and exactly the calculators the section allows.
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { mountCalculator, type CalculatorHandle, type CalculatorKind } from "../../../graph-lab/src/engine/calculator.ts";
import type { Attempt, Question, ToolId } from "../shared/contract.ts";
import { clear, errorText, formatDuration, h, type MarkdownMount } from "../shared/dom.ts";
import { FORMAT_LABEL, mountQuestion } from "../shared/question-view.ts";

export interface AttemptView {
  attempt: Attempt;
  profile?: { id: string; name: string; scoring: { label?: string }; rules: string[] };
  modules: { sectionId: string; sectionName: string; moduleName: string; count: number; planned: number; minutes: number; route?: string; submitted: boolean }[];
  current?: {
    sectionName: string; moduleName: string; subject: string; tools: ToolId[]; referenceSheet?: string;
    remainingSeconds?: number; timeLimitSeconds: number; paused: boolean; questions: Question[]; breakUntil?: string; nextSection?: string;
  };
  serverTime: string;
}

export const TOOL_LABEL: Record<ToolId, string> = {
  "graphing-calculator": "Graphing calculator", "scientific-calculator": "Scientific calculator", "four-function-calculator": "Calculator",
  "matrix-calculator": "Matrix calculator", "reference-sheet": "Reference sheet", notes: "Scratch notes", highlighter: "Highlighter", "answer-eliminator": "Answer eliminator",
};
const CALC: Partial<Record<ToolId, CalculatorKind>> = { "graphing-calculator": "graphing", "scientific-calculator": "scientific", "four-function-calculator": "four-function", "matrix-calculator": "matrix" };

export function mountExamScreen(ctx: PluginFrontendContext, host: HTMLElement, initial: AttemptView, md: MarkdownMount, signal: AbortSignal, done: (view: AttemptView) => void): void {
  let view = initial;
  const a = () => view.attempt;
  const local = new AbortController();
  signal.addEventListener("abort", () => local.abort());
  const responses = new Map<string, { answer?: unknown; flagged: boolean; eliminated: string[]; seconds: number }>();
  const loadResponses = () => {
    for (const [id, r] of Object.entries(a().responses)) responses.set(id, { answer: r.answer, flagged: r.flagged, eliminated: r.eliminated ?? [], seconds: r.seconds });
  };
  loadResponses();
  let index = Math.min(a().current.question, Math.max(0, (view.current?.questions.length ?? 1) - 1));
  let reviewing = false;
  let timerHidden = false;
  let deadline = 0;           // local ms timestamp when the module ends
  let warned = false;
  let submitting = false;
  let shownAt = Date.now();
  const openTools = new Set<ToolId>();
  const calculators = new Map<ToolId, CalculatorHandle>();
  const highlights = new Map<string, string>();      // question id → passage html with marks
  let notes = a().notes ?? "";
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const root = h("div", { class: "exam-sim ep-exam", tabindex: "-1" });
  host.replaceChildren(root);
  const top = h("header", { class: "ep-exam-top" });
  const body = h("div", { class: "ep-exam-body" });
  const toolDock = h("aside", { class: "ep-tool-dock" });
  const bottom = h("footer", { class: "ep-exam-bottom" });
  const toast = h("div", { class: "ep-toast", role: "status", "aria-live": "polite" });
  root.append(top, h("div", { class: "ep-exam-main" }, body, toolDock), bottom, toast);

  const say = (text: string, ms = 4000) => { toast.textContent = text; toast.classList.add("is-on"); setTimeout(() => { if (toast.textContent === text) toast.classList.remove("is-on"); }, ms); };
  const questions = () => view.current?.questions ?? [];
  const tools = () => new Set(view.current?.tools ?? []);

  function setDeadline() {
    const remaining = view.current?.remainingSeconds;
    deadline = remaining === undefined ? 0 : Date.now() + remaining * 1000;
    warned = remaining !== undefined && remaining <= 300;
  }
  setDeadline();

  // ── saving ──────────────────────────────────────────────────────────────
  function accrue() {
    const q = questions()[index];
    if (!q || reviewing) { shownAt = Date.now(); return; }
    const r = responses.get(q.id) ?? { flagged: false, eliminated: [], seconds: 0 };
    r.seconds += (Date.now() - shownAt) / 1000;
    responses.set(q.id, r);
    shownAt = Date.now();
  }
  function save(questionId: string, immediate = false) {
    const prev = saveTimers.get(questionId);
    if (prev) clearTimeout(prev);
    const run = async () => {
      saveTimers.delete(questionId);
      const r = responses.get(questionId);
      if (!r) return;
      try {
        await ctx.call("sim.answer", { id: a().id, questionId, answer: r.answer ?? "", flagged: r.flagged, eliminated: r.eliminated, seconds: Math.round(r.seconds), position: index });
        saved.textContent = "Saved"; saved.classList.remove("is-error");
      } catch (error) {
        saved.textContent = "Not saved"; saved.classList.add("is-error");
        const message = errorText(error);
        if (/time is up|not open|paused/i.test(message)) void refresh(); else say(message);
      }
    };
    if (immediate) void run(); else saveTimers.set(questionId, setTimeout(run, 500));
  }
  async function flushSaves() {
    const pending = [...saveTimers.keys()];
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
    accrue();
    await Promise.all(pending.map(async id => {
      const r = responses.get(id);
      if (r) await ctx.call("sim.answer", { id: a().id, questionId: id, answer: r.answer ?? "", flagged: r.flagged, eliminated: r.eliminated, seconds: Math.round(r.seconds) }).catch(() => undefined);
    }));
  }

  async function refresh(next?: AttemptView) {
    view = next ?? await ctx.call<AttemptView>("sim.attempt", { id: a().id });
    loadResponses();
    if (!view.current || !["in-progress"].includes(a().status)) { cleanup(); done(view); return; }
    index = Math.min(a().current.question, Math.max(0, questions().length - 1));
    reviewing = false; setDeadline(); render();
  }

  async function submitModule(auto = false) {
    if (submitting) return;
    submitting = true;
    try {
      await flushSaves();
      const next = await ctx.call<AttemptView>("sim.submitModule", { id: a().id });
      if (auto) say("Time is up — your answers for this module were submitted.", 6000);
      for (const handle of calculators.values()) handle.dispose();
      calculators.clear(); openTools.clear();
      await refresh(next);
    } catch (error) {
      say(errorText(error));
      await refresh().catch(() => undefined);
    } finally { submitting = false; }
  }

  // ── clock ────────────────────────────────────────────────────────────────
  const timerEl = h("span", { class: "ep-timer-text", "aria-live": "off" });
  const tick = () => {
    if (!view.current || view.current.breakUntil) return;
    if (!deadline) { timerEl.textContent = "Untimed"; return; }
    if (view.current.paused) { timerEl.textContent = "Paused"; return; }
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    timerEl.textContent = timerHidden ? "Show time" : formatDuration(left);
    timerEl.parentElement?.classList.toggle("is-low", left <= 300);
    if (!warned && left <= 300 && left > 0) { warned = true; say("5 minutes remaining in this module.", 6000); }
    if (left <= 0 && !submitting) void submitModule(true);
  };
  const interval = setInterval(tick, 500);
  const cleanup = () => {
    clearInterval(interval);
    for (const handle of calculators.values()) handle.dispose();
    calculators.clear();
    local.abort();
  };
  signal.addEventListener("abort", () => { clearInterval(interval); void flushSaves(); });
  const onVisibility = () => { if (document.visibilityState === "visible") void ctx.call<AttemptView>("sim.attempt", { id: a().id }).then(v => { if (v.current && a().status === "in-progress" && v.attempt.current.module === a().current.module) { view = { ...view, current: { ...view.current!, remainingSeconds: v.current.remainingSeconds, paused: v.current.paused } }; setDeadline(); tick(); } else void refresh(v); }).catch(() => undefined); };
  document.addEventListener("visibilitychange", onVisibility);
  local.signal.addEventListener("abort", () => document.removeEventListener("visibilitychange", onVisibility));

  // ── keyboard ─────────────────────────────────────────────────────────────
  root.addEventListener("keydown", event => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === "ArrowRight" && !reviewing) { go(index + 1); event.preventDefault(); }
    if (event.key === "ArrowLeft" && !reviewing) { go(index - 1); event.preventDefault(); }
  });

  const saved = h("span", { class: "ep-saved", "aria-live": "polite" });

  function go(next: number) {
    accrue();
    const q = questions()[index];
    if (q) save(q.id, true);
    if (next >= questions().length) { reviewing = true; render(); return; }
    index = Math.max(0, next); reviewing = false; render();
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render() {
    const cur = view.current;
    if (!cur) return;
    if (cur.breakUntil) { renderBreak(cur.breakUntil, cur.nextSection); return; }
    renderTop(cur);
    renderTools(cur);
    clear(body); clear(bottom);
    if (cur.paused) {
      body.append(h("div", { class: "ep-center" }, h("h2", {}, "Paused"), h("p", {}, "The clock is stopped. Questions are hidden while paused."),
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: async () => refresh(await ctx.call<AttemptView>("sim.pause", { id: a().id, resume: true })) }, "Resume")));
      return;
    }
    if (reviewing) renderReview(); else renderQuestion();
    renderBottom();
  }

  function renderTop(cur: NonNullable<AttemptView["current"]>) {
    clear(top);
    const timer = h("button", { type: "button", class: "ep-timer", title: timerHidden ? "Show the timer" : "Hide the timer", onclick: () => { timerHidden = !timerHidden; tick(); } }, timerEl);
    const toolButtons = h("div", { class: "ep-tool-buttons", role: "toolbar", "aria-label": "Tools" });
    for (const tool of cur.tools) {
      if (tool === "answer-eliminator" || tool === "highlighter") continue;
      if (tool === "reference-sheet" && !cur.referenceSheet) continue;
      toolButtons.append(h("button", {
        type: "button", class: `ep-tool-btn${openTools.has(tool) ? " is-active" : ""}`, "aria-pressed": String(openTools.has(tool)),
        onclick: () => { if (openTools.has(tool)) { openTools.delete(tool); calculators.get(tool)?.dispose(); calculators.delete(tool); } else openTools.add(tool); renderTop(cur); renderTools(cur); },
      }, TOOL_LABEL[tool]));
    }
    top.append(
      h("div", { class: "ep-exam-title" }, h("strong", {}, cur.sectionName), h("span", {}, `${cur.moduleName}${view.profile ? ` · ${view.profile.name}` : ""}`)),
      timer,
      h("div", { class: "ep-exam-top-right" }, toolButtons,
        a().setup.mode === "practice" ? h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { await flushSaves(); await refresh(await ctx.call<AttemptView>("sim.pause", { id: a().id })); } }, "Pause") : null,
        h("button", { type: "button", class: "ep-btn ep-btn-ghost", title: "Full screen", onclick: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.requestFullscreen?.().catch(() => undefined); } }, "⛶"),
        h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => {
          if (!confirm(a().setup.mode === "strict" ? "Leave the exam? The clock keeps running (as in the real test); you can come back from Exam Simulator." : "Leave the test? Your answers are saved; you can resume later.")) return;
          await flushSaves(); cleanup(); done(view);
        } }, "Exit")));
    tick();
  }

  function renderTools(cur: NonNullable<AttemptView["current"]>) {
    for (const tool of [...calculators.keys()]) if (!openTools.has(tool)) { calculators.get(tool)?.dispose(); calculators.delete(tool); }
    const keep = new Set([...calculators.keys()]);
    for (const el of [...toolDock.children]) if (!keep.has((el as HTMLElement).dataset.tool as ToolId)) el.remove();
    toolDock.classList.toggle("is-open", openTools.size > 0);
    for (const tool of openTools) {
      if (calculators.has(tool)) continue;
      const close = h("button", { type: "button", class: "ep-icon-btn", "aria-label": `Close ${TOOL_LABEL[tool]}`, onclick: () => { openTools.delete(tool); renderTop(cur); renderTools(cur); } }, "×");
      const panel = h("section", { class: `ep-tool-panel ep-tool-${tool}`, "data-tool": tool }, h("header", {}, h("strong", {}, TOOL_LABEL[tool]), close));
      const content = h("div", { class: "ep-tool-content" });
      panel.append(content);
      toolDock.append(panel);
      const kind = CALC[tool];
      if (kind) {
        try { calculators.set(tool, mountCalculator(content, { kind, signal: local.signal })); }
        catch (error) { content.textContent = `The calculator could not start: ${errorText(error)}`; calculators.set(tool, { dispose: () => undefined }); }
      } else if (tool === "reference-sheet") {
        md(content, cur.referenceSheet ?? "No reference sheet for this section.");
        calculators.set(tool, { dispose: () => undefined });
      } else if (tool === "notes") {
        const area = h("textarea", { class: "ep-notes", rows: 12, placeholder: "Scratch work — saved with this attempt, never graded." });
        area.value = notes;
        let t: ReturnType<typeof setTimeout> | undefined;
        area.addEventListener("input", () => { notes = area.value; if (t) clearTimeout(t); t = setTimeout(() => void ctx.call("sim.notes", { id: a().id, notes }).catch(() => undefined), 800); });
        content.append(area);
        calculators.set(tool, { dispose: () => undefined });
      }
    }
  }

  function renderQuestion() {
    const q = questions()[index];
    if (!q) { body.append(h("p", { class: "ep-empty" }, "This module has no questions.")); return; }
    shownAt = Date.now();
    const r = responses.get(q.id) ?? { flagged: false, eliminated: [], seconds: 0 };
    responses.set(q.id, r);
    const canHighlight = tools().has("highlighter");
    const split = !!q.passage;
    const layout = h("div", { class: `ep-exam-q${split ? " is-split" : ""}` });
    body.append(layout);
    if (split) {
      const passage = h("div", { class: "ep-passage ep-exam-passage" });
      layout.append(passage);
      const saved = highlights.get(q.id);
      if (saved) passage.innerHTML = saved; else md(passage, q.passage ?? "");
      if (canHighlight) attachHighlighter(passage, () => highlights.set(q.id, passage.innerHTML));
    }
    const side = h("div", { class: "ep-exam-question" });
    layout.append(side);
    side.append(h("div", { class: "ep-q-head" },
      h("span", { class: "ep-q-number" }, String(index + 1)),
      h("button", { type: "button", class: `ep-flag${r.flagged ? " is-on" : ""}`, "aria-pressed": String(r.flagged), onclick: () => { r.flagged = !r.flagged; save(q.id, true); render(); } }, r.flagged ? "⚑ Marked for review" : "⚐ Mark for review"),
      h("span", { class: "ep-hint" }, FORMAT_LABEL[q.format])));
    const qHost = h("div");
    side.append(qHost);
    mountQuestion(qHost, q, {
      md, answer: r.answer, eliminated: r.eliminated, eliminator: tools().has("answer-eliminator"), hidePassage: true,
      onAnswer: answer => { r.answer = answer; save(q.id); renderBottomNumber(); },
      onEliminate: list => { r.eliminated = list; save(q.id); },
    });
    if (canHighlight) attachHighlighter(qHost.querySelector(".ep-stem") as HTMLElement | null, () => undefined);
    if (q.format === "numeric") side.append(h("p", { class: "ep-hint" }, "Enter a number, fraction (3/4) or decimal (.75). Negative answers are allowed."));
  }

  function attachHighlighter(el: HTMLElement | null, persist: () => void) {
    if (!el) return;
    el.classList.add("ep-highlightable");
    el.title = "Select text to highlight it; click a highlight to remove it.";
    el.addEventListener("mouseup", () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      try { const mark = document.createElement("mark"); mark.className = "ep-mark"; range.surroundContents(mark); selection.removeAllRanges(); persist(); }
      catch { say("Highlight one paragraph at a time."); }
    });
    el.addEventListener("click", event => {
      const mark = (event.target as HTMLElement).closest("mark.ep-mark");
      if (!mark) return;
      mark.replaceWith(...Array.from(mark.childNodes));
      persist();
    });
  }

  function renderReview() {
    const qs = questions();
    const unanswered = qs.filter(q => !answered(q.id)).length;
    const flagged = qs.filter(q => responses.get(q.id)?.flagged).length;
    const grid = h("div", { class: "ep-review-grid" });
    qs.forEach((q, i) => grid.append(h("button", {
      type: "button", class: `ep-nav-cell${answered(q.id) ? " is-answered" : ""}${responses.get(q.id)?.flagged ? " is-flagged" : ""}`,
      onclick: () => { reviewing = false; index = i; render(); },
    }, String(i + 1))));
    body.append(h("div", { class: "ep-review" },
      h("h2", {}, `Check your work — ${view.current?.sectionName ?? ""}, ${view.current?.moduleName ?? ""}`),
      h("p", {}, `${qs.length - unanswered} of ${qs.length} answered${flagged ? ` · ${flagged} marked for review` : ""}. ${a().setup.mode === "strict" ? "Once you submit, you cannot return to this module." : "You can still go back before submitting."}`),
      h("div", { class: "ep-legend" }, h("span", { class: "ep-nav-cell is-answered" }, ""), " answered ", h("span", { class: "ep-nav-cell" }, ""), " unanswered ", h("span", { class: "ep-nav-cell is-flagged" }, ""), " marked"),
      grid,
      h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => {
        if (unanswered && !confirm(`${unanswered} question${unanswered === 1 ? " is" : "s are"} unanswered. Submit this module anyway?`)) return;
        void submitModule();
      } }, isLastModule() ? "Submit test" : "Submit module and continue")));
  }
  const isLastModule = () => a().current.module >= a().modules.length - 1;
  const answered = (id: string) => { const v = responses.get(id)?.answer; return !(v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length)); };

  const numberButton = h("button", { type: "button", class: "ep-nav-toggle", "aria-haspopup": "dialog" });
  const navPop = h("div", { class: "ep-nav-pop", role: "dialog", "aria-label": "Question navigator", hidden: true });
  function renderBottomNumber() {
    const qs = questions();
    numberButton.textContent = reviewing ? "Review" : `Question ${index + 1} of ${qs.length} ▴`;
    clear(navPop);
    const grid = h("div", { class: "ep-review-grid" });
    qs.forEach((q, i) => grid.append(h("button", {
      type: "button", class: `ep-nav-cell${answered(q.id) ? " is-answered" : ""}${responses.get(q.id)?.flagged ? " is-flagged" : ""}${i === index && !reviewing ? " is-current" : ""}`,
      onclick: () => { navPop.hidden = true; accrue(); const cur = questions()[index]; if (cur) save(cur.id, true); reviewing = false; index = i; render(); },
    }, String(i + 1))));
    navPop.append(grid, h("button", { type: "button", class: "ep-btn", onclick: () => { navPop.hidden = true; go(qs.length); } }, "Go to review page"));
  }
  numberButton.addEventListener("click", () => { navPop.hidden = !navPop.hidden; });
  function renderBottom() {
    renderBottomNumber();
    const qs = questions();
    bottom.append(
      h("div", { class: "ep-bottom-left" }, saved),
      h("div", { class: "ep-bottom-center" }, numberButton, navPop),
      h("div", { class: "ep-bottom-right" },
        h("button", { type: "button", class: "ep-btn", disabled: !reviewing && index === 0, onclick: () => { if (reviewing) { reviewing = false; index = qs.length - 1; render(); } else go(index - 1); } }, "Back"),
        reviewing ? null : h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => go(index + 1) }, index === qs.length - 1 ? "Review" : "Next")));
  }

  function renderBreak(until: string, nextSection?: string) {
    clear(top); clear(body); clear(bottom); toolDock.replaceChildren(); toolDock.classList.remove("is-open");
    const end = Date.parse(until);
    const clock = h("div", { class: "ep-break-clock" });
    const update = () => { const left = Math.max(0, Math.round((end - Date.now()) / 1000)); clock.textContent = formatDuration(left); if (left <= 0) { clearInterval(t); void resume(); } };
    const t = setInterval(update, 500);
    local.signal.addEventListener("abort", () => clearInterval(t));
    const resume = async () => { clearInterval(t); try { await refresh(await ctx.call<AttemptView>("sim.start", { id: a().id })); } catch (error) { say(errorText(error)); } };
    body.append(h("div", { class: "ep-center ep-break" }, h("h2", {}, "Break"), h("p", {}, `Take a short break. ${nextSection ? `Next: ${nextSection}.` : ""} The test resumes automatically when the break ends.`), clock,
      h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: resume }, "Resume testing now")));
    update();
  }

  render();
  root.focus();
}
