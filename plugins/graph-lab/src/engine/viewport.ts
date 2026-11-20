// Graph Lab engine — world <-> screen transforms and "nice" axis ticks.
// Pure functions: the renderer and the tests share exactly the same maths.

export type Range = [number, number];

export interface ViewRect {
  x: Range;
  y: Range;
}

export interface Viewport {
  view: ViewRect;
  /** CSS pixels. */
  width: number;
  height: number;
}

export const DEFAULT_VIEW: ViewRect = { x: [-10, 10], y: [-10, 10] };

export function makeViewport(view: ViewRect, width: number, height: number): Viewport {
  return { view, width: Math.max(1, width), height: Math.max(1, height) };
}

export function span(range: Range): number {
  return range[1] - range[0];
}

/** World x/y to CSS-pixel canvas coordinates (y grows downwards on screen). */
export function toScreen(viewport: Viewport, x: number, y: number): { x: number; y: number } {
  const [x0, x1] = viewport.view.x;
  const [y0, y1] = viewport.view.y;
  return {
    x: ((x - x0) / (x1 - x0 || 1)) * viewport.width,
    y: ((y1 - y) / (y1 - y0 || 1)) * viewport.height,
  };
}

export function toWorld(viewport: Viewport, screenX: number, screenY: number): { x: number; y: number } {
  const [x0, x1] = viewport.view.x;
  const [y0, y1] = viewport.view.y;
  return {
    x: x0 + (screenX / viewport.width) * (x1 - x0 || 1),
    y: y1 - (screenY / viewport.height) * (y1 - y0 || 1),
  };
}

/** Drag by a pixel delta: the world under the finger follows the finger. */
export function panView(view: ViewRect, dxPixels: number, dyPixels: number, viewport: { width: number; height: number }): ViewRect {
  const dx = (dxPixels / Math.max(1, viewport.width)) * span(view.x);
  const dy = (dyPixels / Math.max(1, viewport.height)) * span(view.y);
  return { x: [view.x[0] - dx, view.x[1] - dx], y: [view.y[0] + dy, view.y[1] + dy] };
}

/** Zoom by `factor` (>1 in) keeping the world point under a screen anchor fixed. */
export function zoomView(view: ViewRect, factor: number, anchor: { x: number; y: number }, viewport: { width: number; height: number }): ViewRect {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  return zoomViewAt(view, factor, toWorld({ view, width: viewport.width, height: viewport.height }, anchor.x, anchor.y));
}

export function zoomViewAt(view: ViewRect, factor: number, world: { x: number; y: number }): ViewRect {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  return {
    x: [world.x + (view.x[0] - world.x) / factor, world.x + (view.x[1] - world.x) / factor],
    y: [world.y + (view.y[0] - world.y) / factor, world.y + (view.y[1] - world.y) / factor],
  };
}

export function resetView(): ViewRect {
  return { x: [-10, 10], y: [-10, 10] };
}

/** A 1/2/5 × 10^n step that gives roughly `target` grid lines. */
export function niceStep(spanValue: number, target = 10): number {
  if (!Number.isFinite(spanValue) || spanValue <= 0) return 1;
  const raw = spanValue / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / power;
  const choice = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return choice * power;
}

/** Tick positions inside a range, aligned to the step. */
export function tickValues(range: Range, step: number, limit = 200): number[] {
  if (!Number.isFinite(step) || step <= 0) return [];
  const [min, max] = range[0] <= range[1] ? range : [range[1], range[0]];
  const start = Math.ceil(min / step - 1e-9) * step;
  const output: number[] = [];
  for (let value = start, count = 0; value <= max + step * 1e-9 && count < limit; value += step, count += 1) {
    // Round to the step's precision so labels don't show 0.30000000000000004.
    const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2);
    output.push(Number(value.toFixed(Math.min(12, digits))));
  }
  return output;
}

