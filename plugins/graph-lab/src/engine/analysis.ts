// Graph Lab engine — calculus and points of interest, all numeric.
// Every function tolerates undefined/NaN outputs instead of throwing.

export interface InterestPoint {
  x: number;
  y: number;
  label: string;
  kind: "zero" | "extremum" | "intersection" | "intercept" | "tangent" | "custom";
  detail?: string;
}

export interface Tangent {
  point: { x: number; y: number };
  slope: number;
  /** y = slope (x - x0) + y0 */
  line: (x: number) => number;
  label: string;
}

export interface Bracket {
  a: number;
  b: number;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Central difference with a scale-aware step. */
export function numericDerivative(f: (x: number) => number, x: number, h?: number): number {
  const step = h ?? Math.max(1e-7, Math.abs(x) * 1e-7);
  const before = f(x - step);
  const after = f(x + step);
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    const at = f(x);
    const tiny = Math.max(1e-9, Math.abs(x) * 1e-9);
    const left = f(x - tiny);
    const right = f(x + tiny);
    if (Number.isFinite(left) && Number.isFinite(at)) return (at - left) / tiny;
    if (Number.isFinite(right) && Number.isFinite(at)) return (right - at) / tiny;
    return Number.NaN;
  }
  return (after - before) / (2 * step);
}

export function numericSecondDerivative(f: (x: number) => number, x: number): number {
  const h = Math.max(1e-5, Math.abs(x) * 1e-5);
  const center = f(x);
  const before = f(x - h);
  const after = f(x + h);
  if (![center, before, after].every(Number.isFinite)) return Number.NaN;
  return (after - 2 * center + before) / (h * h);
}

export function tangentLine(f: (x: number) => number, x0: number): Tangent | undefined {
  const y0 = f(x0);
  const slope = numericDerivative(f, x0);
  if (!Number.isFinite(y0) || !Number.isFinite(slope)) return undefined;
  return {
    point: { x: x0, y: y0 },
    slope,
    line: (x: number) => y0 + slope * (x - x0),
    label: `tangent at x = ${round(x0)}`,
  };
}

/** Adaptive Simpson quadrature, vectorised by recursion depth, never throwing. */
export function integrate(f: (x: number) => number, a: number, b: number, tolerance = 1e-9): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  const simpson = (x0: number, x1: number, f0: number, f1: number, fm: number) => ((x1 - x0) / 6) * (f0 + 4 * fm + f1);
  const evaluate = (x: number) => {
    const value = f(x);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const total = (x0: number, x1: number, f0: number, f1: number, fm: number, whole: number, depth: number): number => {
    const middle = (x0 + x1) / 2;
    const leftMiddle = evaluate((x0 + middle) / 2);
    const rightMiddle = evaluate((middle + x1) / 2);
    if (!Number.isFinite(leftMiddle) || !Number.isFinite(rightMiddle)) {
      // Fall back to the current estimate around a pole; a proper integral may
      // not exist, but shading and a finite answer are still better than NaN.
      return whole;
    }
    const leftHalf = simpson(x0, middle, f0, fm, leftMiddle);
    const rightHalf = simpson(middle, x1, fm, f1, rightMiddle);
    const delta = leftHalf + rightHalf - whole;
    if (depth <= 0 || Math.abs(delta) <= 15 * tolerance) return leftHalf + rightHalf + delta / 15;
    return total(x0, middle, f0, fm, leftMiddle, leftHalf, depth - 1) + total(middle, x1, fm, f1, rightMiddle, rightHalf, depth - 1);
  };
  const f0 = evaluate(left);
  const f1 = evaluate(right);
  const fm = evaluate((left + right) / 2);
  if (![f0, f1, fm].every(Number.isFinite)) return Number.NaN;
  return sign * total(left, right, f0, f1, fm, simpson(left, right, f0, f1, fm), 22);
}

