// Graph Lab engine — matrices, exact RREF, eigenvalues and transformation geometry.
import { eigs, fraction, type Fraction } from "./math.ts";
import { type ComplexValue } from "./complex.ts";

export type Matrix = number[][];

export interface RrefResult {
  /** Numeric view of the reduced matrix. */
  matrix: Matrix;
  /** Exact rational entries where possible ("1/3"), same shape as `matrix`. */
  exact: string[][];
  /** Columns containing pivots. */
  pivots: number[];
  rank: number;
}

export interface EigenResult {
  values: ComplexValue[];
  eigenvectors: ComplexValue[][];
}

function shape(matrix: Matrix): [number, number] {
  return [matrix.length, matrix[0]?.length ?? 0];
}

function assertRectangular(matrix: Matrix): void {
  const columns = matrix[0]?.length ?? 0;
  if (!matrix.length || !columns || matrix.some(row => row.length !== columns)) throw new Error("Matrix must be rectangular and non-empty.");
}

export function det(matrix: Matrix): number {
  assertRectangular(matrix);
  const [size, columns] = shape(matrix);
  if (size !== columns) throw new Error("Determinant needs a square matrix.");
  if (size === 1) return matrix[0]![0]!;
  if (size === 2) return matrix[0]![0]! * matrix[1]![1]! - matrix[0]![1]! * matrix[1]![0]!;
  let total = 0;
  for (let column = 0; column < size; column += 1) {
    const minor = matrix.slice(1).map(row => row.filter((_, index) => index !== column));
    total += (column % 2 === 0 ? 1 : -1) * matrix[0]![column]! * det(minor);
  }
  return total;
}

export function transpose(matrix: Matrix): Matrix {
  const columns = matrix[0]?.length ?? 0;
  return Array.from({ length: columns }, (_, column) => matrix.map(row => row[column] ?? 0));
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const [aRows, aColumns] = shape(a);
  const [bRows, bColumns] = shape(b);
  if (!aRows || !aColumns || !bRows || !bColumns) throw new Error("Matrices are empty.");
  if (aColumns !== bRows) throw new Error(`Cannot multiply ${aRows}×${aColumns} by ${bRows}×${bColumns}.`);
  return Array.from({ length: aRows }, (_, row) => Array.from({ length: bColumns }, (_, column) => {
    let total = 0;
    for (let index = 0; index < aColumns; index += 1) total += a[row]![index]! * b[index]![column]!;
    return total;
  }));
}

export function identity(size: number): Matrix {
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)));
}

/** Gauss-Jordan inverse; undefined for singular matrices. */
export function inverse(matrix: Matrix): Matrix | undefined {
  assertRectangular(matrix);
  const [size, columns] = shape(matrix);
  if (size !== columns) throw new Error("Inverse needs a square matrix.");
  const work = matrix.map((row, index) => [...row, ...identity(size)[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row]![column] ?? 0) > Math.abs(work[pivot]![column] ?? 0)) pivot = row;
    }
    if (Math.abs(work[pivot]![column] ?? 0) < 1e-12) return undefined;
    if (pivot !== column) [work[column], work[pivot]] = [work[pivot]!, work[column]!];
    const divisor = work[column]![column]!;
    for (let index = 0; index < size * 2; index += 1) work[column]![index] = work[column]![index]! / divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = work[row]![column]!;
      if (factor === 0) continue;
      for (let index = 0; index < size * 2; index += 1) work[row]![index] = work[row]![index]! - factor * work[column]![index]!;
    }
  }
  return work.map(row => row.slice(size).map(value => (Math.abs(value) < 1e-12 ? 0 : value)));
}

function exact(value: number): Fraction {
  // Decimal numbers are converted as written, so 0.1 is exactly 1/10.
  return fraction(value);
}

