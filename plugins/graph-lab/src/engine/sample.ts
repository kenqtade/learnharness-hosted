// Graph Lab engine — adaptive curve sampling and region masks.
// Pure functions over a world view; the renderer turns results into pixels.
import { curveFunction, testRelation, type ParsedExpression } from "./expressions.ts";
import { toScreen, type ViewRect } from "./viewport.ts";

export interface SamplePoint {
  x: number;
  y: number;
}

export type Segments = SamplePoint[][];

export interface SampleOptions {
  width?: number;
  height?: number;
  /** Maximum screen-space error before subdividing (CSS pixels). */
  tolerance?: number;
  maxDepth?: number;
  /** Marching-squares / mask resolution. */
  resolution?: number;
}

const TAU = Math.PI * 2;

function flush(segments: Segments, current: SamplePoint[]): void {
  if (current.length >= 2) segments.push(current);
}

/** A jump this large across one pixel is a pole/discontinuity, not a line. */
function breaksAcross(previousScreenY: number, screenY: number, height: number): boolean {
  const jump = Math.abs(screenY - previousScreenY);
  const above = -height * 1.5;
  const below = height * 2.5;
  const crossed = (previousScreenY < above && screenY > below) || (previousScreenY > below && screenY < above);
  return (crossed && jump > height * 1.5) || jump > height * 40;
}

/**
 * Sample y = f(x) along screen columns. Curved sections are subdivided until
 * the chord is within `tolerance`; non-finite values and poles break the path.
 */
export function sampleExplicit(f: (x: number) => number, view: ViewRect, width = 800, height = 600, options: SampleOptions = {}): Segments {
  const tolerance = options.tolerance ?? 0.4;
  const maxDepth = options.maxDepth ?? 8;
  const columns = Math.max(32, Math.min(4096, Math.round(width)));
  const segments: Segments = [];
  let current: SamplePoint[] = [];
  let previous: { worldX: number; screenY: number } | undefined;

  const screenY = (value: number) => toScreen({ view, width, height }, view.x[0], value).y;

  const refine = (x0: number, y0: number, sx0: number, x1: number, y1: number, sx1: number, depth: number): boolean => {
    const middleX = (x0 + x1) / 2;
    const middleY = f(middleX);
    if (!Number.isFinite(middleY)) return false;
    const middleScreen = screenY(middleY);
    const error = Math.abs(middleScreen - (sx0 + sx1) / 2);
    if (depth >= maxDepth || error <= tolerance || Math.abs(x1 - x0) < 1e-12) {
      current.push({ x: x1, y: y1 });
      return true;
    }
    if (!refine(x0, y0, sx0, middleX, middleY, middleScreen, depth + 1)) return false;
    return refine(middleX, middleY, middleScreen, x1, y1, sx1, depth + 1);
  };

  for (let column = 0; column <= columns; column += 1) {
    const worldX = view.x[0] + (column / columns) * (view.x[1] - view.x[0]);
    const worldY = f(worldX);
    if (!Number.isFinite(worldY)) {
      flush(segments, current);
      current = [];
      previous = undefined;
      continue;
    }
    const sy = screenY(worldY);
    if (!Number.isFinite(sy)) {
      flush(segments, current);
      current = [];
      previous = undefined;
      continue;
    }
    if (previous) {
      if (breaksAcross(previous.screenY, sy, height)) {
        flush(segments, current);
        current = [{ x: worldX, y: worldY }];
        previous = { worldX, screenY: sy };
        continue;
      }
      const continued = refine(previous.worldX, current[current.length - 1]?.y ?? worldY, previous.screenY, worldX, worldY, sy, 0);
      if (!continued) {
        flush(segments, current);
        current = [{ x: worldX, y: worldY }];
      }
    } else {
      current.push({ x: worldX, y: worldY });
    }
    previous = { worldX, screenY: sy };
  }
  flush(segments, current);
  return segments;
}

