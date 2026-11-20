// Graph Lab — the full screen: mode tabs, the workspace and saved graphs.
import type { PluginFrontendContext } from "learnharness-plugin-api";
import {
  cloneGraphState, defaultGraphState, parseGraphState, type GraphMode, type GraphState,
} from "../engine/state.ts";
import { button, element, ensureOptions, textInput } from "./dom.ts";
import { mountModePanel, type LabTab } from "./modes.ts";

interface SavedGraphInfo {
  id: string;
  name: string;
  state: unknown;
  createdAt?: string;
  updatedAt?: string;
}

interface ListResult {
  revision: number;
  graphs: SavedGraphInfo[];
}

interface Settings {
  defaultMode?: GraphMode;
  degrees?: boolean;
}

const TABS: { tab: LabTab; label: string }[] = [
  { tab: "2d", label: "2D" },
  { tab: "complex", label: "Complex" },
  { tab: "matrix", label: "Matrix" },
  { tab: "3d", label: "3D" },
  { tab: "calculator", label: "Calculator" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mountLab(container: HTMLElement, ctx: PluginFrontendContext, signal: AbortSignal): () => void {
  container.classList.add("graph-lab-host");
  const root = element("div", { className: "graph-lab" });
  const tabList = element("div", { className: "graph-lab-tabs", role: "tablist" });
  const body = element("div", { className: "graph-lab-body" });
  const savedDetails = element("details", { className: "graph-lab-saved" });
  const savedSummary = element("summary", { className: "graph-lab-saved-summary", textContent: "Saved graphs" });
  const savedBody = element("div", { className: "graph-lab-saved-body" });
  const nameInput = textInput("", "Graph name", { placeholder: "Graph name" });
  const saveButton = button("Save", () => void saveGraph(), { className: "graph-lab-small-button" });
  const status = element("p", { className: "graph-lab-status", textContent: "" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const savedList = element("ul", { className: "graph-lab-saved-list" });
  savedBody.append(element("div", { className: "graph-lab-inline" }, [nameInput, saveButton]), status, savedList);
  savedDetails.append(savedSummary, savedBody);
  root.append(tabList, savedDetails, body);
  container.replaceChildren(root);

  let state: GraphState = defaultGraphState("2d");
  ensureOptions(state);
  let tab: LabTab = "2d";
  let currentSavedId: string | undefined;
  let confirmDelete: string | undefined;
  let disposed = false;
  let touched = false;
  let disposePanel: (() => void) | undefined;
  let savedTicket = 0;

  const tabButtons = new Map<LabTab, HTMLButtonElement>();
  for (const entry of TABS) {
    const node = button(entry.label, () => selectTab(entry.tab), { className: "graph-lab-tab" });
    node.setAttribute("role", "tab");
    tabButtons.set(entry.tab, node);
    tabList.append(node);
  }

  function setStatus(message: string, isError = false): void {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function render(): void {
    if (disposed) return;
    for (const [name, node] of tabButtons) {
      const active = name === tab;
      node.setAttribute("aria-selected", String(active));
      node.classList.toggle("is-active", active);
    }
    disposePanel?.();
    body.replaceChildren();
    const host = element("div", { className: "graph-lab-panel" });
    body.append(host);
    disposePanel = mountModePanel(tab, host, {
      state,
      signal,
      onChange: () => { touched = true; },
    });
  }

  function selectTab(next: LabTab): void {
    if (next === tab) return;
    tab = next;
    if (next !== "calculator") state.mode = next;
    render();
  }

  function replaceState(next: GraphState): void {
    state = next;
    ensureOptions(state);
    tab = state.mode;
    render();
  }

  /* ----------------------------- saved graphs ---------------------------- */

  function renderSaved(graphs: SavedGraphInfo[]): void {
    savedList.replaceChildren();
    if (!graphs.length) {
      savedList.append(element("li", { className: "graph-lab-saved-empty", textContent: "No saved graphs yet." }));
      return;
    }
    for (const graph of graphs) {
      const item = element("li", { className: "graph-lab-saved-item" });
      const label = element("span", { className: "graph-lab-saved-name", textContent: graph.name });
      const open = button("Open", () => openGraph(graph), { className: "graph-lab-small-button" });
      open.setAttribute("aria-label", `Open ${graph.name}`);
      const remove = button(confirmDelete === graph.id ? "Confirm" : "Delete", () => void deleteGraph(graph.id), {
        className: `graph-lab-small-button${confirmDelete === graph.id ? " is-danger" : ""}`,
      });
      remove.setAttribute("aria-label", `Delete ${graph.name}`);
      item.append(label, open, remove);
      savedList.append(item);
    }
  }

  async function refreshSaved(): Promise<void> {
    const ticket = ++savedTicket;
    try {
      const result = await ctx.call<ListResult>("graphs.list");
      if (disposed || signal.aborted || ticket !== savedTicket) return;
      renderSaved(Array.isArray(result?.graphs) ? result.graphs : []);
    } catch (error) {
      if (!disposed && !signal.aborted) setStatus(`Could not load saved graphs: ${errorText(error)}`, true);
    }
  }

  async function saveGraph(): Promise<void> {
    const name = nameInput.value.trim() || (currentSavedId ? "" : `Graph ${new Date().toLocaleDateString()}`);
    if (!name) { setStatus("Give the graph a name first.", true); nameInput.focus(); return; }
    saveButton.disabled = true;
    try {
      const result = await ctx.call<{ graph: { id: string; name: string } }>("graphs.save", {
        ...(currentSavedId ? { id: currentSavedId } : {}),
        name,
        state: cloneGraphState(state),
      });
      if (disposed || signal.aborted) return;
      currentSavedId = result.graph.id;
      nameInput.value = result.graph.name;
      setStatus(`Saved “${result.graph.name}”.`);
      await refreshSaved();
    } catch (error) {
      if (!disposed && !signal.aborted) setStatus(`Could not save: ${errorText(error)}`, true);
    } finally {
      saveButton.disabled = false;
    }
  }

  function openGraph(graph: SavedGraphInfo): void {
    try {
      replaceState(parseGraphState(graph.state));
      currentSavedId = graph.id;
      nameInput.value = graph.name;
      confirmDelete = undefined;
      setStatus(`Opened “${graph.name}”.`);
      void refreshSaved();
    } catch (error) {
      setStatus(`Could not open this graph: ${errorText(error)}`, true);
    }
  }

  async function deleteGraph(id: string): Promise<void> {
    if (confirmDelete !== id) {
      confirmDelete = id;
      setStatus("Press Delete again to confirm.");
      void refreshSaved();
      return;
    }
    confirmDelete = undefined;
    try {
      await ctx.call("graphs.delete", { id });
      if (disposed || signal.aborted) return;
      if (currentSavedId === id) currentSavedId = undefined;
      setStatus("Deleted.");
      await refreshSaved();
    } catch (error) {
      if (!disposed && !signal.aborted) setStatus(`Could not delete: ${errorText(error)}`, true);
    }
  }

  /* -------------------------------- start -------------------------------- */

  render();
  void refreshSaved();
  void (async () => {
    const [settings, stash] = await Promise.all([
      ctx.call<Settings>("settings.get").catch(() => undefined),
      ctx.call<{ state: unknown }>("graphs.unstash").catch(() => undefined),
    ]);
    if (disposed || signal.aborted || touched) return;
    if (stash?.state) {
      try {
        replaceState(parseGraphState(stash.state));
        setStatus("Opened the graph from the lesson.");
        return;
      } catch { /* fall through to defaults */ }
    }
    if (settings) {
      ensureOptions(state).degrees = settings.degrees === true;
      tab = settings.defaultMode ?? "2d";
      render();
    }
  })();

  return () => {
    if (disposed) return;
    disposed = true;
    disposePanel?.();
    root.remove();
    container.classList.remove("graph-lab-host");
  };
}
