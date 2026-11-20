// Question Bank view: browse/filter the skill-linked bank, try questions, write
// them by hand, and have the AI author, source (web, with the link saved) or
// import questions in background jobs. Settings: model override + search key.
import type { PluginFrontendContext, PluginModelSpec } from "learnharness-plugin-api";
import { FORMATS, gradeResponse, type BankJob, type Question, type QuestionFormat, type Skill, type VerificationStatus } from "../shared/contract.ts";
import { clear, errorText, field, h, relativeTime, select, type MarkdownMount } from "../shared/dom.ts";
import { describeKey, FORMAT_LABEL, mountQuestion } from "../shared/question-view.ts";
import type { QuestionSummary } from "./backend.ts";

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 7h7M9 11h5"/></svg>`;

interface ExamOverview { id: string; name: string; country: string; organization: string; sections: { id: string; name: string; subject: string; domains: string[] }[]; skills: number; questions: number; verified: number }
interface Overview { total: number; byStatus: Record<VerificationStatus, number>; exams: ExamOverview[]; activeJobs: number }
type SkillRow = Skill & { questions: number; verified: number; attempts: number; correct: number };
interface Filter { exam: string; domain: string; skillId: string; status: string; format: string; difficulty: string; search: string }
type Panel = "none" | "author" | "source" | "import" | "manual" | "jobs";

const STATUS_LABEL: Record<VerificationStatus, string> = { verified: "Verified", unverified: "Unverified", disputed: "Disputed" };
const SOURCE_LABEL: Record<string, string> = { ai: "AI-written", web: "From the web", upload: "Imported", manual: "Hand-written" };
const DIFF = ["", "1 · Easy", "2", "3 · Medium", "4", "5 · Hard"];

export function activateBankFrontend(ctx: PluginFrontendContext): void {
  ctx.registerView({ id: "bank", name: "Question Bank", mount: (container, signal) => mountBank(ctx, container, signal) });
  ctx.registerAction({ id: "open-bank", name: "Question Bank", icon: ICON, run: () => ctx.app.openView("bank") });
  ctx.placeAction({ id: "sidebar-bank", actionId: "open-bank", location: "sidebar" });
  ctx.registerSettings((container, signal) => mountBankSettings(ctx, container, signal));
}

function markdown(ctx: PluginFrontendContext, signal: AbortSignal): MarkdownMount {
  return (el, text) => { try { ctx.ui.mountMarkdown(el, { text }, { signal }); } catch { el.textContent = text; } };
}

