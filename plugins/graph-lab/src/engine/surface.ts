// Graph Lab engine — z = f(x, y) surfaces and parametric space curves.
// Pure 3-D maths: rotation, projection, painter's order and normal shading.
import { parse } from "./math.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera {
  /** Rotation around the vertical z axis, radians. */
  yaw: number;
  /** Tilt, radians (positive looks down). */
  pitch: number;
  /** Pixels per world unit at the centre. */
  scale: number;
}

export interface Projected {
  x: number;
  y: number;
  depth: number;
}

export interface Triangle {
  points: [Vec3, Vec3, Vec3];
  normal: Vec3;
  /** Painter's order: larger depth is farther. */
  depth: number;
  shade: number;
}

export interface Mesh {
  vertices: Vec3[];
  faces: [number, number, number][];
}

export const DEFAULT_CAMERA: Camera = { yaw: Math.PI / 4, pitch: Math.PI / 6, scale: 46 };

export function project(point: Vec3, camera: Camera, width: number, height: number): Projected {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const x = point.x * cosYaw - point.y * sinYaw;
  const yRotated = point.x * sinYaw + point.y * cosYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const up = point.z * cosPitch - yRotated * sinPitch;
  const depth = yRotated * cosPitch + point.z * sinPitch;
  return { x: width / 2 + x * camera.scale, y: height / 2 - up * camera.scale, depth };
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function normalOf(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return cross(subtract(b, a), subtract(c, a));
}

export function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function normalized(vector: Vec3): Vec3 {
  const magnitude = length(vector);
  return magnitude < 1e-12 ? { x: 0, y: 0, z: 1 } : { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

const LIGHT: Vec3 = normalized({ x: -0.4, y: -0.6, z: 0.9 });

/** Lambert shading in [0.25, 1]; two-sided so the underside is still visible. */
export function shade(normal: Vec3): number {
  const unit = normalized(normal);
  const dot = Math.abs(unit.x * LIGHT.x + unit.y * LIGHT.y + unit.z * LIGHT.z);
  return 0.25 + 0.75 * dot;
}

/** Build a triangle mesh for z = f(x, y). Non-finite samples are left out. */
export function surfaceMesh(f: (x: number, y: number) => number, view: { x: [number, number]; y: [number, number] }, resolution = 36): Mesh {
  const cols = Math.max(2, Math.min(120, Math.round(resolution)));
  const rows = Math.max(2, Math.min(120, Math.round(resolution)));
  const vertices: Vec3[] = [];
  const indices = new Map<string, number>();
  const vertex = (x: number, y: number): number | undefined => {
    const key = `${x}|${y}`;
    const existing = indices.get(key);
    if (existing !== undefined) return existing;
    const z = f(x, y);
    if (!Number.isFinite(z)) return undefined;
    const index = vertices.length;
    vertices.push({ x, y, z });
    indices.set(key, index);
    return index;
  };
  const faces: [number, number, number][] = [];
  const xStep = (view.x[1] - view.x[0]) / cols;
  const yStep = (view.y[1] - view.y[0]) / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const x0 = view.x[0] + column * xStep;
      const y0 = view.y[0] + row * yStep;
      const x1 = x0 + xStep;
      const y1 = y0 + yStep;
      const a = vertex(x0, y0);
      const b = vertex(x1, y0);
      const c = vertex(x1, y1);
      const d = vertex(x0, y1);
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      faces.push([a, b, c]);
      faces.push([a, c, d]);
    }
  }
  return { vertices, faces };
}

export function triangles(mesh: Mesh): Triangle[] {
  const output: Triangle[] = [];
  for (const face of mesh.faces) {
    const a = mesh.vertices[face[0]];
    const b = mesh.vertices[face[1]];
    const c = mesh.vertices[face[2]];
    if (!a || !b || !c) continue;
    const normal = normalized(normalOf(a, b, c));
    output.push({
      points: [a, b, c],
      normal,
      depth: (a.y + b.y + c.y) / 3 + (a.z + b.z + c.z) / 3 * 0.5,
      shade: shade(normal),
    });
  }
  return output;
}

/** Painter's algorithm: farthest triangles first. */
export function painterSort(trianglesValue: readonly Triangle[], camera?: Camera): Triangle[] {
  const sorted = [...trianglesValue];
  if (!camera) return sorted.sort((a, b) => b.depth - a.depth);
  const depth = (triangle: Triangle) => triangle.points.reduce((sum, point) => sum + project(point, camera, 1, 1).depth, 0) / 3;
  return sorted.sort((a, b) => depth(b) - depth(a));
}

function numberResult(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "bigint") return Number(value);
  const candidate = value as { re?: unknown; im?: unknown; valueOf?(): unknown } | undefined;
  if (candidate && typeof candidate.re === "number" && typeof candidate.im === "number") {
    return Math.abs(candidate.im) < 1e-12 && Number.isFinite(candidate.re) ? candidate.re : Number.NaN;
  }
  return Number.NaN;
}

