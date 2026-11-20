// Graph Lab UI — 3-D surfaces z = f(x, y) and parametric space curves.
// Drag rotates, the wheel zooms; the surface is painter-sorted and shaded.
import { evaluate } from "../engine/math.ts";
import { createExpression, GRAPH_COLORS, type GraphState } from "../engine/state.ts";
import { splitTopLevel } from "../engine/expressions.ts";
import {
  DEFAULT_CAMERA, axisBox, compileSpaceCurve, compileSurface, parametricCurve,
  project, projectCurve, rotateCamera, surfaceMesh, zoomCamera, type Camera, type Mesh, type Vec3,
} from "../engine/surface.ts";
import { GraphCanvas, clearCanvas, drawSurface, readPalette } from "../engine/render.ts";
import { button, element, textInput } from "./dom.ts";
import type { PanelOptions } from "./types.ts";

const SURFACE_ID = /^surface/;
const CURVE_ID = /^curve/;
const SURFACE_PREFIX = /^\s*z\s*=\s*/i;

function readSurface(state: GraphState): { source: string; row: { id: string; text: string } | undefined } {
  const row = state.expressions.find(expression => SURFACE_ID.test(expression.id) ||
    (SURFACE_PREFIX.test(expression.text) && !expression.text.trim().startsWith("(")));
  if (!row) return { source: "x^2 - y^2", row: undefined };
  return { source: row.text.replace(SURFACE_PREFIX, "").trim() || "x^2 - y^2", row };
}

interface SpaceCurve {
  id: string;
  x: string;
  y: string;
  z: string;
  range: [number, number];
  color: string;
}

function tupleParts(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("(") || !trimmed.includes(")")) return undefined;
  const end = trimmed.lastIndexOf(")");
  if (end < 0) return undefined;
  const inner = trimmed.slice(1, end);
  const parts = splitTopLevel(inner, ",");
  return parts.length === 3 ? parts : undefined;
}

function curveRange(text: string): [number, number] {
  const match = /\{([^{}]*)\}/.exec(text);
  if (!match) return [0, 2 * Math.PI];
  const bounds = /(.+?)(?:<|<=)(.+?)(?:<|<=)(.+)/.exec(match[1]!);
  if (!bounds) return [0, 2 * Math.PI];
  try {
    const low = Number(evaluate(bounds[1]!));
    const high = Number(evaluate(bounds[3]!));
    if (Number.isFinite(low) && Number.isFinite(high) && high > low) return [low, high];
  } catch { /* default range */ }
  return [0, 2 * Math.PI];
}

function parseCurve(expression: { id: string; text: string }, index: number): SpaceCurve | undefined {
  const parts = tupleParts(expression.text);
  if (!parts) return undefined;
  return {
    id: expression.id,
    x: parts[0]!, y: parts[1]!, z: parts[2]!,
    range: curveRange(expression.text),
    color: GRAPH_COLORS[(index + 3) % GRAPH_COLORS.length]!,
  };
}

