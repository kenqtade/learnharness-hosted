// Graph Lab UI — the complex plane: domain colouring of f(z), vectors, grid
// images under f(z), and nth roots / roots of unity.
import { createExpression, GRAPH_COLORS, type GraphState } from "../engine/state.ts";
import {
  compileComplexFunction, evaluateComplex, formatComplex, gridImages, nthRoots,
  type ComplexValue,
} from "../engine/complex.ts";
import {
  GraphCanvas, clearCanvas, drawArrow, drawComplexImage, drawGrid, drawPoints,
  readPalette, type ScenePoint,
} from "../engine/render.ts";
import { panView, resetView, toScreen, zoomView } from "../engine/viewport.ts";
import { button, checkRow, element, numberInput, textInput } from "./dom.ts";
import type { PanelOptions } from "./types.ts";

const FUNCTION_ROW = /^\s*f\s*\(\s*z\s*\)\s*=\s*/i;
const POINT_PREFIX = /^\s*(?:z|w)\s*=\s*/i;

function functionSource(state: GraphState): string {
  const row = state.expressions.find(expression => FUNCTION_ROW.test(expression.text));
  if (!row) return "z^2";
  const source = row.text.replace(FUNCTION_ROW, "").trim();
  return source || "z^2";
}

function writeFunctionSource(state: GraphState, source: string): void {
  const row = state.expressions.find(expression => FUNCTION_ROW.test(expression.text));
  if (row) row.text = `f(z) = ${source}`;
  else state.expressions.unshift(createExpression(`f(z) = ${source}`, GRAPH_COLORS[0]));
}

function pointValue(text: string): ComplexValue | undefined {
  const trimmed = text.replace(POINT_PREFIX, "").trim();
  return trimmed ? evaluateComplex(trimmed) : undefined;
}

