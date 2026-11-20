// Graph Lab — a ```graph code block: an interactive mini graph inside a lesson,
// with a one-click hand-over to the full Graph Lab view.
import type { PluginCodeBlockProps, PluginFrontendContext } from "learnharness-plugin-api";
import { cloneGraphState, parseGraphState, type GraphState } from "../engine/state.ts";
import { button, element } from "./dom.ts";
import { mountModePanel } from "./modes.ts";

const MODE_LABEL: Record<GraphState["mode"], string> = {
  "2d": "2D", complex: "Complex", matrix: "Matrix", "3d": "3D",
};

export function mountGraphBlock(container: HTMLElement, block: PluginCodeBlockProps, ctx: PluginFrontendContext): () => void {
  container.classList.add("graph-lab-host");
  const root = element("div", { className: "graph-lab-block" });
  let state: GraphState;
  try {
    state = parseGraphState(block.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.append(
      element("p", { className: "graph-lab-block-error", textContent: `This graph could not be read: ${message}`, role: "alert" }),
      element("pre", { className: "graph-lab-block-source", textContent: block.source }),
    );
    container.append(root);
    return () => { root.remove(); container.classList.remove("graph-lab-host"); };
  }

  let disposed = false;
  let disposePanel: (() => void) | undefined;
  const status = element("p", { className: "graph-lab-status" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const open = button("Open in Graph Lab", () => void handOver(), { className: "graph-lab-small-button" });
  const head = element("div", { className: "graph-lab-block-head" }, [
    element("span", { className: "graph-lab-block-title", textContent: "Graph" }),
    element("span", { className: "graph-lab-badge", textContent: MODE_LABEL[state.mode] }),
    open,
  ]);
  const panelHost = element("div", { className: "graph-lab-panel" });
  root.append(head, status, panelHost);
  container.append(root);

  disposePanel = mountModePanel(state.mode, panelHost, {
    state,
    signal: block.signal,
    onChange: () => { /* the block is read-only storage; edits stay local */ },
  });

  async function handOver(): Promise<void> {
    open.disabled = true;
    status.textContent = "Opening…";
    try {
      await ctx.call("graphs.stash", { state: cloneGraphState(state) });
      if (disposed) return;
      ctx.app.openView("lab");
    } catch (error) {
      if (disposed) return;
      status.textContent = `Could not open Graph Lab: ${error instanceof Error ? error.message : String(error)}`;
      status.classList.add("is-error");
    } finally {
      open.disabled = false;
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    disposePanel?.();
    root.remove();
    container.classList.remove("graph-lab-host");
  };
}
