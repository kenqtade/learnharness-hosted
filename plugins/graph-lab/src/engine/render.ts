// Graph Lab engine — canvas 2D renderer for 2D, complex, matrix and 3D scenes.
// DPR aware; colours come from host CSS variables where they should follow the
// theme, and from a fixed palette for curves (readable on light and dark).
import { axisLabels, toScreen, type ViewRect, type Viewport } from "./viewport.ts";
import { maskRects, type RegionMask, type SamplePoint, type Segments } from "./sample.ts";
import type { RgbaImage } from "./complex.ts";
import { painterSort, project, triangles, type Camera, type Mesh, type Triangle } from "./surface.ts";

export interface Palette {
  foreground: string;
  background: string;
  muted: string;
  border: string;
  accent: string;
  dark: boolean;
}

export const CURVE_COLORS = ["#2f7ed8", "#d94b4b", "#2f9e57", "#8a56c9", "#e8871e", "#0f9b9b", "#c2308f", "#6b7a1f"] as const;

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

function luminance(color: string): number {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    let value = hex[1]!;
    if (value.length === 3) value = value.split("").map(character => character + character).join("");
    const red = parseInt(value.slice(0, 2), 16);
    const green = parseInt(value.slice(2, 4), 16);
    const blue = parseInt(value.slice(4, 6), 16);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color);
  if (rgb) {
    return (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255;
  }
  return 0;
}

/** Read host theme colours once per draw; never hard-code page colours. */
export function readPalette(container: HTMLElement): Palette {
  const style = getComputedStyle(container);
  const foreground = cssVar(style, "--foreground", "#1f2937");
  const background = cssVar(style, "--background", "#ffffff");
  return {
    foreground,
    background,
    muted: cssVar(style, "--muted-foreground", "#6b7280"),
    border: cssVar(style, "--border", "rgba(127,127,127,0.35)"),
    accent: cssVar(style, "--accent", "#2f7ed8"),
    dark: luminance(background) < 0.5,
  };
}

export interface SceneCurve {
  id: string;
  color: string;
  segments: Segments;
  mask?: RegionMask;
  selected?: boolean;
  width?: number;
  dashed?: boolean;
}

export interface ScenePoint {
  x: number;
  y: number;
  label?: string;
  color?: string;
  filled?: boolean;
}

export interface SceneLine {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  dashed?: boolean;
  label?: string;
  width?: number;
}

export interface SceneArea {
  segments: Segments;
  color: string;
  baseline?: number;
}

export interface Scene {
  view: ViewRect;
  curves: SceneCurve[];
  points?: ScenePoint[];
  lines?: SceneLine[];
  areas?: SceneArea[];
  showGrid?: boolean;
  piTicks?: boolean;
  labels?: { x: number; y: number; text: string; color?: string }[];
}

export function clearCanvas(ctx: CanvasRenderingContext2D, width: number, height: number, palette: Palette): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
}

export function drawGrid(ctx: CanvasRenderingContext2D, viewport: Viewport, palette: Palette, options: { piTicks?: boolean } = {}): void {
  const labels = axisLabels(viewport, { piTicks: options.piTicks });
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.foreground;
  ctx.globalAlpha = 0.12;
  ctx.beginPath();
  for (const tick of labels.x) {
    const x = Math.round(tick.position) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, viewport.height);
  }
  for (const tick of labels.y) {
    const y = Math.round(tick.position) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(viewport.width, y);
  }
  ctx.stroke();

  // Axes sit at the world origin when visible, otherwise at the canvas edge.
  const origin = toScreen(viewport, 0, 0);
  const axisX = Math.max(0, Math.min(viewport.height, origin.y));
  const axisY = Math.max(0, Math.min(viewport.width, origin.x));
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = palette.muted;
  ctx.beginPath();
  ctx.moveTo(0, axisX + 0.5); ctx.lineTo(viewport.width, axisX + 0.5);
  ctx.moveTo(axisY + 0.5, 0); ctx.lineTo(axisY + 0.5, viewport.height);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.muted;
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (const tick of labels.x) {
    if (tick.value === 0) continue;
    if (tick.position < 18 || tick.position > viewport.width - 6) continue;
    ctx.fillText(tick.label, tick.position + 3, Math.min(viewport.height - 14, Math.max(2, axisX + 3)));
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const tick of labels.y) {
    if (tick.value === 0) continue;
    if (tick.position < 10 || tick.position > viewport.height - 4) continue;
    ctx.fillText(tick.label, Math.min(viewport.width - 3, Math.max(18, axisY - 4)), tick.position);
  }
  ctx.restore();
}