export function mountComplex(host: HTMLElement, options: PanelOptions): () => void {
  const { state, signal } = options;
  const root = element("div", { className: "graph-lab-2d" });
  const side = element("div", { className: "graph-lab-list" });
  const canvasWrap = element("div", { className: "graph-lab-canvas-wrap" });
  root.append(side, canvasWrap);
  host.append(root);

  const canvas = element("canvas", { className: "graph-lab-canvas" });
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Complex plane. Drag to pan, scroll to zoom, arrow keys pan.");
  const trace = element("div", { className: "graph-lab-trace", textContent: "Drag to pan · scroll to zoom" });
  trace.setAttribute("aria-live", "polite");
  const controls = element("div", { className: "graph-lab-zoom" }, [
    button("+", () => zoom(1.3), { className: "graph-lab-icon-button", title: "Zoom in", ariaLabel: "Zoom in" }),
    button("−", () => zoom(1 / 1.3), { className: "graph-lab-icon-button", title: "Zoom out", ariaLabel: "Zoom out" }),
    button("⟲", () => { state.view = resetView(); changed(); }, { className: "graph-lab-icon-button", title: "Reset view", ariaLabel: "Reset view" }),
  ]);
  canvasWrap.append(canvas, trace, controls);
  const graph = new GraphCanvas(canvas);
  const palette = readPalette(root);

  let fzSource = functionSource(state);
  let roots: ComplexValue[] = [];
  let showGridImage = false;
  let frame: number | undefined;
  let disposed = false;
  let drag: { x: number; y: number } | undefined;
  let imageCache: { key: string; image: ReturnType<typeof domainColoring> } | undefined;

  /* ------------------------------- side ---------------------------------- */

  const functionInput = textInput(fzSource, "f of z");
  functionInput.addEventListener("input", () => {
    fzSource = functionInput.value;
    writeFunctionSource(state, fzSource);
    options.onChange();
    requestDraw();
  });
  const functionField = element("label", { className: "graph-lab-field graph-lab-function-field" }, [
    element("span", { textContent: "f(z) =" }), functionInput,
  ]);

  const pointsHost = element("div", { className: "graph-lab-rows" });
  const pointErrors = new Map<string, HTMLElement>();

  function pointRows() {
    return state.expressions.filter(expression => !FUNCTION_ROW.test(expression.text));
  }

  function renderPoints(): void {
    pointsHost.replaceChildren();
    pointErrors.clear();
    pointRows().forEach((expression, index) => {
      const dot = element("span", { className: "graph-lab-dot" });
      dot.style.background = GRAPH_COLORS[(index + 1) % GRAPH_COLORS.length]!;
      const input = textInput(expression.text, `Complex number ${index + 1}`, { placeholder: "1 + 2i" });
      input.addEventListener("input", () => {
        expression.text = input.value;
        options.onChange();
        requestDraw();
      });
      const remove = button("×", () => {
        const position = state.expressions.indexOf(expression);
        if (position >= 0) state.expressions.splice(position, 1);
        if (!pointRows().length) state.expressions.push(createExpression("", GRAPH_COLORS[1]));
        renderPoints();
        options.onChange();
        requestDraw();
      }, { className: "graph-lab-icon-button", title: "Delete point" });
      remove.setAttribute("aria-label", `Delete complex number ${index + 1}`);
      const error = element("p", { className: "graph-lab-row-error" });
      error.setAttribute("role", "alert");
      error.hidden = true;
      pointErrors.set(expression.id, error);
      const row = element("div", { className: "graph-lab-row" }, [
        element("div", { className: "graph-lab-row-line" }, [dot, input, remove]), error,
      ]);
      pointsHost.append(row);
    });
  }

  const addPoint = button("+ Point", () => {
    state.expressions.push(createExpression("", GRAPH_COLORS[(pointRows().length + 1) % GRAPH_COLORS.length]));
    renderPoints();
    options.onChange();
    requestDraw();
    const inputs = pointsHost.querySelectorAll("input");
    inputs[inputs.length - 1]?.focus();
  }, { className: "graph-lab-small-button" });

  const rootCount = numberInput(5, "Number of roots", { min: "2", max: "24", step: "1" });
  const rootBase = textInput("1", "Root base complex number");
  const rootsOutput = element("div", { className: "graph-lab-roots-output" });
  const plotRoots = button("Plot roots", () => {
    const count = Math.max(2, Math.min(24, Math.round(Number(rootCount.value) || 5)));
    const base = evaluateComplex(rootBase.value) ?? { re: 1, im: 0 };
    roots = nthRoots(base, count);
    rootsOutput.replaceChildren(...roots.map(value => element("div", { className: "graph-lab-root-value", textContent: formatComplex(value, 4) })));
    requestDraw();
  }, { className: "graph-lab-small-button" });
  const clearRoots = button("Clear", () => { roots = []; rootsOutput.replaceChildren(); requestDraw(); }, { className: "graph-lab-small-button" });

  const gridImageToggle = checkRow("Image of the grid", false, checked => { showGridImage = checked; requestDraw(); });

  side.append(
    element("div", { className: "graph-lab-list-head" }, [element("h3", { className: "graph-lab-list-title", textContent: "f(z) and points" })]),
    functionField,
    element("p", { className: "graph-lab-hint", textContent: "Hue = argument of f(z), bands = log |f(z)|. Points are complex numbers such as 2 + 3i." }),
    element("div", { className: "graph-lab-section-title" }, [element("span", { textContent: "Points and vectors" }), addPoint]),
    pointsHost,
    element("div", { className: "graph-lab-section-title", textContent: "Roots" }),
    element("div", { className: "graph-lab-inline" }, [rootCount, element("span", { textContent: "of" }), rootBase, plotRoots, clearRoots]),
    rootsOutput,
    gridImageToggle,
  );

  /* ------------------------------ drawing -------------------------------- */

  function requestDraw(): void {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; draw(); });
  }

  function draw(): void {
    if (disposed || signal.aborted) return;
    const size = graph.resize();
    if (size.width < 2 || size.height < 2) return;
    const ctx = graph.context;
    const view = state.view;
    const viewport = graph.viewport(view);
    const fn = compileComplexFunction(fzSource);
    if (fn) {
      const key = `${fzSource}|${view.x[0]},${view.x[1]},${view.y[0]},${view.y[1]}|${size.width}x${size.height}`;
      if (imageCache?.key !== key) {
        imageCache = { key, image: domainColoring(fn, size.width, size.height, view, { maxPixels: 160_000 }) };
      }
      drawComplexImage(ctx, imageCache.image, size.width, size.height);
    } else {
      clearCanvas(ctx, size.width, size.height, palette);
      trace.textContent = "f(z) could not be parsed.";
    }
    drawGrid(ctx, viewport, palette);
    if (fn && showGridImage) {
      ctx.save();
      ctx.strokeStyle = palette.accent;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      for (const curve of gridImages(fn, view, 8, 60)) {
        ctx.beginPath();
        curve.forEach((point, index) => {
          const screen = toScreen(viewport, point.re, point.im);
          if (index === 0) ctx.moveTo(screen.x, screen.y); else ctx.lineTo(screen.x, screen.y);
        });
        ctx.stroke();
      }
      ctx.restore();
    }

    const points: ScenePoint[] = [];
    pointRows().forEach((expression, index) => {
      const value = pointValue(expression.text);
      const error = pointErrors.get(expression.id);
      if (error) {
        error.hidden = !!value || !expression.text.trim();
        error.textContent = value || !expression.text.trim() ? "" : "Not a complex number.";
      }
      if (!value) return;
      const color = GRAPH_COLORS[(index + 1) % GRAPH_COLORS.length]!;
      drawArrow(ctx, viewport, { x: 0, y: 0 }, { x: value.re, y: value.im }, color);
      points.push({ x: value.re, y: value.im, color, label: formatComplex(value), filled: true });
    });
    for (const [index, value] of roots.entries()) {
      const color = GRAPH_COLORS[(index + 3) % GRAPH_COLORS.length]!;
      points.push({ x: value.re, y: value.im, color, label: `root ${index + 1}`, filled: false });
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      const screen = toScreen(viewport, value.re, value.im);
      ctx.beginPath(); ctx.moveTo(toScreen(viewport, 0, 0).x, toScreen(viewport, 0, 0).y); ctx.lineTo(screen.x, screen.y); ctx.stroke();
      ctx.restore();
    }
    drawPoints(ctx, viewport, points, palette);
  }

  function changed(): void {
    options.onChange();
    requestDraw();
  }

  function zoom(factor: number): void {
    state.view = zoomView(state.view, factor, { x: graph.width / 2, y: graph.height / 2 }, { width: graph.width, height: graph.height });
    changed();
  }

  /* --------------------------- interactions ------------------------------ */

  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture?.(event.pointerId);
    drag = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (drag) {
      state.view = panView(state.view, event.clientX - drag.x, event.clientY - drag.y, { width: graph.width, height: graph.height });
      drag = { x: event.clientX, y: event.clientY };
      changed();
      return;
    }
    const viewport = graph.viewport(state.view);
    const world = { x: viewport.view.x[0] + ((event.clientX - rect.left) / Math.max(1, rect.width)) * (viewport.view.x[1] - viewport.view.x[0]), y: viewport.view.y[1] - ((event.clientY - rect.top) / Math.max(1, rect.height)) * (viewport.view.y[1] - viewport.view.y[0]) };
    trace.textContent = `(${world.x.toFixed(2)}, ${world.y.toFixed(2)})`;
  };
  const onPointerUp = (event: PointerEvent) => {
    drag = undefined;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* not captured */ }
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    state.view = zoomView(state.view, event.deltaY < 0 ? 1.15 : 0.87, { x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: graph.width, height: graph.height });
    changed();
  };
  const onKey = (event: KeyboardEvent) => {
    const { width, height } = graph;
    switch (event.key) {
      case "+": case "=": state.view = zoomView(state.view, 1.25, { x: width / 2, y: height / 2 }, { width, height }); break;
      case "-": case "_": state.view = zoomView(state.view, 0.8, { x: width / 2, y: height / 2 }, { width, height }); break;
      case "0": state.view = resetView(); break;
      case "ArrowLeft": state.view = panView(state.view, width * 0.1, 0, { width, height }); break;
      case "ArrowRight": state.view = panView(state.view, -width * 0.1, 0, { width, height }); break;
      case "ArrowUp": state.view = panView(state.view, 0, height * 0.1, { width, height }); break;
      case "ArrowDown": state.view = panView(state.view, 0, -height * 0.1, { width, height }); break;
      default: return;
    }
    event.preventDefault();
    changed();
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKey);
  const observer = new ResizeObserver(() => requestDraw());
  observer.observe(canvasWrap);

  renderPoints();
  queueMicrotask(() => requestDraw());

  return () => {
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("keydown", onKey);
    root.remove();
  };
}
