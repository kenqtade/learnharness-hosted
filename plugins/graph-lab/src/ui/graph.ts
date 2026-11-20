// Graph Lab UI — the reusable interactive 2-D canvas. The full view and the
// ```graph code block both mount this, so pan/zoom/trace/sliders behave alike.
import {
  buildScope, collectSliders, curveFunction, evaluateValue, parseExpression, testRelation,
  type ParsedExpression, type SliderSpec,
} from "../engine/expressions.ts";
import { sampleRow, type SamplePoint, type Segments } from "../engine/sample.ts";
import { makeViewport, panView, toScreen, toWorld, zoomView, resetView, type ViewRect } from "../engine/viewport.ts";
import {
  curvePoints, findIntersections, integralSamples, integrate, interestLabel, tangentLine,
  type InterestPoint, type Tangent,
} from "../engine/analysis.ts";
import { linearRegression, quadraticRegression, exponentialRegression, type DataPoint, type RegressionResult } from "../engine/regression.ts";
import { GraphCanvas, readPalette, type Scene, type SceneArea, type SceneCurve, type SceneLine, type ScenePoint } from "../engine/render.ts";
import { safeColor, type GraphExpression, type GraphState } from "../engine/state.ts";
import { button, element, formatNumber } from "./dom.ts";

export interface GraphFlags {
  derivative?: boolean;
  tangentX?: number;
  integral?: { a: number; b: number };
}

export interface AnalysisReport {
  rowId?: string;
  text: string;
  points: InterestPoint[];
  tangent?: Tangent;
  integral?: { a: number; b: number; value: number };
}

export interface GraphPanelOptions {
  state: GraphState;
  interactive?: boolean;
  signal?: AbortSignal;
  /** Called whenever the view, slider values or auto-created sliders change. */
  onStateChange?: (state: GraphState) => void;
  onSelect?: (id: string | undefined) => void;
  /** Called after every paint with the current points-of-interest report. */
  onAnalysis?: (report: AnalysisReport) => void;
}

interface RowEntry {
  expression: GraphExpression;
  parsed: ParsedExpression;
  index: number;
}

interface HitCurve {
  id: string;
  segments: Segments;
}

function degreeScope(degrees: boolean): Record<string, unknown> {
  if (!degrees) return {};
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const toDegrees = (value: number) => (value * 180) / Math.PI;
  return {
    sin: (value: number) => Math.sin(toRadians(value)),
    cos: (value: number) => Math.cos(toRadians(value)),
    tan: (value: number) => Math.tan(toRadians(value)),
    asin: (value: number) => toDegrees(Math.asin(value)),
    acos: (value: number) => toDegrees(Math.acos(value)),
    atan: (value: number) => toDegrees(Math.atan(value)),
    atan2: (y: number, x: number) => toDegrees(Math.atan2(y, x)),
  };
}

function sameSliders(a: Record<string, SliderSpec>, b: Record<string, SliderSpec>): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every(name => {
    const first = a[name];
    const second = b[name];
    return !!first && !!second && first.min === second.min && first.max === second.max &&
      first.step === second.step && first.value === second.value;
  });
}