/** Exact reduced row echelon form with mathjs fractions. */
export function rref(matrix: Matrix): RrefResult {
  assertRectangular(matrix);
  const [rows, columns] = shape(matrix);
  const work: Fraction[][] = matrix.map(row => row.map(value => exact(value)));
  const pivots: number[] = [];
  let pivotRow = 0;
  for (let column = 0; column < columns && pivotRow < rows; column += 1) {
    let found = -1;
    for (let row = pivotRow; row < rows; row += 1) {
      if (!work[row]![column]!.equals(0)) { found = row; break; }
    }
    if (found < 0) continue;
    if (found !== pivotRow) [work[pivotRow], work[found]] = [work[found]!, work[pivotRow]!];
    const divisor = work[pivotRow]![column]!.clone();
    for (let index = 0; index < columns; index += 1) work[pivotRow]![index] = work[pivotRow]![index]!.div(divisor);
    for (let row = 0; row < rows; row += 1) {
      if (row === pivotRow) continue;
      const factor = work[row]![column]!.clone();
      if (factor.equals(0)) continue;
      for (let index = 0; index < columns; index += 1) {
        work[row]![index] = work[row]![index]!.sub(factor.mul(work[pivotRow]![index]!));
      }
    }
    pivots.push(column);
    pivotRow += 1;
  }
  return {
    matrix: work.map(row => row.map(value => {
      const numeric = Number(value.valueOf());
      return Number.isFinite(numeric) ? numeric : 0;
    })),
    exact: work.map(row => row.map(value => value.toFraction())),
    pivots,
    rank: pivots.length,
  };
}

function toComplex(value: unknown): ComplexValue {
  if (typeof value === "number") return { re: value, im: 0 };
  if (value && typeof value === "object") {
    const candidate = value as { re?: unknown; im?: unknown };
    if (typeof candidate.re === "number" && typeof candidate.im === "number") return { re: candidate.re, im: candidate.im };
  }
  return { re: Number(value), im: 0 };
}

function complexSubtract(a: ComplexValue, b: ComplexValue): ComplexValue {
  return { re: a.re - b.re, im: a.im - b.im };
}

function complexMultiply(a: ComplexValue, b: ComplexValue): ComplexValue {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function complexDivide(a: ComplexValue, b: ComplexValue): ComplexValue {
  const denominator = b.re * b.re + b.im * b.im;
  if (denominator < 1e-30) return { re: Number.NaN, im: Number.NaN };
  return { re: (a.re * b.re + a.im * b.im) / denominator, im: (a.im * b.re - a.re * b.im) / denominator };
}

function complexScale(a: ComplexValue, factor: number): ComplexValue {
  return { re: a.re * factor, im: a.im * factor };
}

/** Eigenvalues: analytic for 2×2, mathjs for larger matrices. */
export function eigenvalues(matrix: Matrix): ComplexValue[] {
  assertRectangular(matrix);
  const [size, columns] = shape(matrix);
  if (size !== columns) throw new Error("Eigenvalues need a square matrix.");
  if (size === 1) return [toComplex(matrix[0]![0])];
  if (size === 2) {
    const a = matrix[0]![0]!, b = matrix[0]![1]!, c = matrix[1]![0]!, d = matrix[1]![1]!;
    const trace = a + d;
    const determinant = a * d - b * c;
    const discriminant = trace * trace - 4 * determinant;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      return [{ re: (trace + root) / 2, im: 0 }, { re: (trace - root) / 2, im: 0 }];
    }
    const root = Math.sqrt(-discriminant);
    return [{ re: trace / 2, im: root / 2 }, { re: trace / 2, im: -root / 2 }];
  }
  const values = mathjsEigenvalues(matrix);
  if (!values || !values.length) throw new Error("Could not compute eigenvalues.");
  return values;
}

function mathjsEigenvalues(matrix: Matrix): ComplexValue[] | undefined {
  try {
    return eigs(matrix).values.map(toComplex);
  } catch { return undefined; }
}

/** One eigenvector per eigenvalue, via complex Gaussian elimination. */
export function eigenvectors(matrix: Matrix, values: ComplexValue[] = eigenvalues(matrix)): ComplexValue[][] {
  assertRectangular(matrix);
  const [size, columns] = shape(matrix);
  if (size !== columns) throw new Error("Eigenvectors need a square matrix.");
  return values.map(value => nullVector(matrix, value) ?? Array.from({ length: size }, () => ({ re: 0, im: 0 })));
}

