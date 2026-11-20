// TRACK A — Graph Lab backend: saved graphs, the hand-over stash, settings and
// tutor instructions. Data lives in ctx.dataDirectory and is always re-read
// before a change (several serverless instances can share one directory).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import type { GraphMode, GraphState } from "./engine/state.ts";

interface Versioned { revision: number }

/** Copies the Exam Prep json-store pattern (plugins own their own storage code). */
class JsonStore<T extends Versioned> {
  private cached: T | undefined;
  constructor(private readonly file: string, private readonly empty: () => T, private readonly validate: (value: unknown) => T = value => value as T) {}

  get(): T {
    try {
      const value = this.validate(JSON.parse(fs.readFileSync(this.file, "utf8")));
      if (!this.cached || value.revision !== this.cached.revision) this.cached = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.cached ??= this.empty();
      else if (!this.cached) throw new Error(`Could not read ${path.basename(this.file)}: ${(error as Error).message}`);
    }
    return this.cached!;
  }

  change<R>(mutate: (draft: T) => R): R {
    const draft = structuredClone(this.get());
    const result = mutate(draft);
    draft.revision = this.get().revision + 1;
    this.write(draft);
    return result;
  }

  private write(value: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = path.join(path.dirname(this.file), `.${path.basename(this.file)}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    this.cached = value;
  }
}

interface SavedGraph {
  id: string;
  name: string;
  state: GraphState;
  createdAt: string;
  updatedAt: string;
}

interface GraphsDocument extends Versioned {
  graphs: SavedGraph[];
  /** One-shot hand-over from a ```graph block to the Lab view. */
  stash?: { id: string; state: GraphState; at: number };
}

interface SettingsDocument extends Versioned {
  defaultMode: GraphMode;
  degrees: boolean;
}

const MODES: readonly GraphMode[] = ["2d", "complex", "matrix", "3d"];
const MAX_GRAPHS = 200;
const MAX_STATE_BYTES = 512 * 1024;
const STASH_TTL_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function rangeValue(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) {
    fail("Graph view ranges must be two finite numbers.");
  }
  const [first, second] = value as [number, number];
  if (first === second) fail("Graph view range must have different bounds.");
  return first < second ? [first, second] : [second, first];
}

/** Validate a stored/imported state without pulling the mathjs engine into the backend. */
export function sanitiseState(input: unknown): GraphState {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { fail("Graph state is not valid JSON."); }
  }
  if (!isRecord(input)) fail("Graph state must be an object.");
  if (input.version !== undefined && input.version !== 1) fail("Only graph state version 1 is supported.");
  const mode = input.mode === undefined ? "2d" : input.mode;
  if (typeof mode !== "string" || !MODES.includes(mode as GraphMode)) fail("Graph mode is invalid.");
  const rawExpressions = input.expressions ?? [];
  if (!Array.isArray(rawExpressions)) fail("Graph expressions must be an array.");
  const expressions = rawExpressions.map((raw, index) => {
    if (typeof raw === "string") return { id: `e${index + 1}`, text: raw };
    if (!isRecord(raw) || typeof raw.text !== "string") fail(`Graph expression ${index + 1} is invalid.`);
    const expression: { id: string; text: string; color?: string; hidden?: boolean } = {
      id: typeof raw.id === "string" && raw.id ? raw.id : `e${index + 1}`,
      text: raw.text as string,
    };
    if (typeof raw.color === "string") expression.color = raw.color;
    if (typeof raw.hidden === "boolean") expression.hidden = raw.hidden;
    return expression;
  });
  const rawSliders = input.sliders ?? {};
  if (!isRecord(rawSliders)) fail("Graph sliders must be an object.");
  const sliders: GraphState["sliders"] = {};
  for (const [name, raw] of Object.entries(rawSliders)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !isRecord(raw)) fail(`Graph slider "${name}" is invalid.`);
    const min = typeof raw.min === "number" && Number.isFinite(raw.min) ? raw.min : -10;
    const max = typeof raw.max === "number" && Number.isFinite(raw.max) ? raw.max : 10;
    const step = typeof raw.step === "number" && Number.isFinite(raw.step) ? raw.step : 0.1;
    const value = typeof raw.value === "number" && Number.isFinite(raw.value) ? raw.value : 1;
    if (min >= max) fail(`Graph slider "${name}" needs min < max.`);
    if (step <= 0) fail(`Graph slider "${name}" needs step > 0.`);
    sliders[name] = { min, max, step, value: Math.max(min, Math.min(max, value)) };
  }
  const rawView = input.view === undefined ? {} : input.view;
  if (!isRecord(rawView)) fail("Graph view must be an object.");
  const options = input.options === undefined ? {} : input.options;
  if (!isRecord(options)) fail("Graph options must be an object.");
  const state: GraphState = {
    version: 1,
    mode: mode as GraphMode,
    expressions,
    sliders,
    view: {
      x: rangeValue(rawView.x ?? [-10, 10]),
      y: rangeValue(rawView.y ?? [-10, 10]),
    },
    options: {
      degrees: options.degrees === true,
      grid: options.grid !== false,
      piTicks: options.piTicks === true,
    },
  };
  if (JSON.stringify(state).length > MAX_STATE_BYTES) fail("Graph state is too large.");
  return state;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") fail("Graph name is required.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) fail("Graph name is required.");
  if (name.length > 120) fail("Graph names are limited to 120 characters.");
  return name;
}