/** Sample x = g(y) as y varies up the screen. */
export function sampleExplicitY(g: (y: number) => number, view: ViewRect, width = 800, height = 600): Segments {
  const rows = Math.max(32, Math.min(4096, Math.round(height)));
  const segments: Segments = [];
  let current: SamplePoint[] = [];
  let previousX: number | undefined;
  const screenX = (value: number) => toScreen({ view, width, height }, value, 0).x;
  for (let row = 0; row <= rows; row += 1) {
    const worldY = view.y[0] + (row / rows) * (view.y[1] - view.y[0]);
    const worldX = g(worldY);
    if (!Number.isFinite(worldX)) {
      flush(segments, current);
      current = [];
      previousX = undefined;
      continue;
    }
    const sx = screenX(worldX);
    if (previousX !== undefined && Math.abs(sx - previousX) > width * 40) {
      flush(segments, current);
      current = [];
    }
    current.push({ x: worldX, y: worldY });
    previousX = sx;
  }
  flush(segments, current);
  return segments;
}

/** Sample a polar curve r(theta). */
export function samplePolar(r: (theta: number) => number, view: ViewRect, width = 800, height = 600, options: SampleOptions & { thetaRange?: [number, number]; samples?: number } = {}): Segments {
  const thetaRange = options.thetaRange ?? [0, TAU];
  return sampleParametric(
    theta => {
      const radius = r(theta);
      return radius * Math.cos(theta);
    },
    theta => {
      const radius = r(theta);
      return radius * Math.sin(theta);
    },
    thetaRange, view, width, height, { ...options, samples: Math.max(180, Math.round((options.samples ?? 720))) },
  );
}

/** Adaptive sampling of (x(t), y(t)). */
export function sampleParametric(
  xOf: (t: number) => number,
  yOf: (t: number) => number,
  tRange: [number, number],
  view: ViewRect,
  width = 800,
  height = 600,
  options: SampleOptions & { samples?: number; closed?: boolean } = {},
): Segments {
  const tolerance = options.tolerance ?? 0.3;
  const maxDepth = options.maxDepth ?? 7;
  const samples = Math.max(32, Math.min(8192, options.samples ?? Math.round(Math.max(width, height))));
  const viewport = { view, width, height };
  const point = (t: number): SamplePoint | undefined => {
    const x = xOf(t);
    const y = yOf(t);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  };
  const screen = (p: SamplePoint) => toScreen(viewport, p.x, p.y);
  const segments: Segments = [];
  let current: SamplePoint[] = [];
  let previous: { point: SamplePoint; screen: { x: number; y: number }; t: number } | undefined;

  const refine = (t0: number, p0: SamplePoint, s0: { x: number; y: number }, t1: number, p1: SamplePoint, s1: { x: number; y: number }, depth: number): boolean => {
    const tm = (t0 + t1) / 2;
    const pm = point(tm);
    if (!pm) return false;
    const sm = screen(pm);
    const chordX = (s0.x + s1.x) / 2;
    const chordY = (s0.y + s1.y) / 2;
    const error = Math.hypot(sm.x - chordX, sm.y - chordY);
    if (depth >= maxDepth || error <= tolerance || Math.abs(t1 - t0) < 1e-12) {
      current.push(p1);
      return true;
    }
    if (!refine(t0, p0, s0, tm, pm, sm, depth + 1)) return false;
    return refine(tm, pm, sm, t1, p1, s1, depth + 1);
  };

  for (let index = 0; index <= samples; index += 1) {
    const t = tRange[0] + (index / samples) * (tRange[1] - tRange[0]);
    const p = point(t);
    if (!p) {
      flush(segments, current);
      current = [];
      previous = undefined;
      continue;
    }
    const s = screen(p);
    if (previous) {
      const jump = Math.hypot(s.x - previous.screen.x, s.y - previous.screen.y);
      if (jump > Math.max(width, height) * 40) {
        flush(segments, current);
        current = [p];
      } else if (!refine(previous.t, previous.point, previous.screen, t, p, s, 0)) {
        flush(segments, current);
        current = [p];
      }
    } else {
      current.push(p);
    }
    previous = { point: p, screen: s, t };
  }
  flush(segments, current);
  return segments;
}

