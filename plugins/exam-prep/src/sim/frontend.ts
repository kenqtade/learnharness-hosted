// Exam Simulator view: choose an exam (built-in or AI-built profile), set it up
// (sections, strict/practice, timing, tools, length), wait while missing
// questions are written, take it on the exam screen, then review the results.
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { TOOLS, type Attempt, type ExamProfile, type Question, type Skill, type ToolId } from "../shared/contract.ts";
import { append, clear, errorText, field, formatDuration, h, relativeTime, type Child, type MarkdownMount } from "../shared/dom.ts";
import { describeAnswer, describeKey, FORMAT_LABEL, mountQuestion } from "../shared/question-view.ts";
import { mountExamScreen, TOOL_LABEL, type AttemptView } from "./exam-screen.ts";

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>`;

interface ProfileSummary {
  id: string; name: string; country: string; organization: string; description: string; builtIn: boolean;
  sections: { id: string; name: string; questions: number; minutes: number; tools: ToolId[]; notSimulated?: string }[];
  verifiedQuestions: number; attempts: number; best?: number; scoreLabel?: string;
}
interface HistoryRow { id: string; profileId: string; profileName: string; status: Attempt["status"]; mode: string; sections: string[]; score?: Attempt["score"]; scoreLabel?: string; createdAt: string; updatedAt: string; questions: number }
interface Build { id: string; status: "searching" | "running" | "ready" | "failed" | "saved"; request: { name: string; country?: string; notes?: string }; sources: { title: string; url: string }[]; profile?: ExamProfile; skills?: Skill[]; error?: string; createdAt: string }
interface Review extends AttemptView { questions: Question[]; skills: Record<string, Skill>; sections: { id: string; name: string }[] }

type Route = { name: "home" } | { name: "setup"; profileId: string } | { name: "attempt"; id: string } | { name: "results"; id: string } | { name: "build" } | { name: "edit"; profile: ExamProfile; skills?: Skill[]; buildId?: string };

const FLAG: Record<string, string> = { US: "🇺🇸", GB: "🇬🇧", ET: "🇪🇹", International: "🌐" };

export function activateSimFrontend(ctx: PluginFrontendContext): void {
  ctx.registerView({ id: "exams", name: "Exam Simulator", mount: (container, signal) => mountSim(ctx, container, signal) });
  ctx.registerAction({ id: "open-exams", name: "Exam Simulator", icon: ICON, run: () => ctx.app.openView("exams") });
  ctx.placeAction({ id: "sidebar-exams", actionId: "open-exams", location: "sidebar" });
}

function mountSim(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): void {
  const md: MarkdownMount = (el, text) => { try { ctx.ui.mountMarkdown(el, { text }, { signal }); } catch { el.textContent = text; } };
  const root = h("div", { class: "exam-sim ep-root" });
  container.append(root);
  const put = (...children: Child[]) => append(root, children);
  let screen = new AbortController();
  signal.addEventListener("abort", () => screen.abort());

  const go = (route: Route) => {
    screen.abort(); screen = new AbortController();
    const s = screen.signal;
    clear(root);
    root.scrollIntoView?.({ block: "start" });
    const render = async () => {
      switch (route.name) {
        case "home": return home(s);
        case "setup": return setup(route.profileId, s);
        case "attempt": return attempt(route.id, s);
        case "results": return results(route.id, s);
        case "build": return build(s);
        case "edit": return edit(route.profile, route.skills, route.buildId);
      }
    };
    render().catch(error => { put(h("div", { class: "ep-status is-error", role: "alert" }, errorText(error)), h("button", { type: "button", class: "ep-btn", onclick: () => go({ name: "home" }) }, "Back to exams")); });
  };
  const back = (label = "← All exams") => h("button", { type: "button", class: "ep-btn ep-btn-ghost ep-back", onclick: () => go({ name: "home" }) }, label);
  const poll = (s: AbortSignal, ms: number, fn: () => Promise<boolean>) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => { if (s.aborted) return; let again = true; try { again = await fn(); } catch { /* retry */ } if (again && !s.aborted) t = setTimeout(loop, ms); };
    s.addEventListener("abort", () => { if (t) clearTimeout(t); });
    t = setTimeout(loop, ms);
  };

  // ── home ────────────────────────────────────────────────────────────────
  async function home(s: AbortSignal) {
    const [profiles, history, builds] = await Promise.all([
      ctx.call<ProfileSummary[]>("sim.profiles", {}), ctx.call<HistoryRow[]>("sim.history", {}), ctx.call<Build[]>("sim.builds", {}),
    ]);
    if (s.aborted) return;
    put(h("header", { class: "ep-header" }, h("div", { class: "ep-title" }, h("h1", {}, "Exam Simulator"),
      h("p", { class: "ep-sub" }, "Realistic timed simulations of official exams — the real structure, timing, question types, adaptive modules and exactly the tools each section allows. Questions come from your verified Question Bank; missing ones are written for you first."))));
    const open = history.filter(r => ["preparing", "ready", "in-progress"].includes(r.status));
    if (open.length) {
      put(h("h2", { class: "ep-h2" }, "Your tests"));
      const list = h("div", { class: "ep-attempts" });
      for (const r of open) list.append(h("div", { class: "ep-attempt-row" },
        h("div", {}, h("strong", {}, r.profileName), h("span", { class: "ep-hint" }, ` · ${r.sections.join(", ")} · ${r.mode} · ${relativeTime(r.createdAt)}`)),
        h("span", { class: `ep-badge is-${r.status}` }, r.status === "in-progress" ? "In progress" : r.status === "preparing" ? "Preparing" : "Ready"),
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => go({ name: "attempt", id: r.id }) }, r.status === "in-progress" ? "Resume" : "Open"),
        h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { if (!confirm("Abandon this test?")) return; await ctx.call("sim.abandon", { id: r.id }); go({ name: "home" }); } }, "Abandon")));
      put(list);
    }
    put(h("h2", { class: "ep-h2" }, "Choose an exam"));
    const grid = h("div", { class: "ep-profile-grid" });
    for (const p of profiles) {
      const simulated = p.sections.filter(x => !x.notSimulated);
      grid.append(h("article", { class: "ep-profile-card" },
        h("div", { class: "ep-profile-head" }, h("span", { class: "ep-flag-icon", "aria-hidden": "true" }, FLAG[p.country] ?? "📝"), h("div", {}, h("h3", {}, p.name), h("span", { class: "ep-hint" }, `${p.organization}${p.country ? ` · ${p.country}` : ""}`))),
        h("p", { class: "ep-profile-desc" }, p.description),
        h("div", { class: "ep-section-chips" }, ...p.sections.map(x => h("span", { class: `ep-chip${x.notSimulated ? " is-muted" : ""}`, title: x.notSimulated ?? `${x.questions} questions · ${x.minutes} min${x.tools.length ? ` · ${x.tools.map(t => TOOL_LABEL[t]).join(", ")}` : ""}` }, x.name, x.notSimulated ? "" : h("span", { class: "ep-chip-count" }, `${x.questions}q · ${x.minutes}m`)))),
        h("div", { class: "ep-profile-foot" },
          h("span", { class: "ep-hint" }, `${simulated.reduce((n, x) => n + x.questions, 0)} questions · ${formatDuration(simulated.reduce((n, x) => n + x.minutes, 0) * 60)} · ${p.verifiedQuestions} in your bank${p.best !== undefined ? ` · best ${p.best}` : ""}`),
          h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => go({ name: "setup", profileId: p.id }) }, "Set up test"))));
    }
    grid.append(h("article", { class: "ep-profile-card ep-profile-new" },
      h("h3", {}, "＋ Any other exam"), h("p", { class: "ep-profile-desc" }, "Name any official exam from any country — the AI researches its format (sections, timing, question types, allowed tools, scoring) and builds a profile you can review and edit."),
      h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => go({ name: "build" }) }, "Build a profile")));
    put(grid);
    if (builds.some(b => b.status !== "saved")) {
      put(h("h2", { class: "ep-h2" }, "Profiles being built"));
      const list = h("div", { class: "ep-attempts" });
      for (const b of builds.filter(x => x.status !== "saved")) list.append(buildRow(b));
      put(list);
      if (builds.some(b => b.status === "searching" || b.status === "running")) poll(s, 5000, async () => { const next = await ctx.call<Build[]>("sim.builds", {}); if (next.some(b => b.status === "ready" || b.status === "failed")) { go({ name: "home" }); return false; } return true; });
    }
    const done = history.filter(r => r.status === "scored" || r.status === "submitted");
    if (done.length) {
      put(h("h2", { class: "ep-h2" }, "Results"));
      const list = h("div", { class: "ep-attempts" });
      for (const r of done.slice(0, 30)) list.append(h("div", { class: "ep-attempt-row" },
        h("div", {}, h("strong", {}, r.profileName), h("span", { class: "ep-hint" }, ` · ${r.sections.join(", ")} · ${r.mode} · ${new Date(r.updatedAt).toLocaleDateString()}`)),
        h("span", { class: "ep-score-pill" }, r.score?.total !== undefined ? `${r.score.total}${r.score.band ? ` (${r.score.band})` : ""}` : "—", h("small", {}, r.scoreLabel ?? "")),
        r.status === "submitted" ? h("span", { class: "ep-badge" }, "Grading essays…") : null,
        h("button", { type: "button", class: "ep-btn", onclick: () => go({ name: "results", id: r.id }) }, "Review")));
      put(list);
    }
    if (profiles.length < 7) put(h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { await ctx.call("sim.restoreProfiles", {}); go({ name: "home" }); } }, "Show hidden built-in exams"));
  }

  function buildRow(b: Build): HTMLElement {
    return h("div", { class: "ep-attempt-row" },
      h("div", {}, h("strong", {}, b.request.name), h("span", { class: "ep-hint" }, ` · ${relativeTime(b.createdAt)}${b.error ? ` · ${b.error}` : ""}`)),
      h("span", { class: `ep-badge is-${b.status}` }, b.status === "searching" ? "Researching…" : b.status === "running" ? "Designing…" : b.status === "ready" ? "Ready to review" : "Failed"),
      b.status === "ready" && b.profile ? h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => go({ name: "edit", profile: b.profile!, ...(b.skills ? { skills: b.skills } : {}), buildId: b.id }) }, "Review") : null,
      h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { await ctx.call("sim.deleteBuild", { id: b.id }); go({ name: "home" }); } }, "Remove"));
  }

  // ── AI profile builder ──────────────────────────────────────────────────
  async function build(s: AbortSignal) {
    const name = h("input", { class: "ep-input", type: "text", placeholder: "e.g. TOEFL iBT, Kenya KCSE Mathematics, Gaokao Mathematics, JEE Main, Abitur Mathematik" });
    const country = h("input", { class: "ep-input", type: "text", placeholder: "Country (optional)" });
    const notes = h("textarea", { class: "ep-input", rows: 3, placeholder: "Anything specific: year, stream, paper, a link to the official format page…" });
    const status = h("div", { class: "ep-status", role: "status" });
    const button = h("button", { type: "submit", class: "ep-btn ep-btn-primary" }, "Research and build");
    put(back(), h("h1", {}, "Build a profile for any exam"),
      h("p", { class: "ep-sub" }, "The AI searches the web for the official format, reads the top pages, and proposes a profile: sections, modules, question counts, minutes, question types, the tools each section allows, breaks, adaptive rules and the score scale, plus a skill list for the Question Bank. You review and edit it before it is saved."),
      h("form", { class: "ep-form", onsubmit: async (event: Event) => {
        event.preventDefault(); button.disabled = true; status.textContent = "Researching the official format… this takes about a minute.";
        try {
          const b = await ctx.call<Build>("sim.buildProfile", { name: name.value, country: country.value, notes: notes.value });
          if (b.status === "failed") throw new Error(b.error ?? "The build failed.");
          status.textContent = "Designing the profile…";
          poll(s, 4000, async () => {
            const next = await ctx.call<Build>("sim.build", { id: b.id });
            if (next.status === "ready" && next.profile) { go({ name: "edit", profile: next.profile, ...(next.skills ? { skills: next.skills } : {}), buildId: next.id }); return false; }
            if (next.status === "failed") { status.textContent = next.error ?? "The build failed."; button.disabled = false; return false; }
            return true;
          });
        } catch (error) { status.textContent = errorText(error); button.disabled = false; }
      } }, field("Exam", name), field("Country", country), field("Notes", notes), h("div", { class: "ep-form-actions" }, button), status));
  }

  // ── profile editor (review AI builds, customise built-ins) ──────────────
  async function edit(initial: ExamProfile, skills: Skill[] | undefined, buildId: string | undefined) {
    const p: ExamProfile = structuredClone(initial);
    const status = h("div", { class: "ep-status", role: "status" });
    const num = (value: number, onChange: (n: number) => void, attrs: Record<string, string | number> = {}) => {
      const el = h("input", { class: "ep-input ep-num", type: "number", value, ...attrs });
      el.addEventListener("change", () => onChange(Number(el.value)));
      return el;
    };
    const text = (value: string, onChange: (v: string) => void) => { const el = h("input", { class: "ep-input", type: "text", value }); el.addEventListener("input", () => onChange(el.value)); return el; };
    const sections = h("div", { class: "ep-edit-sections" });
    const renderSections = () => {
      clear(sections);
      for (const sec of p.sections) {
        const box = h("section", { class: "ep-panel" }, h("header", { class: "ep-panel-head" }, h("h3", {}, sec.name), sec.notSimulated ? h("span", { class: "ep-hint" }, `Not simulated: ${sec.notSimulated}`) : null,
          h("span", { class: "ep-spacer" }), h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: () => { p.sections = p.sections.filter(x => x !== sec); renderSections(); } }, "Remove section")));
        for (const m of sec.modules) box.append(h("div", { class: "ep-row" }, h("strong", {}, m.name),
          field("Questions", num(m.questionCount, n => { m.questionCount = Math.max(1, Math.round(n)); }, { min: 1, max: 300 })),
          field("Minutes", num(m.minutes, n => { m.minutes = Math.max(0, n); }, { min: 0, max: 600 })),
          h("span", { class: "ep-hint" }, `${m.formats.map(f => `${FORMAT_LABEL[f.format] ?? f.format} ${Math.round(f.share * 100)}%`).join(", ")}${m.adaptive ? " · adaptive" : ""}`)));
        const toolRow = h("div", { class: "ep-tools-row" }, h("span", { class: "ep-field-label" }, "Allowed tools (strict mode):"));
        for (const t of TOOLS) {
          const cb = h("input", { type: "checkbox", checked: sec.tools.includes(t) });
          cb.addEventListener("change", () => { sec.tools = cb.checked ? [...sec.tools, t] : sec.tools.filter(x => x !== t); });
          toolRow.append(h("label", { class: "ep-check" }, cb, TOOL_LABEL[t]));
        }
        box.append(toolRow);
        sections.append(box);
      }
    };
    renderSections();
    const json = h("textarea", { class: "ep-input ep-json", rows: 16 });
    const advanced = h("details", { class: "ep-advanced" }, h("summary", {}, "Advanced: edit the full profile as JSON"), json,
      h("button", { type: "button", class: "ep-btn", onclick: () => { try { Object.assign(p, JSON.parse(json.value)); renderSections(); status.textContent = "JSON applied."; } catch (error) { status.textContent = `Invalid JSON: ${errorText(error)}`; } } }, "Apply JSON"));
    advanced.addEventListener("toggle", () => { if ((advanced as HTMLDetailsElement).open) json.value = JSON.stringify(p, null, 2); });
    put(back(), h("h1", {}, buildId ? `Review: ${p.name}` : `Customise: ${p.name}`),
      h("p", { class: "ep-sub" }, buildId ? "Check the structure against the official exam before saving. You can change counts, minutes and allowed tools here, or anything in the JSON." : "Changes apply to new tests. Reset returns to the built-in profile."),
      h("div", { class: "ep-form" }, field("Name", text(p.name, v => { p.name = v; })), field("Country", text(p.country, v => { p.country = v; })), field("Organization", text(p.organization, v => { p.organization = v; }))),
      p.rules?.length ? h("ul", { class: "ep-rules" }, ...p.rules.map(r => h("li", {}, r))) : null,
      p.sourceUrls?.length ? h("p", { class: "ep-hint" }, "Sources: ", ...p.sourceUrls.flatMap((u, i) => [i ? ", " : "", h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, new URL(u).hostname)])) : null,
      skills?.length ? h("p", { class: "ep-hint" }, `${skills.length} skills will be added to the Question Bank for this exam.`) : null,
      sections, advanced,
      h("div", { class: "ep-row" },
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: async () => {
          try { const saved = await ctx.call<ExamProfile>("sim.saveProfile", { profile: p, ...(skills ? { skills } : {}), ...(buildId ? { buildId } : {}) }); go({ name: "setup", profileId: saved.id }); }
          catch (error) { status.textContent = errorText(error); }
        } }, "Save profile"),
        !buildId && p.builtIn ? h("button", { type: "button", class: "ep-btn", onclick: async () => { await ctx.call("sim.deleteProfile", { id: p.id }); go({ name: "setup", profileId: p.id }); } }, "Reset to built-in") : null,
        h("button", { type: "button", class: "ep-btn ep-btn-danger", onclick: async () => { if (!confirm(p.builtIn ? "Hide this exam from the list?" : "Delete this profile?")) return; if (!buildId) await ctx.call("sim.deleteProfile", { id: p.id, hide: true }); go({ name: "home" }); } }, buildId ? "Discard" : p.builtIn ? "Hide exam" : "Delete profile")),
      status);
  }

  // ── setup ───────────────────────────────────────────────────────────────
  async function setup(profileId: string, s: AbortSignal) {
    const p = await ctx.call<ExamProfile>("sim.profile", { id: profileId });
    if (s.aborted) return;
    const simulated = p.sections.filter(x => x.modules.length && !x.notSimulated);
    const state = { sections: new Set(simulated.map(x => x.id)), mode: "strict" as "strict" | "practice", time: 1, scale: 1, tools: new Set<ToolId>(), generate: true, allowUnverified: false };
    const summary = h("div", { class: "ep-summary" });
    const practiceBox = h("div", { class: "ep-practice-box" });
    const status = h("div", { class: "ep-status", role: "status" });
    const official = () => [...new Set(simulated.filter(x => state.sections.has(x.id)).flatMap(x => x.tools))];
    const suggest = async () => {
      try { const r = await ctx.call<{ practice: ToolId[] }>("sim.suggestTools", { profileId, sectionIds: [...state.sections] }); state.tools = new Set(r.practice); }
      catch { state.tools = new Set(official()); }
    };
    await suggest();
    const update = () => {
      clear(summary);
      const chosen = simulated.filter(x => state.sections.has(x.id));
      const questions = chosen.reduce((n, x) => n + x.modules.reduce((m, y) => m + Math.max(1, Math.round(y.questionCount * state.scale)), 0), 0);
      const minutes = state.mode === "practice" && state.time === 0 ? 0 : chosen.reduce((n, x) => n + x.modules.reduce((m, y) => m + (y.minutes * Math.max(1, Math.round(y.questionCount * state.scale))) / y.questionCount, 0), 0) * (state.mode === "practice" ? state.time : 1);
      summary.append(h("strong", {}, `${questions} questions`), " · ", minutes ? `${formatDuration(minutes * 60)} of testing` : "untimed",
        " · tools: ", (state.mode === "strict" ? official() : [...state.tools]).map(t => TOOL_LABEL[t]).join(", ") || "none");
      clear(practiceBox);
      if (state.mode === "practice") {
        const timeRow = h("div", { class: "ep-seg", role: "radiogroup", "aria-label": "Time" });
        for (const [v, label] of [[1, "Standard time"], [1.25, "×1.25"], [1.5, "×1.5"], [2, "×2"], [0, "Untimed"]] as [number, string][])
          timeRow.append(h("button", { type: "button", role: "radio", "aria-checked": String(state.time === v), class: `ep-seg-btn${state.time === v ? " is-on" : ""}`, onclick: () => { state.time = v; update(); } }, label));
        const toolRow = h("div", { class: "ep-tools-row" });
        for (const t of TOOLS) {
          const cb = h("input", { type: "checkbox", checked: state.tools.has(t) });
          cb.addEventListener("change", () => { if (cb.checked) state.tools.add(t); else state.tools.delete(t); update(); });
          toolRow.append(h("label", { class: `ep-check${official().includes(t) ? " is-official" : ""}`, title: official().includes(t) ? "Allowed in the real exam" : "Extra help for practice" }, cb, TOOL_LABEL[t]));
        }
        practiceBox.append(field("Time", timeRow), field("Tools", toolRow, "Bold tools are allowed in the real exam; the AI suggests extras for practice."));
      } else {
        practiceBox.append(h("ul", { class: "ep-rules" }, ...simulated.filter(x => state.sections.has(x.id)).map(x => h("li", {}, h("strong", {}, `${x.name}: `), x.tools.length ? x.tools.map(t => TOOL_LABEL[t]).join(", ") : "no tools"))));
      }
    };
    const sectionList = h("div", { class: "ep-section-pick" });
    for (const sec of p.sections) {
      if (!sec.modules.length || sec.notSimulated) { sectionList.append(h("label", { class: "ep-check is-disabled", title: sec.notSimulated ?? "" }, h("input", { type: "checkbox", disabled: true }), `${sec.name} — not simulated`, sec.notSimulated ? h("span", { class: "ep-hint" }, ` (${sec.notSimulated})`) : null)); continue; }
      const cb = h("input", { type: "checkbox", checked: true });
      cb.addEventListener("change", async () => { if (cb.checked) state.sections.add(sec.id); else state.sections.delete(sec.id); await suggest(); update(); });
      sectionList.append(h("label", { class: "ep-check" }, cb, h("span", {}, h("strong", {}, sec.name), h("span", { class: "ep-hint" }, ` · ${sec.modules.map(m => `${m.questionCount} q / ${m.minutes} min`).join(" + ")}${sec.modules.some(m => m.adaptive) ? " · adaptive" : ""}`))));
    }
    const modeRow = h("div", { class: "ep-seg", role: "radiogroup", "aria-label": "Mode" });
    const renderMode = () => {
      clear(modeRow);
      for (const [v, label, hint] of [["strict", "Strict", "Official timing and tools, no pausing"], ["practice", "Practice", "Extra time, pausing, extra tools"]] as const)
        modeRow.append(h("button", { type: "button", role: "radio", "aria-checked": String(state.mode === v), class: `ep-seg-btn${state.mode === v ? " is-on" : ""}`, title: hint, onclick: () => { state.mode = v; state.allowUnverified = v === "practice"; unverified.checked = state.allowUnverified; renderMode(); update(); } }, h("strong", {}, label), h("small", {}, hint)));
    };
    renderMode();
    const lengthRow = h("div", { class: "ep-seg", role: "radiogroup", "aria-label": "Length" });
    const renderLength = () => {
      clear(lengthRow);
      for (const [v, label] of [[1, "Full length"], [0.5, "Half"], [0.25, "Quarter"], [0.1, "Mini (10%)"]] as [number, string][])
        lengthRow.append(h("button", { type: "button", role: "radio", "aria-checked": String(state.scale === v), class: `ep-seg-btn${state.scale === v ? " is-on" : ""}`, onclick: () => { state.scale = v; renderLength(); update(); } }, label));
    };
    renderLength();
    const generate = h("input", { type: "checkbox", checked: true });
    generate.addEventListener("change", () => { state.generate = generate.checked; });
    const unverified = h("input", { type: "checkbox", checked: false });
    unverified.addEventListener("change", () => { state.allowUnverified = unverified.checked; });
    const start = h("button", { type: "button", class: "ep-btn ep-btn-primary ep-btn-lg", onclick: async () => {
      if (!state.sections.size) { status.textContent = "Choose at least one section."; return; }
      start.disabled = true; status.textContent = "Assembling your test…";
      try {
        const v = await ctx.call<AttemptView>("sim.createAttempt", { profileId, sectionIds: [...state.sections], mode: state.mode, timeMultiplier: state.time, questionCountScale: state.scale, tools: [...state.tools], generate: state.generate, allowUnverified: state.allowUnverified });
        go({ name: "attempt", id: v.attempt.id });
      } catch (error) { status.textContent = errorText(error); start.disabled = false; }
    } }, "Assemble test");
    put(back(),
      h("header", { class: "ep-header" }, h("div", { class: "ep-title" }, h("h1", {}, p.name), h("p", { class: "ep-sub" }, `${p.organization}${p.country ? ` · ${p.country}` : ""} — ${p.description}`)),
        h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: () => go({ name: "edit", profile: p }) }, "Customise profile")),
      p.rules?.length ? h("details", { class: "ep-advanced", open: true }, h("summary", {}, "About this exam"), h("ul", { class: "ep-rules" }, ...p.rules.map(r => h("li", {}, r)))) : null,
      h("div", { class: "ep-setup" },
        field("Sections", sectionList), field("Mode", modeRow), practiceBox, field("Length", lengthRow, "Shorter tests keep the official time per question."),
        h("div", { class: "ep-checks" }, h("label", { class: "ep-check" }, generate, "Write missing questions with AI before the test (takes a few minutes)"),
          h("label", { class: "ep-check" }, unverified, "Also use questions that are not verified yet")),
        summary, h("div", { class: "ep-row" }, start), status));
    update();
  }

  // ── attempt: preparing → ready → exam ───────────────────────────────────
  async function attempt(id: string, s: AbortSignal) {
    const v = await ctx.call<AttemptView>("sim.attempt", { id });
    if (s.aborted) return;
    const a = v.attempt;
    if (a.status === "scored" || a.status === "submitted") { go({ name: "results", id }); return; }
    if (a.status === "abandoned") { put(back(), h("h1", {}, "This test was abandoned"), a.notes ? h("p", {}, a.notes) : null); return; }
    if (a.status === "in-progress") { mountExamScreen(ctx, root, v, md, s, next => { go(next.attempt.status === "scored" || next.attempt.status === "submitted" ? { name: "results", id } : { name: "home" }); }); return; }
    const total = v.modules.reduce((n, m) => n + m.count, 0), planned = v.modules.reduce((n, m) => n + m.planned, 0);
    put(back(), h("h1", {}, v.profile?.name ?? "Your test"));
    if (a.status === "preparing") {
      const p = a.preparing ?? { done: 0, total: 1, jobIds: [] };
      const pct = Math.round((p.done / Math.max(1, p.total)) * 100);
      put(h("div", { class: "ep-panel ep-prep" },
        h("h2", {}, "Preparing your test"),
        h("p", {}, `The bank had ${total} of the ${planned} questions this test needs. The AI is writing the rest — each new question is solved independently and checked before use. ${p.done} of ${p.total} batches done.`),
        h("div", { class: "ep-progress ep-progress-lg", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("span", { style: `width:${pct}%` })),
        h("p", { class: "ep-hint" }, "You can leave this page; preparation continues in the background. You can also start now with the questions that are ready."),
        h("div", { class: "ep-row" }, h("button", { type: "button", class: "ep-btn", onclick: async () => { try { await ctx.call("sim.start", { id }); go({ name: "attempt", id }); } catch (error) { alert(errorText(error)); } } }, "Start now with what is ready"))));
      poll(s, 4000, async () => { const next = await ctx.call<AttemptView>("sim.attempt", { id }); if (next.attempt.status !== "preparing" || (next.attempt.preparing?.done ?? 0) !== p.done) { go({ name: "attempt", id }); return false; } return true; });
      return;
    }
    // ready
    put(h("div", { class: "ep-panel ep-ready" },
      h("h2", {}, "Ready"),
      h("table", { class: "ep-table" }, h("thead", {}, h("tr", {}, h("th", {}, "Section"), h("th", {}, "Module"), h("th", {}, "Questions"), h("th", {}, "Time"))),
        h("tbody", {}, ...v.modules.map(m => h("tr", {}, h("td", {}, m.sectionName), h("td", {}, m.moduleName), h("td", {}, m.count ? `${m.count}${m.count < m.planned ? ` of ${m.planned}` : ""}` : m.planned ? "adaptive — chosen after module 1" : "0"), h("td", {}, m.minutes ? `${m.minutes} min` : "untimed"))))),
      total < planned && !v.modules.some(m => !m.count && m.planned) ? h("p", { class: "ep-hint" }, `Only ${total} of ${planned} questions were available — the timer is shortened to match.`) : null,
      v.profile?.rules.length ? h("ul", { class: "ep-rules" }, ...v.profile.rules.map(r => h("li", {}, r))) : null,
      h("p", {}, `Mode: ${a.setup.mode === "strict" ? "strict — the clock cannot be paused" : "practice"} · Tools: ${a.setup.tools.map(t => TOOL_LABEL[t]).join(", ") || "none"}`),
      h("div", { class: "ep-row" }, h("button", { type: "button", class: "ep-btn ep-btn-primary ep-btn-lg", onclick: async () => {
        try { await ctx.call("sim.start", { id }); go({ name: "attempt", id }); } catch (error) { alert(errorText(error)); }
      } }, "Begin test"))));
  }

  // ── results ─────────────────────────────────────────────────────────────
  async function results(id: string, s: AbortSignal) {
    const r = await ctx.call<Review>("sim.review", { id });
    if (s.aborted) return;
    const a = r.attempt, score = a.score;
    const byId = new Map(r.questions.map(q => [q.id, q]));
    put(back(), h("h1", {}, `${r.profile?.name ?? "Results"}`), h("p", { class: "ep-sub" }, `${a.setup.mode === "strict" ? "Strict" : "Practice"} · ${new Date(a.updatedAt).toLocaleString()}`));
    if (a.status === "submitted") {
      put(h("div", { class: "ep-status is-info" }, `Grading ${score?.pending ?? "your"} essay response${score?.pending === 1 ? "" : "s"} with the official rubric… scores update automatically.`));
      poll(s, 5000, async () => { const next = await ctx.call<AttemptView>("sim.attempt", { id }); if (next.attempt.status === "scored") { go({ name: "results", id }); return false; } return true; });
    }
    const sectionName = (sid: string) => r.sections.find(x => x.id === sid)?.name ?? sid;
    put(h("div", { class: "ep-score-hero" },
      h("div", { class: "ep-score-big" }, h("strong", {}, score?.total !== undefined ? String(score.total) : "—"), h("span", {}, r.profile?.scoring.label ?? "Score"), score?.band ? h("em", {}, score.band) : null),
      h("div", { class: "ep-score-sections" }, ...Object.entries(score?.sections ?? {}).map(([sid, x]) => h("div", { class: "ep-stat" }, h("strong", {}, x.scaled !== undefined ? String(x.scaled) : "—"), h("span", {}, sectionName(sid)), h("small", {}, `${x.raw} / ${x.max} correct`))))));
    const routes = r.modules.filter(m => m.route);
    if (routes.length) put(h("p", { class: "ep-hint" }, routes.map(m => `${m.sectionName} ${m.moduleName}: ${m.route} module`).join(" · ")));
    // Skills
    const skills = Object.entries(score?.skills ?? {}).map(([sid, x]) => ({ id: sid, ...x, skill: r.skills[sid] })).sort((x, y) => x.correct / x.total - y.correct / y.total);
    if (skills.length) {
      const list = h("div", { class: "ep-skill-bars" });
      for (const sk of skills) {
        const pct = Math.round((sk.correct / sk.total) * 100);
        list.append(h("div", { class: "ep-skill-bar" }, h("span", { class: "ep-skill-name", title: sk.skill?.domain ?? "" }, sk.skill?.name ?? sk.id, h("small", {}, sk.skill?.domain ?? "")),
          h("span", { class: "ep-bar" }, h("span", { class: pct >= 70 ? "is-good" : pct >= 40 ? "is-mid" : "is-low", style: `width:${Math.max(3, pct)}%` })), h("span", { class: "ep-skill-pct" }, `${Math.round(sk.correct * 10) / 10}/${sk.total}`)));
      }
      put(h("h2", { class: "ep-h2" }, "Skills (weakest first)"), list,
        h("div", { class: "ep-row" }, h("button", { type: "button", class: "ep-btn", onclick: () => ctx.app.openView("bank") }, "Practise in the Question Bank"),
          h("span", { class: "ep-hint" }, "Or ask your tutor — it can see these results and teach your weakest skills first.")));
    }
    const totalSeconds = Object.values(a.responses).reduce((n, x) => n + x.seconds, 0);
    put(h("p", { class: "ep-hint" }, `Time spent answering: ${formatDuration(totalSeconds)} · average ${r.questions.length ? Math.round(totalSeconds / r.questions.length) : 0} s per question`));
    // Question review
    let filter: "all" | "wrong" | "flagged" | "blank" = "all";
    const listHost = h("div", { class: "ep-review-list" });
    const filters = h("div", { class: "ep-seg" });
    const renderFilters = () => {
      clear(filters);
      for (const [v, label] of [["all", "All"], ["wrong", "Incorrect"], ["flagged", "Marked"], ["blank", "Unanswered"]] as const)
        filters.append(h("button", { type: "button", class: `ep-seg-btn${filter === v ? " is-on" : ""}`, onclick: () => { filter = v; renderFilters(); renderList(); } }, label));
    };
    const renderList = () => {
      clear(listHost);
      let n = 0;
      for (const m of a.modules) for (const qid of m.questionIds) {
        n++;
        const q = byId.get(qid);
        if (!q) continue;
        const resp = a.responses[qid];
        const blank = !resp || resp.answer === undefined || resp.answer === "" || (Array.isArray(resp.answer) && !resp.answer.length);
        const verdict = q.answer.kind === "rubric" ? (typeof resp?.points === "number" ? resp.points / q.answer.maxPoints >= 0.6 : null) : resp?.correct ?? false;
        if (filter === "wrong" && verdict !== false) continue;
        if (filter === "flagged" && !resp?.flagged) continue;
        if (filter === "blank" && !blank) continue;
        const item = h("details", { class: `ep-review-item ${verdict === true ? "is-correct" : verdict === false ? "is-wrong" : ""}` });
        item.append(h("summary", {},
          h("span", { class: "ep-q-number" }, String(n)),
          h("span", { class: "ep-verdict" }, verdict === true ? "✓" : verdict === false ? "✗" : "…"),
          h("span", { class: "ep-review-skill" }, r.skills[q.skillId]?.name ?? q.skillId),
          h("span", { class: "ep-hint" }, `${sectionName(m.sectionId)} · D${q.difficulty} · ${Math.round(resp?.seconds ?? 0)} s${resp?.flagged ? " · ⚑" : ""}${q.answer.kind === "rubric" && typeof resp?.points === "number" ? ` · ${resp.points}/${q.answer.maxPoints}` : ""}`)));
        let opened = false;
        item.addEventListener("toggle", () => {
          if (opened || !(item as HTMLDetailsElement).open) return;
          opened = true;
          const content = h("div", { class: "ep-review-body" });
          item.append(content);
          mountQuestion(content, q, { md, answer: resp?.answer, eliminated: resp?.eliminated ?? [], disabled: true, reveal: true });
          const your = h("div", { class: "ep-key" }); md(your, `**Your answer:** ${describeAnswer(q, resp?.answer)}`);
          const key = h("div", { class: "ep-key" }); md(key, `**Correct answer:** ${describeKey(q)}`);
          const exp = h("div", { class: "ep-explanation" }); md(exp, q.explanation);
          content.append(your, key);
          if (resp?.feedback) { const fb = h("div", { class: "ep-feedback" }); md(fb, `**Examiner feedback:** ${resp.feedback}`); content.append(fb); }
          content.append(exp, h("p", { class: "ep-hint" }, `Source: ${q.source.kind === "web" ? "" : q.source.kind}`, q.source.url ? h("a", { href: q.source.url, target: "_blank", rel: "noopener noreferrer" }, q.source.title || q.source.url) : q.source.title ?? "", q.source.license ? ` · License: ${q.source.license}` : ""));
        });
        listHost.append(item);
      }
      if (!listHost.children.length) listHost.append(h("p", { class: "ep-empty" }, "No questions in this view."));
    };
    renderFilters(); renderList();
    put(h("h2", { class: "ep-h2" }, "Every question"), filters, listHost,
      h("div", { class: "ep-row" },
        h("button", { type: "button", class: "ep-btn ep-btn-primary", onclick: () => go({ name: "setup", profileId: a.setup.profileId }) }, "Take another test"),
        h("button", { type: "button", class: "ep-btn ep-btn-ghost", onclick: async () => { if (!confirm("Delete this attempt?")) return; await ctx.call("sim.deleteAttempt", { id }); go({ name: "home" }); } }, "Delete attempt")));
  }

  go({ name: "home" });
}