export function tickStepFor(range: Range, target = 10): number {
  return niceStep(span(range), target);
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

export function formatTick(value: number, step = 1): string {
  if (Math.abs(value) < step * 1e-9) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1e6 || (absolute > 0 && absolute < 1e-4)) {
    return value.toExponential(1).replace("e+", "e").replace(/\.0e/, "e");
  }
  const decimals = step >= 1 ? 0 : Math.min(8, Math.max(1, -Math.floor(Math.log10(step)) + 1));
  return trimZeros(value.toFixed(decimals));
}

/** Exact-looking π labels for trigonometry: π/2, 2π, −π/4 … */
export function formatPi(value: number, epsilon = 1e-9): string {
  const ratio = value / Math.PI;
  const denominators = [1, 2, 3, 4, 6, 8, 12];
  for (const denominator of denominators) {
    const numerator = Math.round(ratio * denominator);
    if (Math.abs(ratio - numerator / denominator) > epsilon) continue;
    if (numerator === 0) return "0";
    const sign = numerator < 0 ? "−" : "";
    const top = Math.abs(numerator);
    const head = top === 1 ? "π" : `${top}π`;
    return denominator === 1 ? `${sign}${head}` : `${sign}${head}/${denominator}`;
  }
  return `${trimZeros(ratio.toFixed(2))}π`;
}

/** π-multiple ticks with a step that is a nice fraction of π. */
export function piTicks(range: Range, target = 8): { value: number; label: string }[] {
  const units = niceStep(span(range) / Math.PI, target);
  const values = tickValues([range[0] / Math.PI, range[1] / Math.PI], units);
  return values.map(unit => ({ value: unit * Math.PI, label: formatPi(unit * Math.PI) }));
}

export interface AxisTick {
  value: number;
  label: string;
  /** Position along the axis, in CSS pixels. */
  position: number;
}

export interface AxisLabels {
  x: AxisTick[];
  y: AxisTick[];
  xStep: number;
  yStep: number;
}

/** Ticks and labels for both axes, including the π-multiple mode. */
export function axisLabels(viewport: Viewport, options: { piTicks?: boolean; target?: number } = {}): AxisLabels {
  const target = options.target ?? 10;
  if (options.piTicks) {
    const xTicks = piTicks(viewport.view.x, target);
    const yTicks = piTicks(viewport.view.y, target);
    return {
      xStep: niceStep(span(viewport.view.x) / Math.PI, target) * Math.PI,
      yStep: niceStep(span(viewport.view.y) / Math.PI, target) * Math.PI,
      x: xTicks.map(tick => ({ value: tick.value, label: tick.label, position: toScreen(viewport, tick.value, 0).x })),
      y: yTicks.map(tick => ({ value: tick.value, label: tick.label, position: toScreen(viewport, 0, tick.value).y })),
    };
  }
  const xStep = tickStepFor(viewport.view.x, target);
  const yStep = tickStepFor(viewport.view.y, target);
  return {
    xStep, yStep,
    x: tickValues(viewport.view.x, xStep).map(value => ({ value, label: formatTick(value, xStep), position: toScreen(viewport, value, 0).x })),
    y: tickValues(viewport.view.y, yStep).map(value => ({ value, label: formatTick(value, yStep), position: toScreen(viewport, 0, value).y })),
  };
}

export function isVisible(viewport: Viewport, x: number, y: number, margin = 0): boolean {
  return x >= viewport.view.x[0] - margin && x <= viewport.view.x[1] + margin &&
    y >= viewport.view.y[0] - margin && y <= viewport.view.y[1] + margin;
}

/** A view that shows a whole rectangle with a little padding. */
export function paddedView(minX: number, maxX: number, minY: number, maxY: number, padding = 0.1): ViewRect {
  const xSpan = Math.max(1e-6, maxX - minX);
  const ySpan = Math.max(1e-6, maxY - minY);
  return {
    x: [minX - xSpan * padding, maxX + xSpan * padding],
    y: [minY - ySpan * padding, maxY + ySpan * padding],
  };
}
