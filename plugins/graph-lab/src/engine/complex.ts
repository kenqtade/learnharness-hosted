// Graph Lab engine — complex numbers, the complex plane and domain colouring.
import { Complex, evaluate, parse } from "mathjs";

export interface ComplexValue {
  re: number;
  im: number;
}

export const complex = (re: number, im = 0): ComplexValue => ({ re, im });

export function add(a: ComplexValue, b: ComplexValue): ComplexValue {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function subtract(a: ComplexValue, b: ComplexValue): ComplexValue {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function multiply(a: ComplexValue, b: ComplexValue): ComplexValue {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function divide(a: ComplexValue, b: ComplexValue): ComplexValue {
  const denominator = b.re * b.re + b.im * b.im;
  if (denominator === 0) return { re: Number.NaN, im: Number.NaN };
  return { re: (a.re * b.re + a.im * b.im) / denominator, im: (a.im * b.re - a.re * b.im) / denominator };
}

export function modulus(a: ComplexValue): number {
  return Math.hypot(a.re, a.im);
}

export function argument(a: ComplexValue): number {
  return Math.atan2(a.im, a.re);
}

export function fromPolar(radius: number, angle: number): ComplexValue {
  return { re: radius * Math.cos(angle), im: radius * Math.sin(angle) };
}

function fromMathValue(value: unknown): ComplexValue | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? { re: value, im: 0 } : undefined;
  if (typeof value === "bigint") return { re: Number(value), im: 0 };
  if (value && typeof value === "object") {
    const candidate = value as { re?: unknown; im?: unknown };
    if (typeof candidate.re === "number" && typeof candidate.im === "number") {
      if (!Number.isFinite(candidate.re) || !Number.isFinite(candidate.im)) return undefined;
      return { re: candidate.re, im: candidate.im };
    }
  }
  return undefined;
}

/** Evaluate a learner expression such as `1+2i` or `2e^(i pi/3)` as a complex number. */
export function evaluateComplex(source: string): ComplexValue | undefined {
  try { return fromMathValue(evaluate(source)); } catch { return undefined; }
}

/** Compile f(z) for domain colouring and grid images. Returns undefined on a parse error. */
export function compileComplexFunction(source: string): ((z: ComplexValue) => ComplexValue) | undefined {
  let compiled: { evaluate(scope: Record<string, unknown>): unknown };
  try { compiled = parse(source).compile(); } catch { return undefined; }
  return (z: ComplexValue) => {
    try {
      return fromMathValue(compiled.evaluate({ z: new Complex(z.re, z.im) })) ?? { re: Number.NaN, im: Number.NaN };
    } catch { return { re: Number.NaN, im: Number.NaN }; }
  };
}

/** The n distinct nth roots of `value`, starting at its principal argument. */
export function nthRoots(value: ComplexValue, n: number): ComplexValue[] {
  const count = Math.max(1, Math.min(64, Math.round(n)));
  const radius = modulus(value) ** (1 / count);
  const base = argument(value) / count;
  return Array.from({ length: count }, (_, index) => fromPolar(radius, base + (2 * Math.PI * index) / count));
}

export function rootsOfUnity(n: number): ComplexValue[] {
  return nthRoots(complex(1), n);
}

/** Sum of vectors: the geometric meaning of complex addition. */
export function sumGeometry(a: ComplexValue, b: ComplexValue): { vertices: ComplexValue[] } {
  return { vertices: [complex(0), a, add(a, b), b] };
}

/** Product = rotate by arg(b) and scale by |b|. */
export function productGeometry(a: ComplexValue, b: ComplexValue): { from: ComplexValue; to: ComplexValue; angle: number; scale: number } {
  return { from: a, to: multiply(a, b), angle: argument(b), scale: modulus(b) };
}

export function formatComplex(value: ComplexValue, digits = 3): string {
  const round = (number: number) => Number(number.toFixed(digits));
  const re = round(value.re);
  const im = round(value.im);
  if (im === 0) return String(re);
  if (re === 0) return `${im === 1 ? "" : im === -1 ? "−" : im}i`;
  return `${re} ${im < 0 ? "−" : "+"} ${Math.abs(im) === 1 ? "" : Math.abs(im)}i`;
}

export interface DomainColor {
  /** Degrees, 0..360. */
  hue: number;
  /** 0..1. */
  saturation: number;
  /** 0..1. */
  lightness: number;
  r: number;
  g: number;
  b: number;
}

function hueToRgb(hue: number, saturation: number, lightness: number): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360 / 60;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = lightness - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 1) { r = c; g = x; }
  else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/**
 * Hue = argument; lightness follows |f(z)| with log-modulus contour bands
 * (dark bands at powers of two, lighter between them) so growth is visible.
 */
export function domainColor(value: ComplexValue, options: { bands?: number } = {}): DomainColor {
  const magnitude = modulus(value);
  if (!Number.isFinite(magnitude) || !Number.isFinite(value.re) || !Number.isFinite(value.im)) {
    return { hue: 0, saturation: 0, lightness: 0, r: 0, g: 0, b: 0 };
  }
  const hue = ((argument(value) * 180) / Math.PI + 360) % 360;
  const saturation = magnitude === 0 ? 0 : 0.78;
  if (magnitude === 0) return { hue, saturation: 0, lightness: 0.08, r: 20, g: 20, b: 24 };
  const log = Math.log2(magnitude);
  const fractional = ((log % 1) + 1) % 1;
  const band = Math.abs(fractional - 0.5) * 2;
  const sharpness = 0.16;
  const shading = band < sharpness ? 0.28 : 0.42 + 0.3 * band;
  const lightness = Math.max(0.18, Math.min(0.82, shading));
  const { r, g, b } = hueToRgb(hue, saturation, lightness);
  return { hue, saturation, lightness, r, g, b };
}

export function domainColorAt(f: (z: ComplexValue) => ComplexValue, z: ComplexValue): DomainColor {
  try { return domainColor(f(z)); } catch { return { hue: 0, saturation: 0, lightness: 0, r: 0, g: 0, b: 0 }; }
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Domain colouring of f(z) into an RGBA buffer (wrap with ImageData in the browser). */
export function domainColoring(
  f: (z: ComplexValue) => ComplexValue,
  width: number,
  height: number,
  view: { x: [number, number]; y: [number, number] } = { x: [-2, 2], y: [-2, 2] },
  options: { maxPixels?: number } = {},
): RgbaImage {
  const maxPixels = options.maxPixels ?? 320_000;
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
  const cols = Math.max(1, Math.round(width * scale));
  const rows = Math.max(1, Math.round(height * scale));
  const data = new Uint8ClampedArray(cols * rows * 4);
  for (let row = 0; row < rows; row += 1) {
    const y = view.y[1] - ((row + 0.5) / rows) * (view.y[1] - view.y[0]);
    for (let col = 0; col < cols; col += 1) {
      const x = view.x[0] + ((col + 0.5) / cols) * (view.x[1] - view.x[0]);
      let color: DomainColor;
      try { color = domainColor(f({ re: x, im: y })); }
      catch { color = { hue: 0, saturation: 0, lightness: 0, r: 0, g: 0, b: 0 }; }
      const offset = (row * cols + col) * 4;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = 255;
    }
  }
  return { width: cols, height: rows, data };
}

/** Images of the real/imaginary grid lines under f(z), for Möbius-type maps. */
export function gridImages(
  f: (z: ComplexValue) => ComplexValue,
  view: { x: [number, number]; y: [number, number] } = { x: [-2, 2], y: [-2, 2] },
  lines = 8,
  samples = 60,
): ComplexValue[][] {
  const output: ComplexValue[][] = [];
  const count = Math.max(2, Math.min(40, Math.round(lines)));
  const xStep = (view.x[1] - view.x[0]) / count;
  const yStep = (view.y[1] - view.y[0]) / count;
  const addCurve = (point: (t: number) => ComplexValue) => {
    const current: ComplexValue[] = [];
    for (let index = 0; index <= samples; index += 1) {
      let value: ComplexValue;
      try { value = f(point(index / samples)); } catch { value = { re: Number.NaN, im: Number.NaN }; }
      if (!Number.isFinite(value.re) || !Number.isFinite(value.im) || modulus(value) > 1e6) {
        if (current.length > 1) output.push(current.slice());
        current.length = 0;
        continue;
      }
      current.push(value);
    }
    if (current.length > 1) output.push(current);
  };
  for (let index = 0; index <= count; index += 1) {
    const x = view.x[0] + index * xStep;
    addCurve(t => ({ re: x, im: view.y[0] + t * (view.y[1] - view.y[0]) }));
  }
  for (let index = 0; index <= count; index += 1) {
    const y = view.y[0] + index * yStep;
    addCurve(t => ({ re: view.x[0] + t * (view.x[1] - view.x[0]), im: y }));
  }
  return output;
}