function nullVector(matrix: Matrix, lambda: ComplexValue): ComplexValue[] | undefined {
  const size = matrix.length;
  const work: ComplexValue[][] = matrix.map((row, index) => row.map((entry, column) => (
    column === index ? complexSubtract({ re: entry, im: 0 }, lambda) : { re: entry, im: 0 }
  )));
  const pivots: number[] = [];
  let pivotRow = 0;
  for (let column = 0; column < size && pivotRow < size; column += 1) {
    let found = -1;
    for (let row = pivotRow; row < size; row += 1) {
      const entry = work[row]![column]!;
      if (Math.hypot(entry.re, entry.im) > 1e-9) { found = row; break; }
    }
    if (found < 0) continue;
    if (found !== pivotRow) [work[pivotRow], work[found]] = [work[found]!, work[pivotRow]!];
    const divisor = work[pivotRow]![column]!;
    for (let index = 0; index < size; index += 1) work[pivotRow]![index] = complexDivide(work[pivotRow]![index]!, divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === pivotRow) continue;
      const factor = work[row]![column]!;
      if (Math.hypot(factor.re, factor.im) < 1e-12) continue;
      for (let index = 0; index < size; index += 1) {
        work[row]![index] = complexSubtract(work[row]![index]!, complexMultiply(factor, work[pivotRow]![index]!));
      }
    }
    pivots.push(column);
    pivotRow += 1;
  }
  if (pivots.length === size) return undefined;
  const free = Array.from({ length: size }, (_, column) => column).filter(column => !pivots.includes(column));
  const target = free[free.length - 1]!;
  const vector: ComplexValue[] = Array.from({ length: size }, () => ({ re: 0, im: 0 }));
  vector[target] = { re: 1, im: 0 };
  for (let index = pivots.length - 1; index >= 0; index -= 1) {
    const column = pivots[index]!;
    const coefficient = work[index]![target]!;
    vector[column] = { re: -coefficient.re, im: -coefficient.im };
  }
  return vector;
}

export function eigen(matrix: Matrix): EigenResult {
  const values = eigenvalues(matrix);
  return { values, eigenvectors: eigenvectors(matrix, values) };
}

/** Solve Ax = b; undefined when inconsistent or non-unique. */
export function solve(matrix: Matrix, vector: number[]): number[] | undefined {
  assertRectangular(matrix);
  const [rows, columns] = shape(matrix);
  if (vector.length !== rows) throw new Error("Right-hand side has the wrong height.");
  const work = matrix.map((row, index) => [...row, vector[index]!]);
  let pivotRow = 0;
  for (let column = 0; column < columns && pivotRow < rows; column += 1) {
    let found = -1;
    for (let row = pivotRow; row < rows; row += 1) {
      if (Math.abs(work[row]![column] ?? 0) > 1e-12) { found = row; break; }
    }
    if (found < 0) continue;
    if (found !== pivotRow) [work[pivotRow], work[found]] = [work[found]!, work[pivotRow]!];
    const divisor = work[pivotRow]![column]!;
    for (let index = column; index <= columns; index += 1) work[pivotRow]![index] = work[pivotRow]![index]! / divisor;
    for (let row = 0; row < rows; row += 1) {
      if (row === pivotRow) continue;
      const factor = work[row]![column]!;
      if (factor === 0) continue;
      for (let index = column; index <= columns; index += 1) work[row]![index] = work[row]![index]! - factor * work[pivotRow]![index]!;
    }
    pivotRow += 1;
  }
  for (let row = pivotRow; row < rows; row += 1) {
    if (work[row]!.slice(0, columns).every(value => Math.abs(value) < 1e-12) && Math.abs(work[row]![columns] ?? 0) > 1e-12) return undefined;
  }
  if (pivotRow < columns) return undefined;
  const solution = Array.from({ length: columns }, () => 0);
  for (let row = 0; row < pivotRow; row += 1) {
    let pivot = 0;
    while (pivot < columns && Math.abs(work[row]![pivot] ?? 0) < 1e-12) pivot += 1;
    if (pivot < columns) solution[pivot] = work[row]![columns]!;
  }
  return solution;
}