/** Compile z = f(x, y). Returns undefined when the source does not parse. */
export function compileSurface(source: string): ((x: number, y: number) => number) | undefined {
  let compiled: { evaluate(scope: Record<string, unknown>): unknown };
  try { compiled = parse(source).compile(); } catch { return undefined; }
  return (x: number, y: number) => {
    try { return numberResult(compiled.evaluate({ x, y })); } catch { return Number.NaN; }
  };
}

/** Compile a parametric space curve `(x(t), y(t), z(t))`. */
export function compileSpaceCurve(xText: string, yText: string, zText: string): ((t: number) => Vec3) | undefined {
  try {
    const x = parse(xText).compile();
    const y = parse(yText).compile();
    const z = parse(zText).compile();
    return (t: number) => {
      try {
        return {
          x: numberResult(x.evaluate({ t })),
          y: numberResult(y.evaluate({ t })),
          z: numberResult(z.evaluate({ t })),
        };
      } catch { return { x: Number.NaN, y: Number.NaN, z: Number.NaN }; }
    };
  } catch { return undefined; }
}

export function parametricCurve(point: (t: number) => Vec3, range: [number, number], samples = 160): Vec3[] {
  const output: Vec3[] = [];
  const count = Math.max(2, Math.min(4000, Math.round(samples)));
  for (let index = 0; index <= count; index += 1) {
    const value = point(range[0] + (index / count) * (range[1] - range[0]));
    if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) output.push(value);
  }
  return output;
}

export interface BoxEdge {
  from: Vec3;
  to: Vec3;
}

/** 12 edges of the axis box around the plotted domain. */
export function axisBox(view: { x: [number, number]; y: [number, number] }, zRange: [number, number] = [-5, 5]): BoxEdge[] {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const [z0, z1] = zRange;
  const corners: Vec3[] = [
    { x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x0, y: y1, z: z0 },
    { x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 },
  ];
  const pairs: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return pairs.map(([a, b]) => ({ from: corners[a]!, to: corners[b]! }));
}

export function rotateCamera(camera: Camera, dxPixels: number, dyPixels: number): Camera {
  return {
    ...camera,
    yaw: camera.yaw + dxPixels * 0.008,
    pitch: Math.max(-1.45, Math.min(1.45, camera.pitch + dyPixels * 0.008)),
  };
}

export function zoomCamera(camera: Camera, factor: number): Camera {
  return { ...camera, scale: Math.max(4, Math.min(400, camera.scale * factor)) };
}

/** Screen-space polyline for a 3-D curve. */
export function projectCurve(curve: readonly Vec3[], camera: Camera, width: number, height: number): { x: number; y: number }[] {
  return curve.map(point => {
    const projected = project(point, camera, width, height);
    return { x: projected.x, y: projected.y };
  });
}

/** World-space arrow from `from` to `from + direction`, for axis labels. */
export function axisDirections(): { x: Vec3; y: Vec3; z: Vec3 } {
  return { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };
}
