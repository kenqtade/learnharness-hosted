// Graph Lab engine — the serialisable graph state (JSON) and its validation.
import { DEFAULT_SLIDER, type SliderSpec } from "./expressions.ts";

export type GraphMode = "2d" | "complex" | "matrix" | "3d";
export const GRAPH_MODES: readonly GraphMode[] = ["2d", "complex", "matrix", "3d"];

export interface GraphExpression {
  id: string;
  text: string;
  color?: string;
  hidden?: boolean;
}

export interface GraphView {
  x: [number, number];
  y: [number, number];
}

export interface GraphOptions {
  degrees?: boolean;
  grid?: boolean;
  piTicks?: boolean;
}

export interface GraphState {
  version: 1;
  mode: GraphMode;
  expressions: GraphExpression[];
  sliders: Record<string, SliderSpec>;
  view: GraphView;
  options?: GraphOptions;
}

export class GraphStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphStateError";
  }
}

export const DEFAULT_VIEW: GraphView = { x: [-10, 10], y: [-10, 10] };

export const GRAPH_COLORS = ["#2f7ed8", "#d94b4b", "#2f9e57", "#8a56c9", "#e8871e", "#0f9b9b"] as const;

export function defaultGraphState(mode: GraphMode = "2d"): GraphState {
  return {
    version: 1,
    mode,
    expressions: [{ id: "e1", text: "", color: GRAPH_COLORS[0] }],
    sliders: {},
    view: { x: [...DEFAULT_VIEW.x] as [number, number], y: [...DEFAULT_VIEW.y] as [number, number] },
    options: { degrees: false, grid: true, piTicks: false },
  };
}

let counter = 0;
export function newExpressionId(): string {
  counter += 1;
  return `e${Date.now().toString(36)}${counter.toString(36)}`;
}

export function createExpression(text = "", color?: string): GraphExpression {
  return { id: newExpressionId(), text, ...(color ? { color } : {}) };
}

export function cloneGraphState(state: GraphState): GraphState {
  return {
    version: 1,
    mode: state.mode,
    expressions: state.expressions.map(expression => ({ ...expression })),
    sliders: Object.fromEntries(Object.entries(state.sliders).map(([name, spec]) => [name, { ...spec }])),
    view: { x: [...state.view.x] as [number, number], y: [...state.view.y] as [number, number] },
    options: { ...defaultOptions(), ...state.options },
  };
}

function defaultOptions(): Required<GraphOptions> {
  return { degrees: false, grid: true, piTicks: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new GraphStateError(message);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseRange(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value)) return fallback;
  if (value.length !== 2) invalid("View ranges need exactly two numbers.");
  const first = value[0];
  const second = value[1];
  if (typeof first !== "number" || typeof second !== "number" || !Number.isFinite(first) || !Number.isFinite(second)) {
    invalid("View ranges need finite numbers.");
  }
  if (first === second) invalid("View range must have two different bounds.");
  return first < second ? [first, second] : [second, first];
}

function parseSliders(value: unknown): Record<string, SliderSpec> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid("sliders must be an object.");
  const sliders: Record<string, SliderSpec> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid(`Invalid slider name "${name}".`);
    if (!isRecord(raw)) invalid(`Slider "${name}" must be an object.`);
    const min = numberValue(raw.min, DEFAULT_SLIDER.min);
    const max = numberValue(raw.max, DEFAULT_SLIDER.max);
    const step = numberValue(raw.step, DEFAULT_SLIDER.step);
    const initial = numberValue(raw.value, DEFAULT_SLIDER.value);
    if (min >= max) invalid(`Slider "${name}" needs min < max.`);
    if (step <= 0) invalid(`Slider "${name}" needs step > 0.`);
    sliders[name] = {
      min, max, step,
      value: Math.max(min, Math.min(max, initial)),
    };
  }
  return sliders;
}