function parseId(value: unknown): string {
  // Generated ids carry 12 characters after the prefix; requiring at least six
  // rejects obviously malformed ids while still allowing a caller's own ids.
  if (typeof value !== "string" || !/^graph_[A-Za-z0-9_-]{6,64}$/.test(value)) fail("Graph id is invalid.");
  return value;
}

const INSTRUCTIONS = `Graph Lab draws a live, interactive graph inside the lesson.

WHEN to include one (only when a picture genuinely helps):
- functions and transformations (shifts, stretches, reflections, period/amplitude)
- systems of equations and intersections; inequalities as shaded regions
- calculus: tangent/derivative, definite integral, zeros and extrema
- complex numbers (mode "complex") and 2×2/3×3 matrices (mode "matrix")
- surfaces z = f(x, y) and space curves (mode "3d")

HOW: write a fenced code block whose language is graph. The body is either JSON
{"mode":"2d","expressions":["y=x^2-2x-3","y=2x+1"],"sliders":{"a":{"min":-3,"max":3,"value":1}},"view":{"x":[-4,6],"y":[-6,6]}}
or one expression per line. Supported rows: y=f(x), x=g(y), r=f(theta),
(x(t),y(t)), (a,b), F(x,y)=G(x,y), inequalities, a=3, f(x)=..., tables [[x,y],...],
and regressions y ~ a x + b. Use {x>0} or {-1<x<2} to restrict a domain.
Complex and matrix rows also accept point lists. Keep examples small (2–4 rows);
never use a graph for arithmetic that plain text explains better.

Examples:
\`\`\`graph
{"mode":"2d","expressions":["y=x^2-2x-3"],"view":{"x":[-3,5],"y":[-6,6]}}
\`\`\`
\`\`\`graph
y = sin(x)
y = 2 sin(x)
{0 < x < 6.283}
\`\`\`
\`\`\`graph
{"mode":"2d","expressions":["y=x^2-4","y=2x-1"]}
\`\`\``;

function parseSettingsDocument(value: unknown): SettingsDocument {
  if (!isRecord(value)) return { revision: 0, defaultMode: "2d", degrees: false };
  const revision = typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0;
  const mode = typeof value.defaultMode === "string" && MODES.includes(value.defaultMode as GraphMode) ? value.defaultMode as GraphMode : "2d";
  return { revision, defaultMode: mode, degrees: value.degrees === true };
}