function mountBank(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): void {
  const md = markdown(ctx, signal);
  const root = h("div", { class: "exam-bank ep-root" });
  container.append(root);
  const filter: Filter = { exam: "", domain: "", skillId: "", status: "", format: "", difficulty: "", search: "" };
  let overview: Overview | undefined;
  let skills: SkillRow[] = [];
  let panel: Panel = "none";
  let page = 0;
  const PAGE = 25;
  let expanded: string | undefined;
  let jobs: BankJob[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const header = h("div", { class: "ep-header" });
  const toolbar = h("div", { class: "ep-toolbar" });
  const panelEl = h("div", { class: "ep-panel-host" });
  const filters = h("div", { class: "ep-filters" });
  const status = h("div", { class: "ep-status", role: "status" });
  const list = h("div", { class: "ep-list" });
  const pager = h("div", { class: "ep-pager" });
  root.append(header, toolbar, panelEl, filters, status, list, pager);

  const flash = (text: string, kind: "info" | "error" = "info") => {
    status.textContent = text; status.className = `ep-status is-${kind}`;
    if (kind === "info") setTimeout(() => { if (status.textContent === text) status.textContent = ""; }, 5000);
  };
  const examName = (id: string) => overview?.exams.find(e => e.id === id)?.name ?? id;

  async function loadOverview() {
    overview = await ctx.call<Overview>("bank.overview", {});
    renderHeader(); renderToolbar();
  }
  async function loadSkills() {
    skills = await ctx.call<SkillRow[]>("bank.skills", filter.exam ? { exam: filter.exam } : {});
    renderFilters();
  }
  async function loadList() {
    list.setAttribute("aria-busy", "true");
    try {
      const input: Record<string, unknown> = { offset: page * PAGE, limit: PAGE };
      for (const [k, v] of Object.entries(filter)) if (v) input[k] = k === "difficulty" ? Number(v) : v;
      const result = await ctx.call<{ total: number; questions: QuestionSummary[] }>("bank.list", input);
      renderList(result.questions, result.total);
    } catch (error) { flash(errorText(error), "error"); }
    finally { list.removeAttribute("aria-busy"); }
  }
  async function loadJobs() {
    jobs = await ctx.call<BankJob[]>("bank.jobs", {});
    if (panel === "jobs") renderPanel();
    renderToolbar();
    scheduleJobPoll();
  }
  function scheduleJobPoll() {
    if (timer) clearTimeout(timer);
    if (signal.aborted) return;
    const active = jobs.some(j => j.status === "queued" || j.status === "running");
    if (active) timer = setTimeout(() => { void loadJobs().then(() => { if (!jobs.some(j => j.status === "queued" || j.status === "running")) void refreshAll(); }); }, 4000);
  }
  async function refreshAll() {
    try { await Promise.all([loadOverview(), loadSkills(), loadList(), loadJobs()]); }
    catch (error) { flash(errorText(error), "error"); }
  }
  signal.addEventListener("abort", () => { if (timer) clearTimeout(timer); });
  const unsubscribe = ctx.onNotification(event => { if (event.topic === "bank-changed") { void loadOverview(); void loadList(); void loadJobs(); } });
  signal.addEventListener("abort", unsubscribe);

  function renderHeader() {
    clear(header);
    if (!overview) return;
    header.append(
      h("div", { class: "ep-title" }, h("h1", {}, "Question Bank"), h("p", { class: "ep-sub" }, "Official-exam-style questions, each linked to a skill. Write them yourself, or let the AI write, find or import them — every AI question is solved independently and checked before it counts as verified.")),
      h("div", { class: "ep-stats" },
        stat(String(overview.total), "questions"), stat(String(overview.byStatus.verified ?? 0), "verified"),
        stat(String(overview.byStatus.disputed ?? 0), "disputed"), stat(String(overview.exams.filter(e => e.questions).length), "exams covered")),
    );
    const cards = h("div", { class: "ep-exam-chips" });
    for (const e of overview.exams) cards.append(h("button", {
      type: "button", class: `ep-chip${filter.exam === e.id ? " is-active" : ""}`, title: `${e.organization}${e.country ? ` · ${e.country}` : ""} — ${e.skills} skills`,
      onclick: () => { filter.exam = filter.exam === e.id ? "" : e.id; filter.domain = ""; filter.skillId = ""; page = 0; renderHeader(); void loadSkills(); void loadList(); },
    }, e.name, h("span", { class: "ep-chip-count" }, String(e.questions))));
    header.append(cards);
  }
  const stat = (value: string, label: string) => h("div", { class: "ep-stat" }, h("strong", {}, value), h("span", {}, label));

  function renderToolbar() {
    clear(toolbar);
    const active = jobs.filter(j => j.status === "queued" || j.status === "running").length;
    const button = (id: Panel, label: string, primary = false) => h("button", {
      type: "button", class: `ep-btn${primary ? " ep-btn-primary" : ""}${panel === id ? " is-active" : ""}`, "aria-expanded": String(panel === id),
      onclick: () => { panel = panel === id ? "none" : id; renderToolbar(); renderPanel(); },
    }, label);
    toolbar.append(
      button("author", "✦ Write with AI", true), button("source", "🔎 Find on the web"), button("import", "⇪ Import a paper"), button("manual", "✎ Add by hand"),
      button("jobs", active ? `Jobs · ${active} running` : `Jobs${jobs.length ? ` (${jobs.length})` : ""}`),
      h("span", { class: "ep-spacer" }),
      h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: () => exportBank() }, "Export JSON"),
      h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: () => ctx.app.openSettings() }, "Settings"),
    );
  }

  async function exportBank() {
    try {
      const data = await ctx.call<unknown>("bank.export", filter.exam ? { exam: filter.exam } : {});
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = h("a", { href: url, download: `question-bank${filter.exam ? `-${filter.exam}` : ""}.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { flash(errorText(error), "error"); }
  }

  // ── forms ────────────────────────────────────────────────────────────────
  function examSelect(value: string, onChange: (v: string) => void, allowAll = false) {
    return select([...(allowAll ? [{ value: "", label: "All exams" }] : []), ...(overview?.exams ?? []).map(e => ({ value: e.id, label: e.name }))], value, onChange, { class: "ep-input" });
  }
  function skillOptions(rows: SkillRow[], withEmpty: string | undefined) {
    return [...(withEmpty !== undefined ? [{ value: "", label: withEmpty }] : []), ...rows.map(s => ({ value: s.id, label: `${s.name} (${s.questions})`, group: s.domain }))];
  }
  async function skillsFor(exam: string): Promise<SkillRow[]> {
    if (exam === filter.exam && skills.length) return skills;
    return await ctx.call<SkillRow[]>("bank.skills", { exam });
  }

  function renderPanel() {
    clear(panelEl);
    if (panel === "none") return;
    const box = h("section", { class: "ep-panel" });
    panelEl.append(box);
    const close = h("button", { type: "button", class: "ep-icon-btn", "aria-label": "Close", onclick: () => { panel = "none"; renderToolbar(); renderPanel(); } }, "×");
    if (panel === "jobs") { renderJobs(box, close); return; }
    const exam0 = filter.exam || overview?.exams[0]?.id || "sat";
    const state = { exam: exam0, skillId: filter.skillId, difficulty: "3", format: "mcq" as QuestionFormat, count: panel === "author" ? "3" : "5", topic: "", text: "", name: "" };
    const skillHost = h("div");
    const errors = h("div", { class: "ep-form-error", role: "alert" });
    const renderSkillPicker = async (required: boolean) => {
      const rows = await skillsFor(state.exam);
      if (state.skillId && !rows.some(s => s.id === state.skillId)) state.skillId = "";
      if (required && !state.skillId) state.skillId = rows[0]?.id ?? "";
      clear(skillHost);
      skillHost.append(field("Skill", select(skillOptions(rows, required ? undefined : "Any skill (use the topic)"), state.skillId, v => { state.skillId = v; }, { class: "ep-input" })));
    };
    const examField = (required: boolean) => field("Exam", examSelect(state.exam, v => { state.exam = v; state.skillId = ""; void renderSkillPicker(required); }));
    const submit = (label: string, run: () => Promise<void>) => {
      const btn = h("button", { type: "submit", class: "ep-btn ep-btn-primary" }, label);
      return { btn, onsubmit: async (event: Event) => {
        event.preventDefault(); errors.textContent = ""; btn.disabled = true;
        try { await run(); } catch (error) { errors.textContent = errorText(error); } finally { btn.disabled = false; }
      } };
    };
    const started = async (job: BankJob, what: string) => {
      flash(`${what} started — you can keep working; new questions appear here when the job finishes.`);
      jobs = [job, ...jobs.filter(j => j.id !== job.id)];
      panel = "jobs"; renderToolbar(); renderPanel(); scheduleJobPoll();
    };

    if (panel === "author") {
      const { btn, onsubmit } = submit("Write questions", async () => {
        const job = await ctx.call<BankJob>("bank.author", { exam: state.exam, skillId: state.skillId, difficulty: Number(state.difficulty), format: state.format, count: Number(state.count) });
        await started(job, "Writing");
      });
      box.append(h("header", { class: "ep-panel-head" }, h("h2", {}, "Write questions with AI"), close),
        h("p", { class: "ep-hint" }, "An author model writes the questions in the style of the real exam; a separate solver answers each one without seeing the key, and a critic reviews it. Only questions where they agree are marked verified."),
        h("form", { class: "ep-form", onsubmit },
          examField(true), skillHost,
          field("Difficulty", select([1, 2, 3, 4, 5].map(d => ({ value: String(d), label: DIFF[d] ?? String(d) })), state.difficulty, v => { state.difficulty = v; }, { class: "ep-input" })),
          field("Format", select(FORMATS.map(f => ({ value: f, label: FORMAT_LABEL[f] })), state.format, v => { state.format = v as QuestionFormat; }, { class: "ep-input" })),
          field("How many", select(["1", "2", "3", "4", "5"].map(v => ({ value: v, label: v })), state.count, v => { state.count = v; }, { class: "ep-input" }), "Up to 5 per job."),
          h("div", { class: "ep-form-actions" }, btn), errors));
      void renderSkillPicker(true);
    } else if (panel === "source") {
      const topic = h("input", { class: "ep-input", type: "text", placeholder: "e.g. SAT circle equations practice, ESSLCE 2015 chemistry", oninput: () => { state.topic = topic.value; } });
      const { btn, onsubmit } = submit("Search and import", async () => {
        const job = await ctx.call<BankJob>("bank.source", { exam: state.exam, ...(state.skillId ? { skillId: state.skillId } : {}), ...(state.topic.trim() ? { topic: state.topic.trim() } : {}), count: Number(state.count) });
        await started(job, "Web search");
      });
      box.append(h("header", { class: "ep-panel-head" }, h("h2", {}, "Find questions on the web"), close),
        h("p", { class: "ep-hint" }, "The AI searches public pages, extracts exam questions, keeps the page link, title and any license it states with every question, and re-solves each one before it counts as verified. Respect each site's terms — keep sourced questions for your own study."),
        h("form", { class: "ep-form", onsubmit },
          examField(false), skillHost, field("Topic or search words", topic, "Give a topic, a skill, or both."),
          field("How many", select(["3", "5", "8", "10"].map(v => ({ value: v, label: v })), state.count, v => { state.count = v; }, { class: "ep-input" })),
          h("div", { class: "ep-form-actions" }, btn), errors));
      void renderSkillPicker(false);
    } else if (panel === "import") {
      const text = h("textarea", { class: "ep-input", rows: 8, placeholder: "Paste the questions (and answer key, if you have it) here — or choose a PDF / text file above." });
      text.addEventListener("input", () => { state.text = text.value; });
      const file = h("input", { type: "file", accept: ".pdf,.txt,.md,text/plain,application/pdf", class: "ep-input" });
      const fileNote = h("span", { class: "ep-hint" });
      file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (!f) return;
        fileNote.textContent = "Reading…";
        try {
          const converted = await ctx.documents.toMarkdown(f, { signal });
          state.text = converted.markdown; state.name = converted.name; text.value = converted.markdown.slice(0, 200_000);
          fileNote.textContent = `${converted.name}: ${converted.markdown.length.toLocaleString()} characters${converted.notices.length ? ` · ${converted.notices.join(" ")}` : ""}`;
        } catch (error) { fileNote.textContent = errorText(error); }
      });
      const { btn, onsubmit } = submit("Import questions", async () => {
        const job = await ctx.call<BankJob>("bank.import", { exam: state.exam, name: state.name || "Pasted paper", markdown: state.text, ...(state.skillId ? { skill: state.skillId } : {}) });
        await started(job, "Import");
      });
      box.append(h("header", { class: "ep-panel-head" }, h("h2", {}, "Import a past paper or worksheet"), close),
        h("p", { class: "ep-hint" }, "The AI splits the paper into questions, links each to a skill and difficulty, and keys any question whose answer is missing by solving it."),
        h("form", { class: "ep-form", onsubmit },
          examField(false), skillHost, field("File", h("div", {}, file, fileNote)), field("Text", text),
          h("div", { class: "ep-form-actions" }, btn), errors));
      void renderSkillPicker(false);
    } else if (panel === "manual") {
      box.append(h("header", { class: "ep-panel-head" }, h("h2", {}, "Add a question by hand"), close));
      void (async () => box.append(await manualForm(undefined, () => { panel = "none"; renderToolbar(); renderPanel(); void refreshAll(); })))();
    }
  }

  async function manualForm(existing: Question | undefined, done: () => void): Promise<HTMLElement> {
    const exam = existing?.exams[0] ?? (filter.exam || overview?.exams[0]?.id || "sat");
    const s = {
      exam, skillId: existing?.skillId ?? filter.skillId, difficulty: String(existing?.difficulty ?? 3), format: existing?.format ?? ("mcq" as QuestionFormat),
      passage: existing?.passage ?? "", stem: existing?.stem ?? "", explanation: existing?.explanation ?? "",
      choices: (existing?.choices ?? []).map(c => c.text).join("\n"),
      matchTargets: (existing?.matchTargets ?? []).map(c => c.text).join("\n"),
      key: existing ? keyText(existing) : "", rubric: existing?.answer.kind === "rubric" ? existing.answer.rubric : "",
      maxPoints: existing?.answer.kind === "rubric" ? String(existing.answer.maxPoints) : "6",
    };
    const errors = h("div", { class: "ep-form-error", role: "alert" });
    const skillHost = h("div");
    const keyHost = h("div");
    const renderSkills = async () => {
      const rows = await skillsFor(s.exam);
      if (!s.skillId || !rows.some(r => r.id === s.skillId)) s.skillId = rows[0]?.id ?? "";
      clear(skillHost);
      skillHost.append(field("Skill", select(skillOptions(rows, undefined), s.skillId, v => { s.skillId = v; }, { class: "ep-input" })));
    };
    const area = (key: keyof typeof s, rows: number, placeholder: string) => {
      const el = h("textarea", { class: "ep-input", rows, placeholder });
      el.value = s[key]; el.addEventListener("input", () => { (s as Record<string, string>)[key] = el.value; });
      return el;
    };
    const input = (key: keyof typeof s, placeholder: string) => {
      const el = h("input", { class: "ep-input", type: "text", placeholder, value: s[key] });
      el.addEventListener("input", () => { (s as Record<string, string>)[key] = el.value; });
      return el;
    };
    const renderKey = () => {
      clear(keyHost);
      const f = s.format;
      if (f === "mcq" || f === "multi-select" || f === "true-false" || f === "matching") keyHost.append(field(f === "matching" ? "Left items (one per line)" : "Choices (one per line, in order A, B, C…)", area("choices", 4, f === "true-false" ? "True\nFalse\nNot Given" : "First choice\nSecond choice")));
      if (f === "matching") keyHost.append(field("Right items (one per line, numbered 1, 2, 3…)", area("matchTargets", 4, "")));
      if (f === "essay") keyHost.append(field("Rubric", area("rubric", 4, "What a top answer does; how points are given")), field("Max points", input("maxPoints", "6")));
      else keyHost.append(field("Correct answer", input("key", f === "mcq" || f === "true-false" ? "B" : f === "multi-select" ? "A, C" : f === "numeric" ? "12  (alternatives: 12 | 24/2)" : f === "matching" ? "A=2, B=1, C=3" : f === "cloze" ? "first blank | second blank" : "accepted answer | another accepted answer"),
        f === "numeric" ? "Separate equivalent forms with |." : f === "matching" ? "Pair each left letter with a right number." : undefined));
    };
    const { btnSave, onsubmit } = (() => {
      const btnSave = h("button", { type: "submit", class: "ep-btn ep-btn-primary" }, existing ? "Save changes" : "Add question");
      return { btnSave, onsubmit: async (event: Event) => {
        event.preventDefault(); errors.textContent = ""; btnSave.disabled = true;
        try {
          const question = buildManual(s, existing);
          await ctx.call("bank.save", existing ? { id: existing.id, question } : { question });
          flash(existing ? "Question saved." : "Question added.");
          done();
        } catch (error) { errors.textContent = errorText(error); } finally { btnSave.disabled = false; }
      } };
    })();
    const form = h("form", { class: "ep-form ep-form-wide", onsubmit },
      field("Exam", examSelect(s.exam, v => { s.exam = v; s.skillId = ""; void renderSkills(); })), skillHost,
      field("Difficulty", select([1, 2, 3, 4, 5].map(d => ({ value: String(d), label: DIFF[d] ?? String(d) })), s.difficulty, v => { s.difficulty = v; }, { class: "ep-input" })),
      field("Format", select(FORMATS.map(f => ({ value: f, label: FORMAT_LABEL[f] })), s.format, v => { s.format = v as QuestionFormat; renderKey(); }, { class: "ep-input" })),
      h("div", { class: "ep-span" }, field("Passage / data (optional, Markdown + $LaTeX$)", area("passage", 3, "A reading passage, table or figure description shared by the question"))),
      h("div", { class: "ep-span" }, field("Question (Markdown + $LaTeX$)", area("stem", 3, "What is the value of $x$ if $2x + 3 = 11$?"))),
      h("div", { class: "ep-span" }, keyHost),
      h("div", { class: "ep-span" }, field("Worked explanation", area("explanation", 3, "Subtract 3 from both sides…"))),
      h("div", { class: "ep-form-actions ep-span" }, btnSave, existing ? h("button", { type: "button", class: "ep-btn", onclick: done }, "Cancel") : null), errors);
    renderKey();
    await renderSkills();
    return form;
  }

  function renderJobs(box: HTMLElement, close: HTMLElement) {
    box.append(h("header", { class: "ep-panel-head" }, h("h2", {}, "Background jobs"),
      h("span", { class: "ep-spacer" }),
      jobs.some(j => !["queued", "running"].includes(j.status)) ? h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { await ctx.call("bank.clearJobs", {}); await loadJobs(); } }, "Clear finished") : null, close));
    if (!jobs.length) { box.append(h("p", { class: "ep-empty" }, "No jobs yet. Write, find or import questions to start one.")); return; }
    const table = h("div", { class: "ep-jobs" });
    for (const job of jobs) {
      const req = (job.request ?? {}) as Record<string, unknown>;
      const what = job.kind === "author" ? `Write ${String(req.count ?? "")} × ${FORMAT_LABEL[(req.format as QuestionFormat) ?? "mcq"] ?? ""}` : job.kind === "source" ? `Web: ${String(req.topic ?? req.skillId ?? "")}` : job.kind === "import" ? `Import: ${String(req.name ?? "paper")}` : `Re-check ${Array.isArray(req.ids) ? req.ids.length : ""} question(s)`;
      const pct = job.progress && job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : job.status === "succeeded" ? 100 : 0;
      table.append(h("div", { class: `ep-job is-${job.status}` },
        h("div", { class: "ep-job-main" },
          h("strong", {}, what), h("span", { class: "ep-hint" }, `${examName(String(req.exam ?? ""))} · ${relativeTime(job.createdAt)}${job.progress?.stage ? ` · ${job.progress.stage}` : ""}`),
          job.error ? h("span", { class: "ep-form-error" }, job.error) : null,
          job.status === "succeeded" ? h("span", { class: "ep-hint" }, `${job.produced.length} question${job.produced.length === 1 ? "" : "s"} added`) : null),
        h("div", { class: "ep-progress", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("span", { style: `width:${pct}%` })),
        h("span", { class: `ep-badge ep-job-status is-${job.status}` }, job.status),
        job.status === "queued" || job.status === "running" ? h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { await ctx.call("bank.cancel", { id: job.id }); await loadJobs(); } }, "Cancel") : null));
    }
    box.append(table);
  }

  // ── filters + list ──────────────────────────────────────────────────────
  function renderFilters() {
    clear(filters);
    const domains = [...new Set(skills.map(s => s.domain))];
    const rows = filter.domain ? skills.filter(s => s.domain === filter.domain) : skills;
    const reload = () => { page = 0; void loadList(); };
    const search = h("input", { class: "ep-input ep-search", type: "search", placeholder: "Search questions…", value: filter.search, "aria-label": "Search questions" });
    let debounce: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener("input", () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { filter.search = search.value; reload(); }, 250); });
    filters.append(
      search,
      examSelect(filter.exam, v => { filter.exam = v; filter.domain = ""; filter.skillId = ""; renderHeader(); void loadSkills(); reload(); }, true),
      select([{ value: "", label: "All domains" }, ...domains.map(d => ({ value: d, label: d }))], filter.domain, v => { filter.domain = v; filter.skillId = ""; renderFilters(); reload(); }, { class: "ep-input", disabled: !filter.exam, title: filter.exam ? "" : "Choose an exam first" }),
      select(skillOptions(rows, "All skills"), filter.skillId, v => { filter.skillId = v; reload(); }, { class: "ep-input", disabled: !filter.exam }),
      select([{ value: "", label: "Any status" }, ...(["verified", "unverified", "disputed"] as const).map(s => ({ value: s, label: STATUS_LABEL[s] }))], filter.status, v => { filter.status = v; reload(); }, { class: "ep-input" }),
      select([{ value: "", label: "Any difficulty" }, ...[1, 2, 3, 4, 5].map(d => ({ value: String(d), label: DIFF[d] ?? String(d) }))], filter.difficulty, v => { filter.difficulty = v; reload(); }, { class: "ep-input" }),
      select([{ value: "", label: "Any format" }, ...FORMATS.map(f => ({ value: f, label: FORMAT_LABEL[f] }))], filter.format, v => { filter.format = v; reload(); }, { class: "ep-input" }),
    );
    if (filter.skillId) {
      const s = skills.find(x => x.id === filter.skillId);
      if (s) filters.append(h("div", { class: "ep-skill-strip" },
        h("strong", {}, s.name), h("span", {}, `${s.domain} · ${s.questions} question${s.questions === 1 ? "" : "s"} (${s.verified} verified)`),
        s.attempts ? h("span", {}, `Your accuracy: ${Math.round((s.correct / s.attempts) * 100)}% of ${s.attempts}`) : null,
        h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: () => { panel = "author"; renderToolbar(); renderPanel(); } }, "Write more for this skill")));
    }
  }

  function renderList(rows: QuestionSummary[], total: number) {
    clear(list); clear(pager);
    if (!rows.length) {
      list.append(h("div", { class: "ep-empty" }, h("p", {}, total === 0 && !Object.values(filter).some(Boolean) ? "The bank is empty." : "No questions match these filters."),
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => { panel = "author"; renderToolbar(); renderPanel(); } }, "Write some with AI")));
      return;
    }
    list.append(h("div", { class: "ep-count" }, `${total} question${total === 1 ? "" : "s"}`));
    for (const row of rows) list.append(questionCard(row));
    const pages = Math.ceil(total / PAGE);
    if (pages > 1) pager.append(
      h("button", { type: "button", class: "ep-btn", disabled: page === 0, onclick: () => { page--; void loadList(); } }, "← Previous"),
      h("span", {}, `Page ${page + 1} of ${pages}`),
      h("button", { type: "button", class: "ep-btn", disabled: page >= pages - 1, onclick: () => { page++; void loadList(); } }, "Next →"));
  }

  function questionCard(row: QuestionSummary): HTMLElement {
    const card = h("article", { class: `ep-card${expanded === row.id ? " is-open" : ""}` });
    const head = h("button", { type: "button", class: "ep-card-head", "aria-expanded": String(expanded === row.id), onclick: () => { expanded = expanded === row.id ? undefined : row.id; card.replaceWith(questionCard(row)); } });
    const stem = h("div", { class: "ep-card-stem" });
    md(stem, row.stem);
    head.append(
      h("div", { class: "ep-card-meta" },
        h("span", { class: `ep-badge is-${row.status}` }, STATUS_LABEL[row.status]),
        h("span", { class: "ep-badge" }, row.exams.map(examName).join(", ")),
        h("span", { class: "ep-badge ep-badge-skill", title: row.domain }, row.skillName),
        h("span", { class: "ep-badge" }, `D${row.difficulty}`),
        h("span", { class: "ep-badge" }, FORMAT_LABEL[row.format]),
        h("span", { class: "ep-badge ep-badge-source" }, SOURCE_LABEL[row.source] ?? row.source),
        row.attempts ? h("span", { class: "ep-hint" }, `${row.correct}/${row.attempts} correct`) : null),
      stem);
    card.append(head);
    if (expanded === row.id) {
      const body = h("div", { class: "ep-card-body" }, h("p", { class: "ep-hint" }, "Loading…"));
      card.append(body);
      void ctx.call<{ question: Question; skill?: Skill; stats: { attempts: number; correct: number; seconds: number } }>("bank.get", { id: row.id })
        .then(({ question, skill, stats }) => { clear(body); renderDetail(body, question, skill, stats, row); })
        .catch(error => { body.textContent = errorText(error); });
    }
    return card;
  }

  function renderDetail(body: HTMLElement, q: Question, skill: Skill | undefined, stats: { attempts: number; correct: number; seconds: number }, row: QuestionSummary) {
    const tryHost = h("div", { class: "ep-try" });
    const result = h("div", { class: "ep-result", role: "status" });
    const reveal = h("div", { class: "ep-reveal" });
    let given: unknown;
    mountQuestion(tryHost, q, { md, eliminator: true, onAnswer: a => { given = a; } });
    const showKey = (verdict?: boolean | null) => {
      clear(reveal); clear(result);
      if (verdict !== undefined) result.append(h("strong", { class: verdict ? "is-correct" : verdict === null ? "" : "is-wrong" }, verdict ? "✓ Correct" : verdict === null ? "This one is graded by rubric — compare with the guidance below." : "✗ Not quite"));
      const key = h("div", { class: "ep-key" }); md(key, `**Answer:** ${describeKey(q)}`);
      const exp = h("div", { class: "ep-explanation" }); md(exp, q.explanation);
      reveal.append(key, exp);
    };
    const src = q.source;
    const checks = q.verification.checks;
    body.append(
      tryHost,
      h("div", { class: "ep-row" },
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => showKey(gradeResponse(q, given)) }, "Check answer"),
        h("button", { type: "button", class: "ep-btn", onclick: () => showKey() }, "Show answer"), result),
      reveal,
      h("dl", { class: "ep-facts" },
        h("dt", {}, "Skill"), h("dd", {}, `${skill?.name ?? q.skillId} · ${skill?.domain ?? ""}`),
        h("dt", {}, "Source"), h("dd", {}, SOURCE_LABEL[src.kind] ?? src.kind,
          src.url ? [" · ", h("a", { href: src.url, target: "_blank", rel: "noopener noreferrer" }, src.title || src.url)] : src.title ? ` · ${src.title}` : "",
          src.publisher ? ` · ${src.publisher}` : "", src.license ? ` · License: ${src.license}` : "", src.model ? ` · ${src.model}` : "", src.retrievedAt ? ` · retrieved ${new Date(src.retrievedAt).toLocaleDateString()}` : ""),
        h("dt", {}, "Checks"), h("dd", {}, checks.length ? checks.map(c => `${c.by}: ${c.verdict}${c.notes ? ` (${c.notes})` : ""}`).join(" · ") : "Not checked yet"),
        h("dt", {}, "Your history"), h("dd", {}, stats.attempts ? `${stats.correct} of ${stats.attempts} correct · avg ${Math.round(stats.seconds / stats.attempts)} s` : "Not attempted yet")),
      h("div", { class: "ep-row ep-actions" },
        h("button", { type: "button", class: "ep-btn", onclick: async () => { try { const job = await ctx.call<BankJob>("bank.verify", { ids: [q.id] }); jobs = [job, ...jobs]; flash("Re-checking with an independent solver and critic…"); scheduleJobPoll(); renderToolbar(); } catch (e) { flash(errorText(e), "error"); } } }, "Re-check with AI"),
        q.verification.status !== "verified" ? h("button", { type: "button", class: "ep-btn", onclick: () => setStatus("verified") }, "Mark verified") : null,
        q.verification.status !== "disputed" ? h("button", { type: "button", class: "ep-btn", onclick: () => setStatus("disputed") }, "Report a problem") : null,
        h("button", { type: "button", class: "ep-btn", onclick: async () => { clear(body); body.append(await manualForm(q, () => { void loadList(); })); } }, "Edit"),
        h("span", { class: "ep-spacer" }),
        h("button", { type: "button", class: "ep-btn ep-btn-danger", onclick: async () => { if (!confirm("Delete this question from the bank?")) return; await ctx.call("bank.delete", { id: q.id }); expanded = undefined; flash("Question deleted."); void loadList(); void loadOverview(); } }, "Delete")),
    );
    async function setStatus(status: VerificationStatus) {
      const note = status === "disputed" ? prompt("What is wrong with this question? (optional)") ?? "" : "";
      try { await ctx.call("bank.setStatus", { id: q.id, status, note }); flash(status === "verified" ? "Marked verified." : "Marked disputed — it will not be used in simulations."); expanded = row.id; void loadList(); void loadOverview(); }
      catch (e) { flash(errorText(e), "error"); }
    }
  }

  renderToolbar();
  void refreshAll();
}

function keyText(q: Question): string {
  const k = q.answer;
  switch (k.kind) {
    case "choice": return k.correct.join(", ");
    case "numeric": return [String(k.value), ...(k.accepted ?? [])].join(" | ");
    case "text": return q.format === "cloze" ? (k.accepted[0] ?? "") : k.accepted.join(" | ");
    case "matching": return Object.entries(k.pairs).map(([l, r]) => `${l}=${r}`).join(", ");
    case "rubric": return "";
  }
}

/** Form state → question payload for bank.save (the backend validates fully). */
export function buildManual(s: { exam: string; skillId: string; difficulty: string; format: QuestionFormat; passage: string; stem: string; explanation: string; choices: string; matchTargets: string; key: string; rubric: string; maxPoints: string }, existing?: Question): Record<string, unknown> {
  const lines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);
  const f = s.format;
  const out: Record<string, unknown> = {
    ...(existing ?? {}), exams: existing?.exams?.includes(s.exam) ? existing.exams : [s.exam], skillId: s.skillId, difficulty: Number(s.difficulty), format: f,
    passage: s.passage, stem: s.stem, explanation: s.explanation,
  };
  delete out.choices; delete out.matchTargets;
  if (!s.stem.trim()) throw new Error("Write the question first.");
  if (!s.explanation.trim()) throw new Error("Add a worked explanation so learners can learn from mistakes.");
  if (f === "mcq" || f === "multi-select" || f === "true-false" || f === "matching") {
    const choices = lines(s.choices);
    if (choices.length < 2) throw new Error("Give at least two choices, one per line.");
    out.choices = choices.map((text, i) => ({ id: String.fromCharCode(65 + i), text }));
  }
  if (f === "matching") {
    const targets = lines(s.matchTargets);
    out.matchTargets = targets.map((text, i) => ({ id: String(i + 1), text }));
    const pairs: Record<string, string> = {};
    for (const part of s.key.split(/[,;]/)) { const [l, r] = part.split(/[=:→>-]+/).map(x => x.trim()); if (l && r) pairs[l.toUpperCase()] = r; }
    out.answer = { kind: "matching", pairs };
  } else if (f === "mcq" || f === "multi-select" || f === "true-false") {
    out.answer = { kind: "choice", correct: s.key.split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean) };
  } else if (f === "numeric") {
    const parts = s.key.split("|").map(x => x.trim()).filter(Boolean);
    const value = Number(parts[0]?.includes("/") ? Number(parts[0].split("/")[0]) / Number(parts[0].split("/")[1]) : parts[0]);
    if (!Number.isFinite(value)) throw new Error("The correct answer must be a number (e.g. 12, -3.5 or 3/4).");
    out.answer = { kind: "numeric", value, ...(parts.length > 1 || parts[0]?.includes("/") ? { accepted: parts } : {}) };
  } else if (f === "essay") {
    out.answer = { kind: "rubric", rubric: s.rubric.trim(), maxPoints: Math.max(1, Number(s.maxPoints) || 6) };
  } else {
    out.answer = { kind: "text", accepted: f === "cloze" ? [s.key.trim()] : s.key.split("|").map(x => x.trim()).filter(Boolean) };
  }
  return out;
}

function mountBankSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): void {
  const root = h("div", { class: "exam-bank ep-settings" });
  container.append(root);
  const note = h("p", { class: "ep-status", role: "status" });
  void (async () => {
    let settings = await ctx.call<{ modelOverride: PluginModelSpec | null; hasSearchKey: boolean }>("bank.settings.get", {});
    const save = async (patch: Record<string, unknown>, text: string) => {
      try { settings = await ctx.call("bank.settings.set", patch); note.textContent = text; render(); }
      catch (error) { note.textContent = errorText(error); }
    };
    const render = () => {
      clear(root);
      const pickerHost = h("div");
      root.append(
        h("h3", {}, "Question Bank model"),
        h("p", { class: "ep-hint" }, settings.modelOverride ? `Using ${settings.modelOverride.provider}/${settings.modelOverride.id} for writing, solving and checking questions.` : "Following the app's cheap model slot (Settings → Agent → Models). Pick a model to override it for Exam Prep only."),
        pickerHost,
        settings.modelOverride ? h("button", { type: "button", class: "ep-btn", onclick: () => save({ modelOverride: null }, "Back to the cheap model slot.") }, "Use the app default") : "",
        h("h3", {}, "Web search"),
        h("p", { class: "ep-hint" }, settings.hasSearchKey ? "A Tavily API key is saved (it never leaves the server)." : "Without a key, Find on the web uses a free keyless search. A Tavily key (free tier available) gives better results."),
      );
      try { ctx.ui.mountModelPicker(pickerHost, { value: settings.modelOverride ?? undefined, onChange: value => save({ modelOverride: value }, "Model saved.") }, { signal }); }
      catch { pickerHost.textContent = "The model picker is unavailable here."; }
      const key = h("input", { class: "ep-input", type: "password", placeholder: settings.hasSearchKey ? "•••••••• (saved)" : "tvly-…", autocomplete: "off" });
      root.append(h("div", { class: "ep-row" }, key,
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => save({ searchKey: key.value }, key.value ? "Search key saved." : "Search key removed.") }, "Save key"),
        settings.hasSearchKey ? h("button", { type: "button", class: "ep-btn", onclick: () => save({ searchKey: "" }, "Search key removed.") }, "Remove") : null));
      root.append(note);
    };
    render();
  })().catch(error => { root.textContent = errorText(error); });
}