function parseExpressions(value: unknown): GraphExpression[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("expressions must be an array.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw === "string") {
      const id = uniqueId(`e${index + 1}`, seen);
      return { id, text: raw };
    }
    if (!isRecord(raw)) invalid(`Expression ${index + 1} must be an object.`);
    if (typeof raw.text !== "string") invalid(`Expression ${index + 1} needs a text string.`);
    if (raw.text.length > 4000) invalid(`Expression ${index + 1} is too long.`);
    const providedId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `e${index + 1}`;
    const id = uniqueId(providedId, seen);
    const expression: GraphExpression = { id, text: raw.text };
    if (typeof raw.color === "string" && raw.color.trim()) expression.color = raw.color.trim();
    if (typeof raw.hidden === "boolean") expression.hidden = raw.hidden;
    return expression;
  });
}

function uniqueId(preferred: string, seen: Set<string>): string {
  let id = preferred;
  let suffix = 2;
  while (seen.has(id)) { id = `${preferred}-${suffix}`; suffix += 1; }
  seen.add(id);
  return id;
}

function parseMode(value: unknown): GraphMode {
  if (value === undefined) return "2d";
  if (typeof value !== "string" || !GRAPH_MODES.includes(value as GraphMode)) {
    invalid(`mode must be one of ${GRAPH_MODES.join(", ")}.`);
  }
  return value as GraphMode;
}

function parseOptions(value: unknown): Required<GraphOptions> {
  if (value === undefined) return defaultOptions();
  if (!isRecord(value)) invalid("options must be an object.");
  const options = defaultOptions();
  if (value.degrees !== undefined) {
    if (typeof value.degrees !== "boolean") invalid("options.degrees must be true or false.");
    options.degrees = value.degrees;
  }
  if (value.grid !== undefined) {
    if (typeof value.grid !== "boolean") invalid("options.grid must be true or false.");
    options.grid = value.grid;
  }
  if (value.piTicks !== undefined) {
    if (typeof value.piTicks !== "boolean") invalid("options.piTicks must be true or false.");
    options.piTicks = value.piTicks;
  }
  return options;
}

/** Full JSON state (object or string) or the short form: one expression per line. */
export function parseGraphState(input: unknown): GraphState {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) invalid("The graph is empty.");
    if (!trimmed.startsWith("{")) return parseShortForm(trimmed);
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch (error) { invalid(`Invalid graph JSON: ${(error as Error).message}`); }
    return parseGraphState(value);
  }
  if (!isRecord(input)) invalid("Graph state must be an object.");
  if (input.version !== undefined && input.version !== 1) invalid(`Unsupported graph version: ${String(input.version)}.`);
  const sliders = parseSliders(input.sliders);
  const viewValue = input.view === undefined ? {} : input.view;
  if (!isRecord(viewValue)) invalid("view must be an object.");
  return {
    version: 1,
    mode: parseMode(input.mode),
    expressions: parseExpressions(input.expressions),
    sliders,
    view: {
      x: parseRange(viewValue.x, [...DEFAULT_VIEW.x] as [number, number]),
      y: parseRange(viewValue.y, [...DEFAULT_VIEW.y] as [number, number]),
    },
    options: parseOptions(input.options),
  };
}

function parseShortForm(source: string): GraphState {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!lines.length) invalid("The graph is empty.");
  const expressions = lines.map((text, index) => ({ id: `e${index + 1}`, text, color: GRAPH_COLORS[index % GRAPH_COLORS.length]! }));
  return { ...defaultGraphState(), expressions };
}

export function serializeGraphState(state: GraphState): string {
  return JSON.stringify({
    version: 1,
    mode: state.mode,
    expressions: state.expressions.map(expression => ({
      id: expression.id,
      text: expression.text,
      ...(expression.color ? { color: expression.color } : {}),
      ...(expression.hidden ? { hidden: true } : {}),
    })),
    sliders: state.sliders,
    view: state.view,
    options: { ...defaultOptions(), ...state.options },
  });
}

export function expressionTexts(state: GraphState): string[] {
  return state.expressions.filter(expression => !expression.hidden).map(expression => expression.text);
}

/** Validate a learner-entered colour (falls back to the palette). */
export function safeColor(value: string | undefined, index = 0): string {
  if (value && /^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  return GRAPH_COLORS[index % GRAPH_COLORS.length]!;
}