interface EdgePoint extends SamplePoint {
  edge: number;
}

function marchingCell(
  x0: number, x1: number, y0: number, y1: number,
  values: [number, number, number, number],
  emit: (a: SamplePoint, b: SamplePoint) => void,
  center?: number,
): void {
  const [topLeft, topRight, bottomRight, bottomLeft] = values;
  const interp = (a: number, valueA: number, valueB: number, b: number): number => {
    const denominator = valueA - valueB;
    return Math.abs(denominator) < 1e-15 ? (a + b) / 2 : a + (valueA / denominator) * (b - a);
  };
  const edges: (EdgePoint | undefined)[] = [undefined, undefined, undefined, undefined];
  if ((topLeft < 0) !== (topRight < 0)) edges[0] = { x: interp(x0, topLeft, topRight, x1), y: y1, edge: 0 };
  if ((topRight < 0) !== (bottomRight < 0)) edges[1] = { x: x1, y: interp(y1, topRight, bottomRight, y0), edge: 1 };
  if ((bottomRight < 0) !== (bottomLeft < 0)) edges[2] = { x: interp(x1, bottomRight, bottomLeft, x0), y: y0, edge: 2 };
  if ((bottomLeft < 0) !== (topLeft < 0)) edges[3] = { x: x0, y: interp(y0, bottomLeft, topLeft, y1), edge: 3 };
  const caseIndex = (topLeft >= 0 ? 1 : 0) | (topRight >= 0 ? 2 : 0) | (bottomRight >= 0 ? 4 : 0) | (bottomLeft >= 0 ? 8 : 0);
  const connect = (a: number, b: number) => {
    const first = edges[a];
    const second = edges[b];
    if (first && second) emit(first, second);
  };
  switch (caseIndex) {
    case 0: case 15: break;
    case 1: case 14: connect(0, 3); break;
    case 2: case 13: connect(0, 1); break;
    case 3: case 12: connect(1, 3); break;
    case 4: case 11: connect(1, 2); break;
    case 6: case 9: connect(0, 2); break;
    case 7: case 8: connect(2, 3); break;
    case 5:
      if ((center ?? (topLeft + topRight + bottomRight + bottomLeft) / 4) >= 0) { connect(0, 1); connect(2, 3); }
      else { connect(0, 3); connect(1, 2); }
      break;
    default: // 10
      if ((center ?? (topLeft + topRight + bottomRight + bottomLeft) / 4) >= 0) { connect(0, 3); connect(1, 2); }
      else { connect(0, 1); connect(2, 3); }
      break;
  }
}

/**
 * Implicit curves F(x, y) = 0 with marching squares. `refine` subdivides every
 * crossing cell so the polyline follows the curve instead of the grid.
 */