/** Points that outline the shaded area under f from a to b, broken at NaNs. */
export function integralSamples(f: (x: number) => number, a: number, b: number, samples = 160): { x: number; y: number }[][] {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  const [left, right] = a <= b ? [a, b] : [b, a];
  const count = Math.max(2, Math.min(2000, Math.round(samples)));
  for (let index = 0; index <= count; index += 1) {
    const x = left + (index / count) * (right - left);
    const y = f(x);
    if (!Number.isFinite(y)) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push({ x, y });
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function dedupe(points: InterestPoint[], tolerance: number): InterestPoint[] {
  const output: InterestPoint[] = [];
  for (const point of points) {
    if (output.some(existing => existing.kind === point.kind && Math.abs(existing.x - point.x) <= tolerance)) continue;
    output.push(point);
  }
  return output;
}

/** Bisection on a bracketed sign change. */
export function bisect(f: (x: number) => number, a: number, b: number, iterations = 80): number {
  let left = a;
  let right = b;
  let fLeft = f(left);
  if (!Number.isFinite(fLeft)) return Number.NaN;
  for (let index = 0; index < iterations; index += 1) {
    const middle = (left + right) / 2;
    const value = f(middle);
    if (!Number.isFinite(value)) return middle;
    if (value === 0) return middle;
    if (Math.sign(value) === Math.sign(fLeft)) { left = middle; fLeft = value; }
    else right = middle;
  }
  return (left + right) / 2;
}

/** Zeros in [range.0, range.1] by scanning for sign changes, then bisection. */
export function findZeros(f: (x: number) => number, range: [number, number], samples = 800): InterestPoint[] {
  const [min, max] = range[0] <= range[1] ? range : [range[1], range[0]];
  const step = (max - min) / Math.max(2, samples);
  const tolerance = Math.max(1e-9, Math.abs(max - min) * 1e-7);
  const found: InterestPoint[] = [];
  let previousX = min;
  let previousY = f(min);
  if (Number.isFinite(previousY) && Math.abs(previousY) < tolerance) found.push({ x: previousX, y: previousY, label: "zero", kind: "zero" });
  for (let index = 1; index <= samples; index += 1) {
    const x = min + index * step;
    const y = f(x);
    if (Number.isFinite(y) && Number.isFinite(previousY)) {
      if (Math.abs(y) < tolerance) found.push({ x, y, label: "zero", kind: "zero" });
      else if (Math.sign(y) !== Math.sign(previousY)) {
        const root = bisect(f, previousX, x);
        if (Number.isFinite(root)) found.push({ x: root, y: Math.abs(f(root)) < 1e-5 ? f(root) : 0, label: "zero", kind: "zero" });
      }
    }
    previousX = x;
    previousY = y;
  }
  return dedupe(found, tolerance).sort((a, b) => a.x - b.x);
}

/** Local maxima and minima by finding sign changes of the numeric derivative. */
export function findExtrema(f: (x: number) => number, range: [number, number], samples = 600): InterestPoint[] {
  const [min, max] = range[0] <= range[1] ? range : [range[1], range[0]];
  const step = (max - min) / Math.max(2, samples);
  const derivative = (x: number) => numericDerivative(f, x);
  const tolerance = Math.max(1e-8, Math.abs(max - min) * 1e-6);
  const found: InterestPoint[] = [];
  let previousX = min;
  let previousSlope = derivative(min);
  for (let index = 1; index <= samples; index += 1) {
    const x = min + index * step;
    const slope = derivative(x);
    if (Number.isFinite(slope) && Number.isFinite(previousSlope) && Math.sign(slope) !== Math.sign(previousSlope)) {
      const critical = bisect(derivative, previousX, x);
      if (Number.isFinite(critical)) {
        const y = f(critical);
        if (Number.isFinite(y)) {
          const curvature = numericSecondDerivative(f, critical);
          const isMaximum = Number.isFinite(curvature) ? curvature < 0 : y >= Math.max(f(critical - step), f(critical + step));
          found.push({
            x: critical, y,
            label: isMaximum ? "maximum" : "minimum",
            kind: "extremum",
            detail: isMaximum ? "max" : "min",
          });
        }
      }
    }
    previousX = x;
    previousSlope = slope;
  }
  return dedupe(found, tolerance).sort((a, b) => a.x - b.x);
}

/** Intersections of two curves in the range. */
export function findIntersections(f: (x: number) => number, g: (x: number) => number, range: [number, number], samples = 800): InterestPoint[] {
  const difference = (x: number) => {
    const a = f(x);
    const b = g(x);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : Number.NaN;
  };
  return findZeros(difference, range, samples).map(point => ({
    x: point.x,
    y: f(point.x),
    label: "intersection",
    kind: "intersection" as const,
  }));
}

export function yIntercept(f: (x: number) => number): InterestPoint | undefined {
  const y = f(0);
  return Number.isFinite(y) ? { x: 0, y, label: "y-intercept", kind: "intercept" } : undefined;
}

/** Everything the UI shows when a curve is clicked. */
export function curvePoints(f: (x: number) => number, range: [number, number], options: { zeros?: boolean; extrema?: boolean; intercept?: boolean } = {}): InterestPoint[] {
  const points: InterestPoint[] = [];
  if (options.intercept !== false) {
    const intercept = yIntercept(f);
    if (intercept) points.push(intercept);
  }
  if (options.zeros !== false) points.push(...findZeros(f, range));
  if (options.extrema !== false) points.push(...findExtrema(f, range));
  return points;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** Label text used by the renderer for a point of interest. */
export function interestLabel(point: InterestPoint): string {
  const coordinates = `(${round(point.x)}, ${round(point.y)})`;
  switch (point.kind) {
    case "zero": return `x = ${round(point.x)}`;
    case "extremum": return `${point.detail ?? "extremum"} ${coordinates}`;
    case "intersection": return `intersection ${coordinates}`;
    case "intercept": return `y-intercept ${coordinates}`;
    case "tangent": return point.label;
    default: return point.label || coordinates;
  }
}
