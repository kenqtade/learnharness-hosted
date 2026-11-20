// Graph Lab UI — the 2-D workspace: expression rows, sliders, the canvas and
// the calculus / points-of-interest tools.
import { createExpression, GRAPH_COLORS } from "../engine/state.ts";
import { parseExpression } from "../engine/expressions.ts";
import { interestLabel } from "../engine/analysis.ts";
import { GraphPanel, type AnalysisReport, type GraphFlags } from "./graph.ts";
import { mountSliders, type SliderControls } from "./sliders.ts";
import { button, checkRow, colorValue, element, ensureOptions, formatNumber, numberInput, textInput } from "./dom.ts";
import type { PanelOptions } from "./types.ts";

interface RowNodes {
  root: HTMLElement;
  input: HTMLInputElement;
  error: HTMLElement;
  eye: HTMLButtonElement;
  dot: HTMLInputElement;
}

export function mount2D(host: HTMLElement, options: PanelOptions): () => void {
  const { state, signal } = options;
  ensureOptions(state);
  const root = element("div", { className: "graph-lab-2d" });
  const list = element("div", { className: "graph-lab-list" });
  const rowsHost = element("div", { className: "graph-lab-rows" });
  const sliderHost = element("div", { className: "graph-lab-slider-host" });
  const analysisHost = element("div", { className: "graph-lab-analysis" });
  const optionsHost = element("div", { className: "graph-lab-options" });
  const canvasWrap = element("div", { className: "graph-lab-canvas-wrap" });
  const toolbar = element("div", { className: "graph-lab-calculus" });

  const listHead = element("div", { className: "graph-lab-list-head" }, [
    element("h3", { className: "graph-lab-list-title", textContent: "Expressions" }),
    button("+ Add", () => addRow(state.expressions.length), { className: "graph-lab-small-button" }),
  ]);
  list.append(listHead, rowsHost, element("div", { className: "graph-lab-section-title", textContent: "Sliders" }), sliderHost,
    element("div", { className: "graph-lab-section-title", textContent: "Points of interest" }), analysisHost, optionsHost);
  root.append(list, canvasWrap);
  host.append(root);

  const rowNodes = new Map<string, RowNodes>();
  let selectedId: string | undefined;
  let flags: GraphFlags = {};
  let analysisKey = "";
  let focusId: string | undefined;
  let sliders: SliderControls | undefined;

  const panel = new GraphPanel(canvasWrap, {
    state,
    signal,
    onStateChange: () => {
      options.onChange();
      sliders?.refresh();
    },
    onSelect: id => select(id),
    onAnalysis: report => {
      updateErrors();
      sliders?.refresh();
      updateAnalysis(report);
    },
  });

  sliders = mountSliders(sliderHost, {
    state,
    editable: true,
    onChange: () => panel.requestDraw(),
    onCommit: () => options.onChange(),
  });

  /* ------------------------------- rows ---------------------------------- */

  function select(id: string | undefined): void {
    selectedId = id;
    panel.select(id);
    flags = {};
    panel.setFlags(flags);
    syncRows();
    renderCalculus();
  }

  function updateErrors(): void {
    const errors = new Map(panel.errors.map(entry => [entry.id, entry.message]));
    for (const [id, nodes] of rowNodes) {
      const message = nodes.input.value.trim() ? errors.get(id) : undefined;
      nodes.error.hidden = !message;
      nodes.error.textContent = message ?? "";
    }
  }

  function syncRows(): void {
    for (const expression of state.expressions) {
      const nodes = rowNodes.get(expression.id);
      if (!nodes) continue;
      nodes.eye.textContent = expression.hidden ? "○" : "◉";
      nodes.eye.setAttribute("aria-label", `${expression.hidden ? "Show" : "Hide"} ${expression.text || "row"}`);
      nodes.eye.setAttribute("aria-pressed", String(!expression.hidden));
      const index = state.expressions.indexOf(expression);
      nodes.dot.value = colorValue(expression.color, index);
      nodes.root.classList.toggle("is-selected", expression.id === selectedId);
    }
  }

  function renderRows(): void {
    rowsHost.replaceChildren();
    rowNodes.clear();
    state.expressions.forEach((expression, index) => {
      const dot = element("input", { type: "color", className: "graph-lab-color", value: colorValue(expression.color, index) });
      dot.setAttribute("aria-label", `Colour of expression ${index + 1}`);
      dot.addEventListener("input", () => {
        expression.color = dot.value;
        panel.requestDraw();
        options.onChange();
      });
      const input = textInput(expression.text, `Expression ${index + 1}`);
      input.addEventListener("focus", () => select(expression.id));
      input.addEventListener("input", () => {
        expression.text = input.value;
        panel.requestDraw();
        options.onChange();
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          addRow(index + 1);
        } else if (event.key === "Backspace" && input.value === "" && state.expressions.length > 1) {
          event.preventDefault();
          removeRow(expression.id);
        }
      });
      const eye = button(expression.hidden ? "○" : "◉", () => {
        expression.hidden = !expression.hidden;
        syncRows();
        panel.requestDraw();
        options.onChange();
      }, { className: "graph-lab-icon-button", title: "Show or hide this row" });
      const up = button("↑", () => moveRow(index, -1), { className: "graph-lab-icon-button", title: "Move up" });
      up.setAttribute("aria-label", `Move expression ${index + 1} up`);
      const down = button("↓", () => moveRow(index, 1), { className: "graph-lab-icon-button", title: "Move down" });
      down.setAttribute("aria-label", `Move expression ${index + 1} down`);
      const remove = button("×", () => removeRow(expression.id), { className: "graph-lab-icon-button", title: "Delete row" });
      remove.setAttribute("aria-label", `Delete expression ${index + 1}`);
      const error = element("p", { className: "graph-lab-row-error" });
      error.setAttribute("role", "alert");
      error.hidden = true;
      const line = element("div", { className: "graph-lab-row-line" }, [dot, input, eye, up, down, remove]);
      const row = element("div", { className: "graph-lab-row" }, [line, error]);
      row.dataset.id = expression.id;
      rowsHost.append(row);
      rowNodes.set(expression.id, { root: row, input, error, eye, dot });
    });
    syncRows();
    if (focusId) {
      const nodes = rowNodes.get(focusId);
      focusId = undefined;
      nodes?.input.focus();
    }
  }

  function addRow(index: number): void {
    const expression = createExpression("", GRAPH_COLORS[state.expressions.length % GRAPH_COLORS.length]);
    state.expressions.splice(index, 0, expression);
    focusId = expression.id;
    renderRows();
    panel.requestDraw();
    options.onChange();
  }

  function removeRow(id: string): void {
    const index = state.expressions.findIndex(expression => expression.id === id);
    if (index < 0) return;
    state.expressions.splice(index, 1);
    if (!state.expressions.length) state.expressions.push(createExpression("", GRAPH_COLORS[0]));
    if (selectedId === id) select(undefined);
    renderRows();
    panel.requestDraw();
    options.onChange();
  }

  function moveRow(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= state.expressions.length) return;
    const [expression] = state.expressions.splice(index, 1);
    if (!expression) return;
    state.expressions.splice(target, 0, expression);
    renderRows();
    panel.requestDraw();
    options.onChange();
  }

  /* ----------------------------- analysis -------------------------------- */

  function updateAnalysis(report: AnalysisReport): void {
    const key = report.points.map(point => `${point.kind}:${point.x.toFixed(5)}:${point.y.toFixed(5)}`).join("|") + `#${report.text}`;
    if (key === analysisKey) return;
    analysisKey = key;
    const text = report.text || (selectedId ? "No points of interest in this view." : "Click a curve to find zeros, extrema and intersections.");
    const paragraph = element("p", { className: "graph-lab-analysis-text", textContent: text });
    const items: HTMLElement[] = [paragraph];
    if (report.points.length) {
      const list = element("ul", { className: "graph-lab-analysis-list" });
      for (const point of report.points.slice(0, 16)) {
        list.append(element("li", { textContent: interestLabel(point) }));
      }
      items.push(list);
    }
    if (report.integral) {
      items.push(element("p", { className: "graph-lab-analysis-value", textContent: `∫ from ${formatNumber(report.integral.a, 4)} to ${formatNumber(report.integral.b, 4)} = ${formatNumber(report.integral.value, 6)}` }));
    }
    analysisHost.replaceChildren(...items);
  }

  function renderCalculus(): void {
    toolbar.replaceChildren();
    const expression = state.expressions.find(entry => entry.id === selectedId);
    if (!expression) {
      toolbar.append(element("p", { className: "graph-lab-hint", textContent: "Select a row, then click its curve to trace zeros, extrema and intersections." }));
      return;
    }
    const parsed = parseExpression(expression.text);
    if (parsed.kind !== "explicit" || parsed.error) {
      toolbar.append(element("p", { className: "graph-lab-hint", textContent: "Calculus tools apply to y = f(x) rows. Select or add one." }));
      return;
    }
    const apply = (next: GraphFlags) => {
      flags = { ...flags, ...next };
      panel.setFlags(flags);
    };
    const derivative = checkRow("f′(x)", flags.derivative === true, checked => {
      flags = { ...flags, derivative: checked };
      panel.setFlags(flags);
    });
    const tangentX = numberInput(flags.tangentX ?? 1, "Tangent x", { step: "any" });
    const tangent = button("Tangent", () => apply({ tangentX: Number(tangentX.value) }), { className: "graph-lab-small-button" });
    const from = numberInput(flags.integral?.a ?? 0, "Integral from", { step: "any" });
    const to = numberInput(flags.integral?.b ?? 1, "Integral to", { step: "any" });
    const integral = button("∫ a→b", () => apply({ integral: { a: Number(from.value), b: Number(to.value) } }), { className: "graph-lab-small-button" });
    const clear = button("Clear", () => {
      flags = {};
      panel.setFlags(flags);
      renderCalculus();
    }, { className: "graph-lab-small-button" });
    toolbar.append(
      element("span", { className: "graph-lab-toolbar-label", textContent: "Calculus" }),
      derivative,
      element("span", { className: "graph-lab-inline" }, [element("span", { textContent: "x =" }), tangentX, tangent]),
      element("span", { className: "graph-lab-inline" }, [from, element("span", { textContent: "→" }), to, integral]),
      clear,
    );
  }

  /* ----------------------------- options --------------------------------- */

  function renderOptions(): void {
    const current = ensureOptions(state);
    optionsHost.replaceChildren(
      element("div", { className: "graph-lab-section-title", textContent: "View" }),
      checkRow("Grid", current.grid, checked => {
        ensureOptions(state).grid = checked;
        panel.requestDraw();
        options.onChange();
      }),
      checkRow("π ticks", current.piTicks, checked => {
        ensureOptions(state).piTicks = checked;
        panel.requestDraw();
        options.onChange();
      }),
      checkRow("Degrees", current.degrees, checked => {
        ensureOptions(state).degrees = checked;
        panel.requestDraw();
        options.onChange();
      }),
    );
  }

  renderRows();
  renderCalculus();
  renderOptions();

  return () => {
    sliders?.dispose();
    panel.dispose();
    root.remove();
  };
}