export function marchSquares(f: (x: number, y: number) => number, view: ViewRect, resolution = 64, refine = 2): Segments {
  const aspect = Math.abs((view.y[1] - view.y[0]) / ((view.x[1] - view.x[0]) || 1));
  const cols = Math.max(8, Math.min(400, Math.round(resolution)));
  const rows = Math.max(8, Math.min(400, Math.round(cols * Math.min(3, Math.max(0.2, aspect)))));
  const dx = (view.x[1] - view.x[0]) / cols;
  const dy = (view.y[1] - view.y[0]) / rows;
  const segments: Segments = [];
  const emit = (a: SamplePoint, b: SamplePoint) => {
    if (Math.hypot(a.x - b.x, a.y - b.y) > 0) segments.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
  };
  const cache = new Map<string, number>();
  const value = (x: number, y: number) => {
    const key = `${x},${y}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = f(x, y);
    const normalised = Number.isFinite(result) ? result : Number.NaN;
    cache.set(key, normalised);
    return normalised;
  };
  const safe = (v: number) => (Number.isFinite(v) ? v : 1);

  for (let row = 0; row < rows; row += 1) {
    const y0 = view.y[0] + row * dy;
    const y1 = y0 + dy;
    for (let col = 0; col < cols; col += 1) {
      const x0 = view.x[0] + col * dx;
      const x1 = x0 + dx;
      const values: [number, number, number, number] = [safe(value(x0, y1)), safe(value(x1, y1)), safe(value(x1, y0)), safe(value(x0, y0))];
      const crossing = (values[0] < 0) !== (values[1] < 0) || (values[1] < 0) !== (values[2] < 0) ||
        (values[2] < 0) !== (values[3] < 0) || (values[3] < 0) !== (values[0] < 0);
      if (!crossing) continue;
      const levels = Math.max(1, Math.min(8, Math.round(refine)));
      const subX = dx / levels;
      const subY = dy / levels;
      for (let sy = 0; sy < levels; sy += 1) {
        for (let sx = 0; sx < levels; sx += 1) {
          const sx0 = x0 + sx * subX;
          const sy0 = y0 + sy * subY;
          const sx1 = sx0 + subX;
          const sy1 = sy0 + subY;
          const sub: [number, number, number, number] = [
            safe(value(sx0, sy1)), safe(value(sx1, sy1)), safe(value(sx1, sy0)), safe(value(sx0, sy0)),
          ];
          marchingCell(sx0, sx1, sy0, sy1, sub, emit, safe(value((sx0 + sx1) / 2, (sy0 + sy1) / 2)));
        }
      }
    }
  }
  return segments;
}

export interface RegionMask {
  view: ViewRect;
  cols: number;
  rows: number;
  /** row-major, row 0 is the bottom of the view. */
  inside: Uint8Array;
  /** The mask contains at least one inside cell. */
  any: boolean;
}

export interface MaskRect {
  x0: number; x1: number; y0: number; y1: number;
}

/** Shade an inequality region on a coarse world grid. */
export function sampleRegion(test: (x: number, y: number) => boolean, view: ViewRect, resolution = 160): RegionMask {
  const aspect = Math.abs((view.y[1] - view.y[0]) / ((view.x[1] - view.x[0]) || 1));
  const cols = Math.max(8, Math.min(400, Math.round(resolution)));
  const rows = Math.max(8, Math.min(400, Math.round(cols * Math.min(3, Math.max(0.2, aspect)))));
  const dx = (view.x[1] - view.x[0]) / cols;
  const dy = (view.y[1] - view.y[0]) / rows;
  const inside = new Uint8Array(cols * rows);
  let any = false;
  for (let row = 0; row < rows; row += 1) {
    const y = view.y[0] + (row + 0.5) * dy;
    for (let col = 0; col < cols; col += 1) {
      const x = view.x[0] + (col + 0.5) * dx;
      if (test(x, y)) { inside[row * cols + col] = 1; any = true; }
    }
  }
  return { view, cols, rows, inside, any };
}

export function maskAt(mask: RegionMask, x: number, y: number): boolean {
  if (x < mask.view.x[0] || x > mask.view.x[1] || y < mask.view.y[0] || y > mask.view.y[1]) return false;
  const col = Math.min(mask.cols - 1, Math.max(0, Math.floor(((x - mask.view.x[0]) / (mask.view.x[1] - mask.view.x[0])) * mask.cols)));
  const row = Math.min(mask.rows - 1, Math.max(0, Math.floor(((y - mask.view.y[0]) / (mask.view.y[1] - mask.view.y[0])) * mask.rows)));
  return mask.inside[row * mask.cols + col] === 1;
}

/** Merge horizontal runs so the renderer draws a few rectangles, not cells. */
export function maskRects(mask: RegionMask): MaskRect[] {
  const rects: MaskRect[] = [];
  const dx = (mask.view.x[1] - mask.view.x[0]) / mask.cols;
  const dy = (mask.view.y[1] - mask.view.y[0]) / mask.rows;
  for (let row = 0; row < mask.rows; row += 1) {
    let start = -1;
    for (let col = 0; col <= mask.cols; col += 1) {
      const on = col < mask.cols && mask.inside[row * mask.cols + col] === 1;
      if (on && start < 0) start = col;
      if (!on && start >= 0) {
        rects.push({
          x0: mask.view.x[0] + start * dx,
          x1: mask.view.x[0] + col * dx,
          y0: mask.view.y[0] + row * dy,
          y1: mask.view.y[0] + (row + 1) * dy,
        });
        start = -1;
      }
    }
  }
  return rects;
}

export interface RowSamples {
  segments: Segments;
  mask?: RegionMask;
}

/** Dispatch a parsed row to the right sampler. Never throws. */
export function sampleRow(row: ParsedExpression, scope: Record<string, unknown>, view: ViewRect, width = 800, height = 600, options: SampleOptions = {}): RowSamples {
  if (row.error) return { segments: [] };
  try {
    switch (row.kind) {
      case "explicit": {
        const fn = curveFunction(row, scope, "x");
        if (!fn) return { segments: [] };
        const domain = row.domain;
        return { segments: sampleExplicit(x => (domain && domain.variable === "x" && !domain.test(x) ? Number.NaN : fn(x)), view, width, height, options) };
      }
      case "explicitY": {
        const fn = curveFunction(row, scope, "y");
        if (!fn) return { segments: [] };
        const domain = row.domain;
        return { segments: sampleExplicitY(y => (domain && domain.variable === "y" && !domain.test(y) ? Number.NaN : fn(y)), view, width, height) };
      }
      case "polar": {
        const fn = curveFunction(row, scope, "theta");
        if (!fn) return { segments: [] };
        const thetaRange = row.domain?.variable === "theta" && row.domain.min !== undefined && row.domain.max !== undefined
          ? [row.domain.min, row.domain.max] as [number, number] : [0, TAU] as [number, number];
        return { segments: samplePolar(fn, view, width, height, { ...options, thetaRange }) };
      }
      case "parametric": {
        const xOf = curveFunction(row, scope, "t");
        const yOf = row.secondary ? (t: number) => {
          try {
            const value = row.secondary!.evaluate({ ...scope, t });
            return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
          } catch { return Number.NaN; }
        } : undefined;
        if (!xOf || !yOf) return { segments: [] };
        const range = row.paramRange ?? [0, TAU];
        return { segments: sampleParametric(xOf, yOf, range, view, width, height, options) };
      }
      case "implicit": {
        if (!row.compiled) return { segments: [] };
        return { segments: marchSquares((x, y) => {
          try {
            const value = row.compiled!.evaluate({ ...scope, x, y }) as unknown;
            return typeof value === "number" ? value : Number.NaN;
          } catch { return Number.NaN; }
        }, view, options.resolution ?? 64) };
      }
      case "inequality": {
        const domain = row.domain;
        return {
          segments: [],
          mask: sampleRegion((x, y) => {
            if (domain?.variable === "x" && !domain.test(x)) return false;
            if (domain?.variable === "y" && !domain.test(y)) return false;
            return testRelation(row, scope, x, y);
          }, view, options.resolution ?? 160),
        };
      }
      default:
        return { segments: [] };
    }
  } catch {
    return { segments: [] };
  }
}

/** Total number of drawn points (useful for diagnostics and tests). */
export function pointCount(segments: Segments): number {
  return segments.reduce((sum, segment) => sum + segment.length, 0);
}

/** Does any segment cross the horizontal strip y ≈ value? */
export function crossesY(segments: Segments, y: number, epsilon = 0.05): boolean {
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      const a = segment[index - 1]!;
      const b = segment[index]!;
      if ((a.y - y) * (b.y - y) <= 0 && Math.abs(a.y - b.y) > 1e-12) return true;
      if (Math.abs(a.y - y) < epsilon) return true;
    }
  }
  return false;
}