export function transformPoint(matrix: Matrix, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (matrix[0]?.[0] ?? 0) * point.x + (matrix[0]?.[1] ?? 0) * point.y,
    y: (matrix[1]?.[0] ?? 0) * point.x + (matrix[1]?.[1] ?? 0) * point.y,
  };
}

export interface GridLineImage {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** Images of the domain grid lines under a 2×2 matrix. */
export function gridLineImages(matrix: Matrix, view: { x: [number, number]; y: [number, number] } = { x: [-2, 2], y: [-2, 2] }, lines = 8): GridLineImage[] {
  const output: GridLineImage[] = [];
  const count = Math.max(2, Math.min(40, Math.round(lines)));
  const xStep = (view.x[1] - view.x[0]) / count;
  const yStep = (view.y[1] - view.y[0]) / count;
  for (let index = 0; index <= count; index += 1) {
    const x = view.x[0] + index * xStep;
    output.push({
      from: transformPoint(matrix, { x, y: view.y[0] }),
      to: transformPoint(matrix, { x, y: view.y[1] }),
    });
  }
  for (let index = 0; index <= count; index += 1) {
    const y = view.y[0] + index * yStep;
    output.push({
      from: transformPoint(matrix, { x: view.x[0], y }),
      to: transformPoint(matrix, { x: view.x[1], y }),
    });
  }
  return output;
}

/** The unit square's image: a parallelogram whose signed area is det(A). */
export function unitSquareImage(matrix: Matrix): { x: number; y: number }[] {
  return [
    transformPoint(matrix, { x: 0, y: 0 }),
    transformPoint(matrix, { x: 1, y: 0 }),
    transformPoint(matrix, { x: 1, y: 1 }),
    transformPoint(matrix, { x: 0, y: 1 }),
  ];
}

export function signedArea(points: readonly { x: number; y: number }[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

export interface EigenLine {
  point: { x: number; y: number };
  direction: { x: number; y: number };
  eigenvalue: number;
}

/** Real eigenvector lines through the origin (none for a pure rotation). */
export function eigenLines(matrix: Matrix): EigenLine[] {
  if (matrix.length !== 2) return [];
  const values = eigenvalues(matrix);
  const vectors = eigenvectors(matrix, values);
  const lines: EigenLine[] = [];
  values.forEach((value, index) => {
    if (Math.abs(value.im) > 1e-9) return;
    const vector = vectors[index]!;
    const length = Math.hypot(vector.re, vector.im);
    if (length < 1e-9) return;
    lines.push({
      point: { x: 0, y: 0 },
      direction: { x: vector.re / length, y: vector.im / length },
      eigenvalue: value.re,
    });
  });
  return lines;
}

export function lerpMatrix(a: Matrix, b: Matrix, t: number): Matrix {
  const clamped = Math.max(0, Math.min(1, t));
  return a.map((row, rowIndex) => row.map((value, columnIndex) => value * (1 - clamped) + (b[rowIndex]?.[columnIndex] ?? 0) * clamped));
}

/** Matrix at t = 0 is the identity, at t = 1 it is A. */
export function morphFromIdentity(matrix: Matrix, t: number): Matrix {
  return lerpMatrix(identity(matrix.length), matrix, t);
}

export function fromRows(rows: number[][]): Matrix {
  return rows.map(row => row.slice());
}

export function parseMatrixInput(text: string, size = 2): Matrix {
  const numbers = text.split(/[^0-9.+\-eE]+/).map(part => Number(part)).filter(value => Number.isFinite(value));
  const matrix: Matrix = [];
  for (let row = 0; row < size; row += 1) {
    matrix.push(Array.from({ length: size }, (_, column) => numbers[row * size + column] ?? (row === column ? 1 : 0)));
  }
  return matrix;
}

export function formatMatrix(matrix: Matrix, digits = 3): string {
  return matrix.map(row => row.map(value => {
    if (Math.abs(value) < 1e-12) return "0";
    const rounded = Number(value.toFixed(digits));
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }).join("  ")).join("\n");
}

export { toComplex };
