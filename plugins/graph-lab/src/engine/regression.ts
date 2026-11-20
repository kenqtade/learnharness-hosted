// Graph Lab engine — least-squares regressions for table data.

export interface DataPoint {
  x: number;
  y: number;
}

export type RegressionKind = "linear" | "quadratic" | "exponential";

export interface RegressionResult {
  kind: RegressionKind;
  /** a, b for linear; a, b, c for quadratic; a (scale), b (growth) for exponential. */
  coefficients: number[];
  r2: number;
  predict(x: number): number;
  equation: string;
  points: DataPoint[];
}

function clean(points: readonly DataPoint[]): DataPoint[] {
  return points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

/** Gaussian elimination with partial pivoting. */
export function solveSystem(matrix: number[][], vector: number[]): number[] | undefined {
  const size = vector.length;
  if (matrix.length !== size) return undefined;
  const rows = matrix.map((row, index) => [...row, vector[index] ?? 0]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row]![column] ?? 0) > Math.abs(rows[pivot]![column] ?? 0)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column] ?? 0) < 1e-12) return undefined;
    if (pivot !== column) [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const divisor = rows[column]![column]!;
    for (let index = column; index <= size; index += 1) rows[column]![index] = rows[column]![index]! / divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      if (factor === 0) continue;
      for (let index = column; index <= size; index += 1) {
        rows[row]![index] = rows[row]![index]! - factor * rows[column]![index]!;
      }
    }
  }
  return rows.map(row => row[size]!);
}

function rSquared(points: DataPoint[], predict: (x: number) => number): number {
  const mean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let residual = 0;
  let total = 0;
  for (const point of points) {
    const value = predict(point.x);
    if (!Number.isFinite(value)) return 0;
    residual += (point.y - value) ** 2;
    total += (point.y - mean) ** 2;
  }
  if (total < 1e-15) return residual < 1e-15 ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - residual / total));
}

function round(value: number, digits = 4): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function format(value: number): string {
  const rounded = round(value, 4);
  if (rounded === 0) return "0";
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

export function linearRegression(points: readonly DataPoint[]): RegressionResult | undefined {
  const data = clean(points);
  if (data.length < 2) return undefined;
  const count = data.length;
  const sumX = data.reduce((sum, point) => sum + point.x, 0);
  const sumY = data.reduce((sum, point) => sum + point.y, 0);
  const sumXX = data.reduce((sum, point) => sum + point.x * point.x, 0);
  const sumXY = data.reduce((sum, point) => sum + point.x * point.y, 0);
  const solution = solveSystem([[count, sumX], [sumX, sumXX]], [sumY, sumXY]);
  if (!solution) return undefined;
  const [b, a] = solution as [number, number];
  const predict = (x: number) => a * x + b;
  return {
    kind: "linear", coefficients: [b, a], r2: rSquared(data, predict),
    predict, equation: `y = ${format(a)}x ${b < 0 ? "−" : "+"} ${format(Math.abs(b))}`, points: data,
  };
}

export function quadraticRegression(points: readonly DataPoint[]): RegressionResult | undefined {
  const data = clean(points);
  if (data.length < 3) return undefined;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;
  for (const point of data) {
    const x = point.x;
    const y = point.y;
    const x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  const solution = solveSystem([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
  if (!solution) return undefined;
  const [c, b, a] = solution as [number, number, number];
  const predict = (x: number) => a * x * x + b * x + c;
  return {
    kind: "quadratic", coefficients: [c, b, a], r2: rSquared(data, predict),
    predict, equation: `y = ${format(a)}x² ${b < 0 ? "−" : "+"} ${format(Math.abs(b))}x ${c < 0 ? "−" : "+"} ${format(Math.abs(c))}`,
    points: data,
  };
}

export function exponentialRegression(points: readonly DataPoint[]): RegressionResult | undefined {
  const data = clean(points).filter(point => point.y > 0);
  if (data.length < 2) return undefined;
  const transformed = data.map(point => ({ x: point.x, y: Math.log(point.y) }));
  const line = linearRegression(transformed);
  if (!line) return undefined;
  const [logA, b] = line.coefficients as [number, number];
  const a = Math.exp(logA);
  const predict = (x: number) => a * Math.exp(b * x);
  return {
    kind: "exponential", coefficients: [a, b], r2: rSquared(data, predict), predict,
    equation: `y = ${format(a)} e^(${format(b)}x)`, points: data,
  };
}

export function regression(kind: RegressionKind, points: readonly DataPoint[]): RegressionResult | undefined {
  switch (kind) {
    case "linear": return linearRegression(points);
    case "quadratic": return quadraticRegression(points);
    case "exponential": return exponentialRegression(points);
  }
}

/** Fit using the model written in a `y ~ ...` row. */
export function fitRegression(points: readonly DataPoint[], kind: RegressionKind | undefined = "linear"): RegressionResult | undefined {
  return regression(kind ?? "linear", points);
}