export function activate(ctx: PluginBackendContext): () => void {
  const graphsFile = path.join(ctx.dataDirectory, "graphs.json");
  const settingsFile = path.join(ctx.dataDirectory, "settings.json");
  const graphs = new JsonStore<GraphsDocument>(graphsFile, () => ({ revision: 0, graphs: [] }), value => {
    if (!isRecord(value)) throw new Error("graphs.json is not an object.");
    const list = Array.isArray(value.graphs) ? value.graphs : [];
    return {
      revision: typeof value.revision === "number" ? value.revision : 0,
      graphs: list.filter((entry): entry is SavedGraph => isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string" && !!entry.state)
        .map(entry => ({ ...entry, state: sanitiseState(entry.state) })),
      ...(isRecord(value.stash) && typeof value.stash.id === "string" && typeof value.stash.at === "number"
        ? { stash: { id: value.stash.id, state: sanitiseState(value.stash.state), at: value.stash.at } }
        : {}),
    };
  });
  const settings = new JsonStore<SettingsDocument>(settingsFile, () => ({ revision: 0, defaultMode: "2d", degrees: false }), parseSettingsDocument);
  const unregister: (() => void)[] = [];
  const assertActive = () => { if (ctx.signal.aborted) throw new Error("Graph Lab is disabled."); };
  const now = () => new Date().toISOString();

  unregister.push(ctx.handle("graphs.list", () => {
    assertActive();
    const document = graphs.get();
    return {
      revision: document.revision,
      graphs: document.graphs.map(graph => ({ id: graph.id, name: graph.name, state: graph.state, createdAt: graph.createdAt, updatedAt: graph.updatedAt })),
    };
  }));

  unregister.push(ctx.handle("graphs.save", input => {
    assertActive();
    if (!isRecord(input)) fail("graphs.save needs {name, state}.");
    const name = cleanName(input.name);
    const state = sanitiseState(input.state);
    const requestedId = typeof input.id === "string" ? input.id : undefined;
    if (requestedId !== undefined) parseId(requestedId);
    return graphs.change(draft => {
      const timestamp = now();
      let graph = requestedId ? draft.graphs.find(entry => entry.id === requestedId) : undefined;
      if (graph) {
        graph.name = name;
        graph.state = state;
        graph.updatedAt = timestamp;
      } else {
        if (draft.graphs.length >= MAX_GRAPHS) fail("Saved graph limit reached; delete one first.");
        graph = { id: `graph_${randomUUID().replace(/-/g, "").slice(0, 12)}`, name, state, createdAt: timestamp, updatedAt: timestamp };
        draft.graphs.unshift(graph);
      }
      return { revision: draft.revision + 1, graph: { ...graph, state: structuredClone(state) } };
    });
  }));

  unregister.push(ctx.handle("graphs.get", input => {
    assertActive();
    if (!isRecord(input)) fail("graphs.get needs {id}.");
    const id = parseId(input.id);
    const graph = graphs.get().graphs.find(entry => entry.id === id);
    return { graph: graph ? { ...graph, state: structuredClone(graph.state) } : null };
  }));

  unregister.push(ctx.handle("graphs.delete", input => {
    assertActive();
    if (!isRecord(input)) fail("graphs.delete needs {id}.");
    const id = parseId(input.id);
    return graphs.change(draft => {
      const before = draft.graphs.length;
      draft.graphs = draft.graphs.filter(entry => entry.id !== id);
      return { revision: draft.revision + 1, deleted: draft.graphs.length !== before };
    });
  }));

  unregister.push(ctx.handle("graphs.stash", input => {
    assertActive();
    if (!isRecord(input)) fail("graphs.stash needs {state}.");
    const state = sanitiseState(input.state);
    const id = `stash_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    graphs.change(draft => { draft.stash = { id, state, at: Date.now() }; return id; });
    return { id };
  }));

  unregister.push(ctx.handle("graphs.unstash", () => {
    assertActive();
    const document = graphs.get();
    const stash = document.stash;
    if (!stash) return { state: null };
    if (Date.now() - stash.at > STASH_TTL_MS) {
      graphs.change(draft => { delete draft.stash; return null; });
      return { state: null };
    }
    graphs.change(draft => { delete draft.stash; return null; });
    return { state: structuredClone(stash.state) };
  }));

  unregister.push(ctx.handle("settings.get", () => {
    assertActive();
    const value = settings.get();
    return { revision: value.revision, defaultMode: value.defaultMode, degrees: value.degrees };
  }));

  unregister.push(ctx.handle("settings.set", input => {
    assertActive();
    if (!isRecord(input)) fail("settings.set needs {defaultMode?, degrees?}.");
    const mode = input.defaultMode;
    if (mode !== undefined && (typeof mode !== "string" || !MODES.includes(mode as GraphMode))) fail("Default mode is invalid.");
    if (input.degrees !== undefined && typeof input.degrees !== "boolean") fail("degrees must be true or false.");
    return settings.change(draft => {
      if (mode !== undefined) draft.defaultMode = mode as GraphMode;
      if (typeof input.degrees === "boolean") draft.degrees = input.degrees;
      return { revision: draft.revision + 1, defaultMode: draft.defaultMode, degrees: draft.degrees };
    });
  }));

  const instructionDisposers = [
    ctx.registerInstructions({ agents: ["prober", "teacher", "practice"], text: INSTRUCTIONS }),
  ];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of unregister.splice(0)) dispose();
    for (const dispose of instructionDisposers.splice(0)) dispose();
  };
}