export function drawRegions(ctx: CanvasRenderingContext2D, viewport: Viewport, curves: readonly SceneCurve[]): void {
  ctx.save();
  for (const curve of curves) {
    if (!curve.mask) continue;
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = curve.color;
    for (const rect of maskRects(curve.mask)) {
      const topLeft = toScreen(viewport, rect.x0, rect.y1);
      const bottomRight = toScreen(viewport, rect.x1, rect.y0);
      ctx.fillRect(topLeft.x, topLeft.y, Math.max(1, bottomRight.x - topLeft.x + 0.5), Math.max(1, bottomRight.y - topLeft.y + 0.5));
    }
    // A solid edge helps the shaded region read as a set, not a smear.
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 1.5;
    for (const segment of curve.segments) {
      if (segment.length < 2) continue;
      ctx.beginPath();
      segment.forEach((point, index) => {
        const screen = toScreen(viewport, point.x, point.y);
        if (index === 0) ctx.moveTo(screen.x, screen.y); else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawAreas(ctx: CanvasRenderingContext2D, viewport: Viewport, areas: readonly SceneArea[]): void {
  ctx.save();
  for (const area of areas) {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = area.color;
    const baseline = area.baseline ?? 0;
    for (const segment of area.segments) {
      if (segment.length < 2) continue;
      ctx.beginPath();
      const first = toScreen(viewport, segment[0]!.x, baseline);
      ctx.moveTo(first.x, first.y);
      for (const point of segment) {
        const screen = toScreen(viewport, point.x, point.y);
        ctx.lineTo(screen.x, screen.y);
      }
      const last = segment[segment.length - 1]!;
      const end = toScreen(viewport, last.x, baseline);
      ctx.lineTo(end.x, end.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

function strokePolyline(ctx: CanvasRenderingContext2D, viewport: Viewport, segment: readonly SamplePoint[]): void {
  if (segment.length < 2) return;
  ctx.beginPath();
  segment.forEach((point, index) => {
    const screen = toScreen(viewport, point.x, point.y);
    if (index === 0) ctx.moveTo(screen.x, screen.y);
    else ctx.lineTo(screen.x, screen.y);
  });
  ctx.stroke();
}

export function drawCurves(ctx: CanvasRenderingContext2D, viewport: Viewport, curves: readonly SceneCurve[]): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const curve of curves) {
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = curve.selected ? 3.2 : curve.width ?? 2;
    ctx.setLineDash(curve.dashed ? [6, 5] : []);
    for (const segment of curve.segments) strokePolyline(ctx, viewport, segment);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawLines(ctx: CanvasRenderingContext2D, viewport: Viewport, lines: readonly SceneLine[]): void {
  ctx.save();
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  for (const line of lines) {
    const from = toScreen(viewport, line.from.x, line.from.y);
    const to = toScreen(viewport, line.to.x, line.to.y);
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width ?? 1.5;
    ctx.setLineDash(line.dashed ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    if (line.label) {
      ctx.setLineDash([]);
      ctx.fillStyle = line.color;
      ctx.fillText(line.label, to.x + 4, to.y - 4);
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawPoints(ctx: CanvasRenderingContext2D, viewport: Viewport, points: readonly ScenePoint[], palette: Palette): void {
  ctx.save();
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  for (const point of points) {
    const screen = toScreen(viewport, point.x, point.y);
    if (screen.x < -40 || screen.x > viewport.width + 40 || screen.y < -40 || screen.y > viewport.height + 40) continue;
    const color = point.color ?? palette.accent;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = point.filled === false ? palette.background : color;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (point.label) {
      ctx.fillStyle = point.color ?? palette.foreground;
      ctx.fillText(point.label, screen.x + 7, screen.y - 6);
    }
  }
  ctx.restore();
}

/** Compose a full 2D scene. The caller owns the curve samples. */
export function drawScene(ctx: CanvasRenderingContext2D, viewport: Viewport, scene: Scene, palette: Palette): void {
  clearCanvas(ctx, viewport.width, viewport.height, palette);
  if (scene.showGrid !== false) drawGrid(ctx, viewport, palette, { piTicks: scene.piTicks });
  drawAreas(ctx, viewport, scene.areas ?? []);
  drawRegions(ctx, viewport, scene.curves);
  drawCurves(ctx, viewport, scene.curves);
  drawLines(ctx, viewport, scene.lines ?? []);
  drawPoints(ctx, viewport, scene.points ?? [], palette);
  if (scene.labels?.length) {
    ctx.save();
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    for (const label of scene.labels) {
      const screen = toScreen(viewport, label.x, label.y);
      ctx.fillStyle = label.color ?? palette.foreground;
      ctx.fillText(label.text, screen.x, screen.y);
    }
    ctx.restore();
  }
}

/** Domain-colouring colours as an image, scaled over the whole canvas. */
export function drawComplexImage(ctx: CanvasRenderingContext2D, image: RgbaImage, width: number, height: number): void {
  const offscreen = document.createElement("canvas");
  offscreen.width = image.width;
  offscreen.height = image.height;
  const offCtx = offscreen.getContext("2d");
  if (!offCtx) return;
  const imageData = offCtx.createImageData(image.width, image.height);
  imageData.data.set(image.data);
  offCtx.putImageData(imageData, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(offscreen, 0, 0, width, height);
  ctx.restore();
}

/** Draw a 3-D surface with painter's sorting and Lambert shading. */
export function drawSurface(ctx: CanvasRenderingContext2D, mesh: Mesh, camera: Camera, width: number, height: number, palette: Palette, options: { base?: string; showBox?: boolean; box?: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }[] } = {}): void {
  const base = options.base ?? (palette.dark ? "#5b9fe8" : "#2f7ed8");
  const sorted = painterSort(triangles(mesh), camera);
  for (const triangle of sorted) {
    const projected = triangle.points.map(point => project(point, camera, width, height));
    ctx.beginPath();
    ctx.moveTo(projected[0]!.x, projected[0]!.y);
    ctx.lineTo(projected[1]!.x, projected[1]!.y);
    ctx.lineTo(projected[2]!.x, projected[2]!.y);
    ctx.closePath();
    ctx.fillStyle = blendShade(base, triangle.shade);
    ctx.fill();
    ctx.strokeStyle = blendShade(base, triangle.shade * 0.85);
    ctx.lineWidth = 0.35;
    ctx.stroke();
  }
  if (options.showBox && options.box) {
    ctx.save();
    ctx.strokeStyle = palette.muted;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    for (const edge of options.box) {
      const from = project(edge.from, camera, width, height);
      const to = project(edge.to, camera, width, height);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    }
    ctx.restore();
  }
}

function averageDepth(triangle: Triangle, camera: Camera): number {
  return triangle.points.reduce((sum, point) => sum + project(point, camera, 1, 1).depth, 0) / 3;
}

function parseHex(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!match) return [47, 126, 216];
  let value = match[1]!;
  if (value.length === 3) value = value.split("").map(character => character + character).join("");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

export function blendShade(color: string, shadeValue: number): string {
  const [red, green, blue] = parseHex(color);
  const factor = Math.max(0.2, Math.min(1.2, shadeValue));
  const mix = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * factor)));
  return `rgb(${mix(red)}, ${mix(green)}, ${mix(blue)})`;
}

/** Grid images of a 2×2 transformation, including the unit square and eigenlines. */
export function drawTransformation(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  payload: {
    grid: { from: { x: number; y: number }; to: { x: number; y: number } }[];
    unitSquare: { x: number; y: number }[];
    eigenLines?: { point: { x: number; y: number }; direction: { x: number; y: number }; eigenvalue: number }[];
    color?: string;
  },
  palette: Palette,
): void {
  clearCanvas(ctx, viewport.width, viewport.height, palette);
  drawGrid(ctx, viewport, palette);
  ctx.save();
  ctx.strokeStyle = payload.color ?? palette.accent;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const line of payload.grid) {
    const from = toScreen(viewport, line.from.x, line.from.y);
    const to = toScreen(viewport, line.to.x, line.to.y);
    ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  const square = payload.unitSquare;
  if (square.length >= 3) {
    ctx.beginPath();
    square.forEach((point, index) => {
      const screen = toScreen(viewport, point.x, point.y);
      if (index === 0) ctx.moveTo(screen.x, screen.y); else ctx.lineTo(screen.x, screen.y);
    });
    ctx.closePath();
    ctx.fillStyle = payload.color ?? palette.accent;
    ctx.globalAlpha = 0.28;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = payload.color ?? palette.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const line of payload.eigenLines ?? []) {
    const length = Math.max(viewport.view.x[1] - viewport.view.x[0], viewport.view.y[1] - viewport.view.y[0]) * 2;
    const from = { x: line.point.x - line.direction.x * length, y: line.point.y - line.direction.y * length };
    const to = { x: line.point.x + line.direction.x * length, y: line.point.y + line.direction.y * length };
    drawLines(ctx, viewport, [{ from, to, color: palette.muted, dashed: true, label: `λ=${Number(line.eigenvalue.toFixed(3))}` }]);
  }
  ctx.restore();
}

/** Arrow helper for complex vectors and transformations. */
export function drawArrow(ctx: CanvasRenderingContext2D, viewport: Viewport, from: { x: number; y: number }, to: { x: number; y: number }, color: string): void {
  const a = toScreen(viewport, from.x, from.y);
  const b = toScreen(viewport, to.x, to.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = 8;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(angle - 0.4), b.y - head * Math.sin(angle - 0.4));
  ctx.lineTo(b.x - head * Math.cos(angle + 0.4), b.y - head * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Canvas wrapper that owns DPR sizing. */
export class GraphCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 1;
  height = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw graphs (no 2D canvas).");
    this.ctx = context;
  }

  resize(width?: number, height?: number): { width: number; height: number } {
    const cssWidth = Math.max(1, Math.round(width ?? this.canvas.clientWidth ?? 1));
    const cssHeight = Math.max(1, Math.round(height ?? this.canvas.clientHeight ?? 1));
    const dpr = typeof devicePixelRatio === "number" && Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(3, devicePixelRatio)) : 1;
    if (this.canvas.width !== Math.round(cssWidth * dpr) || this.canvas.height !== Math.round(cssHeight * dpr)) {
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
    }
    this.width = cssWidth;
    this.height = cssHeight;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: cssWidth, height: cssHeight };
  }

  get context(): CanvasRenderingContext2D { return this.ctx; }

  viewport(view: ViewRect): Viewport {
    return { view, width: this.width, height: this.height };
  }

  draw(view: ViewRect, scene: Omit<Scene, "view">, palette: Palette): void {
    drawScene(this.ctx, this.viewport(view), { ...scene, view }, palette);
  }

  clear(palette: Palette): void {
    clearCanvas(this.ctx, this.width, this.height, palette);
  }
}