export function mountSurface(host: HTMLElement, options: PanelOptions): () => void {
  const { state, signal } = options;
  const root = element("div", { className: "graph-lab-2d" });
  const side = element("div", { className: "graph-lab-list" });
  const canvasWrap = element("div", { className: "graph-lab-canvas-wrap" });
  root.append(side, canvasWrap);
  host.append(root);

  const initial = readSurface(state);
  let source = initial.source;
  let camera: Camera = { ...DEFAULT_CAMERA, scale: 38 };
  let disposed = false;
  let frame: number | undefined;
  let drag: { x: number; y: number } | undefined;

  const canvas = element("canvas", { className: "graph-lab-canvas" });
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "3-D surface. Drag to rotate, scroll to zoom.");
  const hint = element("div", { className: "graph-lab-trace", textContent: "Drag to rotate · scroll to zoom" });
  const controls = element("div", { className: "graph-lab-zoom" }, [
    button("+", () => { camera = zoomCamera(camera, 1.2); requestDraw(); }, { className: "graph-lab-icon-button", title: "Zoom in", ariaLabel: "Zoom in" }),
    button("−", () => { camera = zoomCamera(camera, 0.83); requestDraw(); }, { className: "graph-lab-icon-button", title: "Zoom out", ariaLabel: "Zoom out" }),
    button("⟲", () => { camera = { ...DEFAULT_CAMERA, scale: 38 }; requestDraw(); }, { className: "graph-lab-icon-button", title: "Reset camera", ariaLabel: "Reset camera" }),
  ]);
  canvasWrap.append(canvas, hint, controls);
  const graph = new GraphCanvas(canvas);

  const surfaceInput = textInput(source, "Surface z of x and y");
  surfaceInput.addEventListener("input", () => {
    source = surfaceInput.value;
    const row = readSurface(state).row;
    if (row) row.text = `z = ${source}`;
    else {
      const created = createExpression(`z = ${source}`, GRAPH_COLORS[4]);
      created.id = `surface${created.id}`;
      state.expressions.push(created);
    }
    options.onChange();
    requestDraw();
  });
  const surfaceField = element("label", { className: "graph-lab-field graph-lab-function-field" }, [
    element("span", { textContent: "z =" }), surfaceInput,
  ]);

  const curveHost = element("div", { className: "graph-lab-rows" });

  function curveExpressions() {
    return state.expressions.filter(expression => CURVE_ID.test(expression.id) || (tupleParts(expression.text) && /t\b/.test(expression.text)));
  }

  function renderCurves(): void {
    curveHost.replaceChildren();
    curveExpressions().forEach((expression, index) => {
      const input = textInput(expression.text, `Space curve ${index + 1}`, { placeholder: "(cos(t), sin(t), t/4)" });
      input.addEventListener("input", () => {
        expression.text = input.value;
        options.onChange();
        requestDraw();
      });
      const remove = button("×", () => {
        const position = state.expressions.indexOf(expression);
        if (position >= 0) state.expressions.splice(position, 1);
        renderCurves();
        options.onChange();
        requestDraw();
      }, { className: "graph-lab-icon-button", title: "Delete space curve" });
      remove.setAttribute("aria-label", `Delete space curve ${index + 1}`);
      const row = element("div", { className: "graph-lab-row" }, [
        element("div", { className: "graph-lab-row-line" }, [input, remove]),
      ]);
      curveHost.append(row);
    });
  }

  const addCurve = button("+ Curve", () => {
    const created = createExpression("(cos(t), sin(t), t/4) {0 < t < 12}", GRAPH_COLORS[5]);
    created.id = `curve${created.id}`;
    state.expressions.push(created);
    renderCurves();
    options.onChange();
    requestDraw();
  }, { className: "graph-lab-small-button" });

  side.append(
    element("div", { className: "graph-lab-list-head" }, [element("h3", { className: "graph-lab-list-title", textContent: "3-D surface" })]),
    surfaceField,
    element("p", { className: "graph-lab-hint", textContent: "Enter z as a function of x and y. Add parametric space curves as (x(t), y(t), z(t)) with an optional t range." }),
    element("div", { className: "graph-lab-section-title" }, [element("span", { textContent: "Space curves" }), addCurve]),
    curveHost,
  );

  /* -------------------------------- drawing ------------------------------ */

  function requestDraw(): void {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; draw(); });
  }

  function zRangeOf(mesh: Mesh): [number, number] {
    if (!mesh.vertices.length) return [-5, 5];
    let low = Infinity;
    let high = -Infinity;
    for (const vertex of mesh.vertices) { low = Math.min(low, vertex.z); high = Math.max(high, vertex.z); }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return [-5, 5];
    if (high - low < 1e-6) return [low - 1, high + 1];
    const pad = (high - low) * 0.08;
    return [low - pad, high + pad];
  }

  function draw(): void {
    if (disposed || signal.aborted) return;
    const size = graph.resize();
    if (size.width < 2 || size.height < 2) return;
    const ctx = graph.context;
    const palette = readPalette(root);
    clearCanvas(ctx, size.width, size.height, palette);
    const fn = compileSurface(source);
    if (!fn) {
      hint.textContent = "z could not be parsed.";
      return;
    }
    const mesh = surfaceMesh(fn, state.view, 42);
    drawSurface(ctx, mesh, camera, size.width, size.height, palette, {
      showBox: true,
      box: axisBox(state.view, zRangeOf(mesh)),
    });
    for (const [index, expression] of curveExpressions().entries()) {
      const parsed = parseCurve(expression, index);
      if (!parsed) continue;
      const curve = compileSpaceCurve(parsed.x, parsed.y, parsed.z);
      if (!curve) continue;
      const points = projectCurve(parametricCurve(curve, parsed.range, 220), camera, size.width, size.height);
      ctx.save();
      ctx.strokeStyle = parsed.color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      points.forEach((point, pointIndex) => {
        if (pointIndex === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      ctx.restore();
    }
    drawAxes(ctx, camera, size.width, size.height, palette.foreground);
    hint.textContent = `z = ${source}`;
  }

  function drawAxes(ctx: CanvasRenderingContext2D, cameraValue: Camera, width: number, height: number, color: string): void {
    const origin: Vec3 = { x: 0, y: 0, z: 0 };
    const start = project(origin, cameraValue, width, height);
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    for (const [label, end] of [["x", { x: 3, y: 0, z: 0 }], ["y", { x: 0, y: 3, z: 0 }], ["z", { x: 0, y: 0, z: 3 }]] as const) {
      const projected = project(end, cameraValue, width, height);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(projected.x, projected.y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(label, projected.x + 3, projected.y - 3);
    }
    ctx.restore();
  }

  /* ----------------------------- interactions ---------------------------- */

  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture?.(event.pointerId);
    drag = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    camera = rotateCamera(camera, event.clientX - drag.x, event.clientY - drag.y);
    drag = { x: event.clientX, y: event.clientY };
    requestDraw();
  };
  const onPointerUp = (event: PointerEvent) => {
    drag = undefined;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* not captured */ }
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    camera = zoomCamera(camera, event.deltaY < 0 ? 1.12 : 0.89);
    requestDraw();
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const observer = new ResizeObserver(() => requestDraw());
  observer.observe(canvasWrap);

  renderCurves();
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
    root.remove();
  };
}