export class GraphPanel {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  state: GraphState;
  selectedId: string | undefined;
  flags: GraphFlags = {};
  private readonly options: GraphPanelOptions;
  private readonly graph: GraphCanvas;
  private readonly trace: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly cleanups: (() => void)[] = [];
  private hitCurves: HitCurve[] = [];
  private rows: RowEntry[] = [];
  private report: AnalysisReport = { text: "", points: [] };
  private errorList: { id: string; message: string }[] = [];
  private frame: number | undefined;
  private disposed = false;
  private drag: { x: number; y: number } | undefined;
  private moved = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; x: number; y: number } | undefined;

  constructor(host: HTMLElement, options: GraphPanelOptions) {
    this.options = options;
    this.state = options.state;
    this.element = element("div", { className: "graph-lab-graph" });
    const stage = element("div", { className: "graph-lab-stage" });
    this.canvas = element("canvas", { className: "graph-lab-canvas" });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Graph. Drag to pan, scroll to zoom, arrow keys pan, plus and minus zoom.");
    this.trace = element("div", { className: "graph-lab-trace", textContent: "Drag to pan · scroll to zoom" });
    this.trace.setAttribute("aria-live", "polite");
    this.marker = element("span", { className: "graph-lab-trace-dot" });
    this.marker.hidden = true;
    const controls = element("div", { className: "graph-lab-zoom" }, [
      button("+", () => this.zoom(1.3), { className: "graph-lab-icon-button", title: "Zoom in", ariaLabel: "Zoom in" }),
      button("−", () => this.zoom(1 / 1.3), { className: "graph-lab-icon-button", title: "Zoom out", ariaLabel: "Zoom out" }),
      button("⟲", () => { this.state.view = resetView(); this.changed(); }, { className: "graph-lab-icon-button", title: "Reset view", ariaLabel: "Reset view" }),
    ]);
    stage.append(this.canvas, this.trace, this.marker, controls);
    this.element.append(stage);
    host.append(this.element);
    this.graph = new GraphCanvas(this.canvas);
    this.bindInteractions(stage);
    this.observer = new ResizeObserver(() => this.requestDraw());
    this.observer.observe(stage);
    if (options.signal) {
      if (options.signal.aborted) this.dispose();
      else options.signal.addEventListener("abort", () => this.dispose(), { once: true });
    }
    queueMicrotask(() => this.requestDraw());
  }

  get errors(): { id: string; message: string }[] {
    return [...this.errorList];
  }

  get analysis(): AnalysisReport {
    return this.report;
  }

  get sliderNames(): string[] {
    return Object.keys(this.state.sliders);
  }

  setState(state: GraphState): void {
    this.state = state;
    this.requestDraw();
  }

  select(id: string | undefined): void {
    this.selectedId = id;
    this.requestDraw();
  }

  setFlags(flags: GraphFlags): void {
    this.flags = { ...flags };
    this.requestDraw();
  }

  setSlider(name: string, value: number): void {
    const spec = this.state.sliders[name];
    if (!spec) return;
    spec.value = Math.max(spec.min, Math.min(spec.max, Number.isFinite(value) ? value : spec.value));
    this.requestDraw();
  }

  requestDraw(): void {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.draw(); });
  }

  draw(): void {
    if (this.disposed) return;
    const size = this.graph.resize();
    if (size.width < 2 || size.height < 2) return;
    const palette = readPalette(this.element);
    const rows: RowEntry[] = this.state.expressions.map((expression, index) => ({ expression, index, parsed: parseExpression(expression.text) }));
    this.rows = rows;
    this.errorList = rows.filter(row => !!row.parsed.error).map(row => ({ id: row.expression.id, message: row.parsed.error! }));

    const sliders = collectSliders(rows.map(row => row.parsed), this.state.sliders);
    let sliderChanged = false;
    if (!sameSliders(sliders, this.state.sliders)) {
      this.state.sliders = sliders;
      sliderChanged = true;
    }
    const scope = buildScope(rows.map(row => row.parsed), this.state.sliders, degreeScope(this.state.options?.degrees === true));
    const view = this.state.view;
    const curves: SceneCurve[] = [];
    const points: ScenePoint[] = [];
    const lines: SceneLine[] = [];
    const areas: SceneArea[] = [];
    const labels: NonNullable<Scene["labels"]> = [];
    const hits: HitCurve[] = [];
    const data = this.tableData(rows, scope);

    for (const row of rows) {
      const { parsed, expression, index } = row;
      if (expression.hidden || parsed.error) continue;
      const color = safeColor(expression.color, index);
      const selected = expression.id === this.selectedId;
      switch (parsed.kind) {
        case "point":
        case "points": {
          for (const point of parsed.points ?? []) {
            const x = evaluateValue(point.x, scope);
            const y = evaluateValue(point.y, scope);
            if (x === undefined || y === undefined) continue;
            points.push({ x, y, color, label: parsed.kind === "points" ? undefined : `(${formatNumber(x, 3)}, ${formatNumber(y, 3)})` });
          }
          break;
        }
        case "table": {
          for (const point of parsed.points ?? []) {
            const x = evaluateValue(point.x, scope);
            const y = evaluateValue(point.y, scope);
            if (x !== undefined && y !== undefined) points.push({ x, y, color, filled: true });
          }
          break;
        }
        case "slider":
        case "function":
          break;
        case "regression": {
          const fitted = this.fit(parsed, data);
          if (!fitted) {
            labels.push({ x: view.x[0] + (view.x[1] - view.x[0]) * 0.03, y: view.y[1] - (view.y[1] - view.y[0]) * 0.06, text: "Add a table row [[x,y], …] for a regression", color });
            break;
          }
          const sampled = sampleRow({ ...parsed, kind: "explicit", compiled: { evaluate: (extra?: Record<string, unknown>) => fitted.predict(Number(extra?.x)) } }, scope, view, size.width, size.height);
          curves.push({ id: expression.id, color, segments: sampled.segments, selected });
          hits.push({ id: expression.id, segments: sampled.segments });
          const r2 = `r² = ${formatNumber(fitted.r2, 3)}`;
          labels.push({ x: view.x[0] + (view.x[1] - view.x[0]) * 0.03, y: view.y[1] - (view.y[1] - view.y[0]) * 0.06, text: `${fitted.equation}   ${r2}`, color });
          break;
        }
        default: {
          const sampled = sampleRow(parsed, scope, view, size.width, size.height);
          if (sampled.segments.length || sampled.mask) {
            curves.push({ id: expression.id, color, segments: sampled.segments, mask: sampled.mask, selected });
            hits.push({ id: expression.id, segments: sampled.segments });
          }
          break;
        }
      }
    }

    this.hitCurves = hits;
    const selected = rows.find(row => row.expression.id === this.selectedId);
    const report = this.analyse(selected, rows, scope, view);
    if (report) {
      if (report.points.length) {
        const shown = report.points.slice(0, 14);
        for (const point of shown) points.push({ x: point.x, y: point.y, label: interestLabel(point), color: "#111827", filled: false });
      }
      if (report.tangent) {
        const tangent = report.tangent;
        lines.push({ from: { x: view.x[0], y: tangent.line(view.x[0]) }, to: { x: view.x[1], y: tangent.line(view.x[1]) }, color: "#8a56c9", dashed: true, label: tangent.label });
      }
      if (report.integral) {
        const selectedFunction = selected && curveFunction(selected.parsed, scope, "x");
        if (selectedFunction) {
          areas.push({ segments: integralSamples(selectedFunction, report.integral.a, report.integral.b), color: safeColor(selected?.expression.color, 0), baseline: 0 });
        }
      }
      if (this.flags.derivative && selected && selected.parsed.kind === "explicit") {
        const f = curveFunction(selected.parsed, scope, "x");
        if (f) {
          const sampled = sampleRow(
            { ...selected.parsed, kind: "explicit", compiled: { evaluate: (extra?: Record<string, unknown>) => derivative(f, Number(extra?.x)) } },
            scope, view, size.width, size.height,
          );
          curves.push({ id: `${selected.expression.id}-derivative`, color: "#8a56c9", segments: sampled.segments, dashed: true });
        }
      }
      this.report = report;
      this.options.onAnalysis?.(report);
    } else {
      this.report = { text: "", points: [] };
      this.options.onAnalysis?.(this.report);
    }

    const scene: Scene = {
      view, curves, points, lines, areas, labels,
      showGrid: this.state.options?.grid !== false,
      piTicks: this.state.options?.piTicks === true,
    };
    this.graph.draw(view, scene, palette);
    if (this.state.options?.degrees) {
      labels.push({ x: view.x[0], y: view.y[1], text: "DEG", color: palette.muted });
    }
    if (sliderChanged) this.options.onStateChange?.(this.state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.element.remove();
  }

  private changed(): void {
    this.options.onStateChange?.(this.state);
    this.requestDraw();
  }

  private tableData(rows: RowEntry[], scope: Record<string, unknown>): DataPoint[] {
    const table = rows.find(row => row.parsed.kind === "table" && !row.parsed.error && !row.expression.hidden);
    if (!table?.parsed.points) return [];
    const data: DataPoint[] = [];
    for (const point of table.parsed.points) {
      const x = evaluateValue(point.x, scope);
      const y = evaluateValue(point.y, scope);
      if (x !== undefined && y !== undefined) data.push({ x, y });
    }
    return data;
  }

  private fit(parsed: ParsedExpression, data: DataPoint[]): RegressionResult | undefined {
    switch (parsed.regression?.family) {
      case "quadratic": return quadraticRegression(data);
      case "exponential": return exponentialRegression(data);
      default: return linearRegression(data);
    }
  }

  private analyse(selected: RowEntry | undefined, rows: RowEntry[], scope: Record<string, unknown>, view: ViewRect): AnalysisReport | undefined {
    if (!selected || selected.expression.hidden) return undefined;
    const parsed = selected.parsed;
    if (parsed.error) return { rowId: selected.expression.id, text: parsed.error, points: [] };
    if (parsed.kind !== "explicit") {
      return { rowId: selected.expression.id, text: `${parsed.display} — calculus and points of interest apply to y = f(x) rows.`, points: [] };
    }
    const f = curveFunction(parsed, scope, "x");
    if (!f) return { rowId: selected.expression.id, text: "This row cannot be evaluated.", points: [] };
    const points = curvePoints(f, view.x);
    for (const other of rows) {
      if (other.expression.id === selected.expression.id || other.expression.hidden) continue;
      if (other.parsed.kind !== "explicit" || other.parsed.error) continue;
      const g = curveFunction(other.parsed, scope, "x");
      if (!g) continue;
      for (const point of findIntersections(f, g, view.x)) {
        if (!points.some(existing => existing.kind === "intersection" && Math.abs(existing.x - point.x) < 1e-6)) points.push(point);
      }
    }
    const tangent = this.flags.tangentX !== undefined ? tangentLine(f, this.flags.tangentX) : undefined;
    let integral: { a: number; b: number; value: number } | undefined;
    if (this.flags.integral) {
      const { a, b } = this.flags.integral;
      integral = { a, b, value: integrate(f, a, b) };
    }
    const parts: string[] = [];
    if (points.length) parts.push(`${points.length} point${points.length === 1 ? "" : "s"} of interest`);
    if (tangent) parts.push(`slope ${formatNumber(tangent.slope, 4)}`);
    if (integral) parts.push(`∫ = ${formatNumber(integral.value, 5)}`);
    return { rowId: selected.expression.id, text: parts.join(" · "), points, ...(tangent ? { tangent } : {}), ...(integral ? { integral } : {}) };
  }

  private zoom(factor: number): void {
    const { width, height } = this.graph;
    this.state.view = zoomView(this.state.view, factor, { x: width / 2, y: height / 2 }, { width, height });
    this.changed();
  }

  private bindInteractions(stage: HTMLElement): void {
    const canvas = this.canvas;
    const onPointerDown = (event: PointerEvent) => {
      if (this.options.interactive === false) return;
      canvas.setPointerCapture?.(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.drag = { x: event.clientX, y: event.clientY };
      this.moved = false;
      if (this.pointers.size === 2) {
        const [first, second] = [...this.pointers.values()];
        if (first && second) this.pinch = { distance: Math.hypot(second.x - first.x, second.y - first.y), x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      this.updateTrace(event);
      if (!this.pointers.has(event.pointerId)) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const rect = canvas.getBoundingClientRect();
      if (this.pointers.size >= 2 && this.pinch) {
        const [first, second] = [...this.pointers.values()];
        if (!first || !second) return;
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        const midX = (first.x + second.x) / 2;
        const midY = (first.y + second.y) / 2;
        if (this.pinch.distance > 0) {
          const factor = distance / this.pinch.distance;
          if (Number.isFinite(factor) && factor > 0) {
            this.state.view = zoomView(this.state.view, factor, { x: midX - rect.left, y: midY - rect.top }, { width: this.graph.width, height: this.graph.height });
          }
        }
        this.state.view = panView(this.state.view, midX - this.pinch.x, midY - this.pinch.y, { width: this.graph.width, height: this.graph.height });
        this.pinch = { distance, x: midX, y: midY };
        this.moved = true;
        this.changed();
        return;
      }
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      this.state.view = panView(this.state.view, dx, dy, { width: this.graph.width, height: this.graph.height });
      this.drag = { x: event.clientX, y: event.clientY };
      this.changed();
    };
    const release = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = undefined;
      if (this.pointers.size === 0) this.drag = undefined;
      try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* not captured */ }
      if (!this.moved && event.type === "pointerup") this.pick(event);
    };
    const onWheel = (event: WheelEvent) => {
      if (this.options.interactive === false) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.state.view = zoomView(this.state.view, event.deltaY < 0 ? 1.15 : 0.87, { x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: this.graph.width, height: this.graph.height });
      this.changed();
    };
    const onKey = (event: KeyboardEvent) => {
      if (this.options.interactive === false) return;
      const { width, height } = this.graph;
      switch (event.key) {
        case "+": case "=": this.state.view = zoomView(this.state.view, 1.25, { x: width / 2, y: height / 2 }, { width, height }); break;
        case "-": case "_": this.state.view = zoomView(this.state.view, 0.8, { x: width / 2, y: height / 2 }, { width, height }); break;
        case "0": this.state.view = resetView(); break;
        case "ArrowLeft": this.state.view = panView(this.state.view, width * 0.1, 0, { width, height }); break;
        case "ArrowRight": this.state.view = panView(this.state.view, -width * 0.1, 0, { width, height }); break;
        case "ArrowUp": this.state.view = panView(this.state.view, 0, height * 0.1, { width, height }); break;
        case "ArrowDown": this.state.view = panView(this.state.view, 0, -height * 0.1, { width, height }); break;
        default: return;
      }
      event.preventDefault();
      this.changed();
    };
    const onLeave = () => { this.marker.hidden = true; };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("pointerleave", onLeave);
    this.cleanups.push(() => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", release);
      canvas.removeEventListener("pointercancel", release);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("pointerleave", onLeave);
      void stage;
    });
  }

  private updateTrace(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const world = toWorld(makeViewport(this.state.view, this.graph.width, this.graph.height), event.clientX - rect.left, event.clientY - rect.top);
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
    this.trace.textContent = `(${formatNumber(world.x, 3)}, ${formatNumber(world.y, 3)})`;
    this.marker.hidden = false;
    this.marker.style.left = `${event.clientX - rect.left}px`;
    this.marker.style.top = `${event.clientY - rect.top}px`;
  }

  private pick(event: PointerEvent): void {
    if (!this.hitCurves.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const viewport = makeViewport(this.state.view, this.graph.width, this.graph.height);
    let best: { id: string; distance: number } | undefined;
    for (const curve of this.hitCurves) {
      for (const segment of curve.segments) {
        for (let index = 1; index < segment.length; index += 1) {
          const a = toScreen(viewport, segment[index - 1]!.x, segment[index - 1]!.y);
          const b = toScreen(viewport, segment[index]!.x, segment[index]!.y);
          const distance = pointSegmentDistance(screenX, screenY, a.x, a.y, b.x, b.y);
          if (!best || distance < best.distance) best = { id: curve.id, distance };
        }
      }
    }
    if (best && best.distance <= 14) this.options.onSelect?.(best.id);
  }
}

function derivative(f: (x: number) => number, x: number): number {
  const h = Math.max(1e-6, Math.abs(x) * 1e-6);
  const before = f(x - h);
  const after = f(x + h);
  return Number.isFinite(before) && Number.isFinite(after) ? (after - before) / (2 * h) : Number.NaN;
}

function pointSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export { degreeScope };

// Keep the imported type used in this module's public surface for consumers.
export type { SamplePoint, Tangent };
