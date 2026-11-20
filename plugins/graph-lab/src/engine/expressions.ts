// Graph Lab engine — turning one expression row into a typed, compiled item.
//
// Everything here is DOM-free and total: `parseExpression` never throws, it
// reports a short message in `error` instead. mathjs does the parsing,
// evaluation, complex numbers and matrices.
import { parse, type MathNode } from "./math.ts";

export type ExpressionKind =
  | "explicit"      // y = f(x)  (also a bare expression)
  | "explicitY"     // x = g(y)
  | "polar"         // r = f(theta)
  | "parametric"    // (x(t), y(t))
  | "point"         // (a, b)
  | "points"        // (a, b), (c, d)
  | "implicit"      // F(x, y) = G(x, y)
  | "inequality"    // y > f(x), x^2 + y^2 < 1
  | "slider"        // a = 3
  | "function"      // f(x) = ...
  | "table"         // [[1, 2], [3, 4]] — x/y columns for regression
  | "regression"    // y ~ a x + b
  | "empty";

export type ComparisonOp = "<" | ">" | "<=" | ">=";

export interface SliderSpec {
  min: number;
  max: number;
  step: number;
  value: number;
}

export const DEFAULT_SLIDER: SliderSpec = { min: -10, max: 10, step: 0.1, value: 1 };

export interface Compiled {
  evaluate(scope?: Record<string, unknown>): unknown;
}

export interface PointSpec {
  x: Compiled;
  y: Compiled;
  /** Readable source of each coordinate, for labels. */
  xText: string;
  yText: string;
}

export interface DomainRestriction {
  variable: string;
  text: string;
  min?: number;
  max?: number;
  minInclusive: boolean;
  maxInclusive: boolean;
  test(value: number): boolean;
}

export type RegressionFamily = "linear" | "quadratic" | "exponential";

export interface ParsedExpression {
  text: string;
  kind: ExpressionKind;
  /** Short learner-facing message; the row is ignored while present. */
  error?: string;
  /** Candidate slider names (free symbols of this row). */
  sliders: string[];
  sliderDef?: { name: string; value: number };
  functionDef?: { name: string; params: string[] };
  domain?: DomainRestriction;
  /** Main compiled part: f(x), g(y), r(theta), t -> x, F(x,y)-G(x,y) or the diff of an inequality. */
  compiled?: Compiled;
  /** Second compiled part of a parametric curve (t -> y). */
  secondary?: Compiled;
  /** Comparison for inequalities; "=" for implicit equalities. */
  op?: ComparisonOp | "=";
  points?: PointSpec[];
  /** t range of a parametric curve. */
  paramRange?: [number, number];
  regression?: { rhs: Compiled; family: RegressionFamily };
  /** Canonical label, e.g. `y = 2x + 1`. */
  display: string;
}

const CONSTANTS = new Set(["e", "pi", "i", "Infinity", "NaN", "true", "false", "phi", "tau"]);
const VARIABLES = new Set(["x", "y", "t", "theta", "r"]);

/** mathjs does not accept the symbols learners type; normalise them first. */
export function normalizeMath(input: string): string {
  return input
    .replace(/\\theta/g, "theta")
    .replace(/\\pi/g, "pi")
    .replace(/[θϑ]/g, "theta")
    .replace(/[πΠ]/g, "pi")
    .replace(/[−–—]/g, "-")
    .replace(/[·×∗]/g, "*")
    .replace(/÷/g, "/")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[（）]/g, m => (m === "（" ? "(" : ")"))
    .trim();
}

function factor(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `(${name})`;
}

/** Split on a top-level separator, ignoring parentheses, brackets, braces and strings. */
export function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (depth === 0 && value.startsWith(separator, index)) {
      parts.push(value.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map(part => part.trim());
}

/** Find a top-level binary operator (`<=` before `<`), or -1. */
function findTopLevel(value: string, operators: readonly string[]): { index: number; operator: string } | undefined {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (depth !== 0) continue;
    for (const operator of operators) {
      if (!value.startsWith(operator, index)) continue;
      // `<`/`>` must not be the prefix of `<=`/`>=`; the list is ordered.
      if ((operator === "<" || operator === ">") && value[index + 1] === "=") continue;
      if (operator === "=" && (value[index - 1] === "<" || value[index - 1] === ">" || value[index - 1] === "=" || value[index + 1] === "=")) continue;
      return { index, operator };
    }
  }
  return undefined;
}

function isWrappedTuple(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0 && index < value.length - 1) return false;
    }
  }
  return depth === 0;
}

function tupleParts(value: string): string[] | undefined {
  if (!isWrappedTuple(value)) return undefined;
  const inner = value.slice(1, -1);
  const parts = splitTopLevel(inner, ",");
  return parts.length === 2 ? parts : undefined;
}

function symbolsOf(node: MathNode): string[] {
  const found = new Set<string>();
  node.traverse((child, _path, parent) => {
    if (child.type !== "SymbolNode") return;
    const holder = parent as MathNode & { fn?: MathNode };
    if (parent && parent.type === "FunctionNode" && holder.fn === child) return;
    const name = (child as MathNode & { name?: unknown }).name;
    if (typeof name === "string" && !CONSTANTS.has(name) && !VARIABLES.has(name)) found.add(name);
  });
  return [...found];
}

function nodeSymbol(node: MathNode): string | undefined {
  return node.type === "SymbolNode" ? ((node as MathNode & { name?: string }).name ?? undefined) : undefined;
}

/** Evaluate a compiled node and return a finite real number, or undefined. */
export function evaluateValue(compiled: Compiled | undefined, scope: Record<string, unknown> = {}): number | undefined {
  if (!compiled) return undefined;
  try {
    const value = compiled.evaluate(scope) as unknown;
    return realNumber(value);
  } catch { return undefined; }
}

export function realNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object") {
    const candidate = value as { re?: unknown; im?: unknown; valueOf?(): unknown };
    if (typeof candidate.re === "number" && typeof candidate.im === "number") {
      return Math.abs(candidate.im) < 1e-12 && Number.isFinite(candidate.re) ? candidate.re : undefined;
    }
    if (typeof candidate.valueOf === "function") {
      try {
        const plain = candidate.valueOf();
        if (typeof plain === "number" && Number.isFinite(plain)) return plain;
      } catch { /* not a convertible numeric */ }
    }
  }
  return undefined;
}

/** Evaluate a bare numeric expression (used by domains, points and tables). */
function constantValue(source: string): number | undefined {
  try { return realNumber(parse(source).evaluate({})); } catch { return undefined; }
}

function parseDomainPart(part: string): DomainRestriction | string {
  const normalized = normalizeMath(part);
  const chain = /^(.+?)(<=|>=|<|>)(.+?)(<=|>=|<|>)(.+)$/.exec(normalized);
  if (chain) {
    const [, lowText, lowOp, middle, highOp, highText] = chain as unknown as [string, string, string, string, string, string];
    const variable = normalizeMath(middle.trim());
    if (!VARIABLES.has(variable)) return `Domain must compare x, y, t or theta.`;
    const low = constantValue(lowText.trim());
    const high = constantValue(highText.trim());
    if (low === undefined || high === undefined) return "Domain bounds must be numbers.";
    const rising = lowOp !== ">" && highOp !== ">";
    const falling = (lowOp === ">" || lowOp === ">=") && (highOp === ">" || highOp === ">=");
    if (!rising && !falling) return "Domain bounds must point the same way.";
    const min = falling ? high : low;
    const max = falling ? low : high;
    const minInclusive = (falling ? highOp : lowOp).endsWith("=");
    const maxInclusive = (falling ? lowOp : highOp).endsWith("=");
    return {
      variable, text: part, min, max, minInclusive, maxInclusive,
      test: (value: number) => (minInclusive ? value >= min : value > min) && (maxInclusive ? value <= max : value < max),
    };
  }
  const comparison = /^(.+?)(<=|>=|<|>)(.+)$/.exec(normalized);
  if (!comparison) return `Domain must look like {x > 0} or {-1 < x < 2}.`;
  const [, leftText, operator, rightText] = comparison as unknown as [string, string, string, string];
  const left = normalizeMath(leftText.trim());
  const right = normalizeMath(rightText.trim());
  const leftSymbol = VARIABLES.has(left) ? left : undefined;
  const rightSymbol = VARIABLES.has(right) ? right : undefined;
  if (leftSymbol && rightSymbol) return "Domain needs exactly one variable.";
  if (!leftSymbol && !rightSymbol) return "Domain needs x, y, t or theta.";
  const variable = (leftSymbol ?? rightSymbol)!;
  const bound = constantValue(leftSymbol ? right : left);
  if (bound === undefined) return "Domain bound must be a number.";
  const inclusive = operator.endsWith("=");
  // Turn a right-side variable into the equivalent left-side comparison.
  const flip = (token: string) => (token === "<" ? ">" : token === ">" ? "<" : token === "<=" ? ">=" : "<=");
  const effective = rightSymbol ? flip(operator) : operator;
  const test = (value: number) => {
    switch (effective) {
      case "<": return value < bound;
      case "<=": return value <= bound;
      case ">": return value > bound;
      default: return value >= bound;
    }
  };
  const min = effective === ">" || effective === ">=" ? bound : undefined;
  const max = effective === "<" || effective === "<=" ? bound : undefined;
  return {
    variable, text: part, min, max,
    minInclusive: inclusive,
    maxInclusive: inclusive,
    test,
  };
}

function combineDomains(domains: DomainRestriction[]): DomainRestriction | string {
  if (!domains.length) return "no domain";
  const variable = domains[0]!.variable;
  if (domains.some(domain => domain.variable !== variable)) return "Domain restrictions must use one variable.";
  const min = domains.reduce<number | undefined>((current, domain) => domain.min === undefined ? current : Math.max(current ?? -Infinity, domain.min), undefined);
  const max = domains.reduce<number | undefined>((current, domain) => domain.max === undefined ? current : Math.min(current ?? Infinity, domain.max), undefined);
  return {
    variable,
    text: domains.map(domain => domain.text).join(" and "),
    min, max,
    minInclusive: domains.every(domain => domain.min === undefined ? true : domain.minInclusive),
    maxInclusive: domains.every(domain => domain.max === undefined ? true : domain.maxInclusive),
    test: (value: number) => domains.every(domain => domain.test(value)),
  };
}

function parsePoint(xText: string, yText: string): PointSpec | string {
  try {
    return { x: parse(xText).compile(), y: parse(yText).compile(), xText, yText };
  } catch (error) {
    return (error as Error).message;
  }
}

function regressionFamily(source: string): RegressionFamily {
  if (/\bexp\s*\(/.test(source) || /\be\s*\^/.test(source)) return "exponential";
  if (/x\s*\^\s*2/.test(source) || /x\s*\*\s*x/.test(source)) return "quadratic";
  return "linear";
}

function parseRegression(text: string, normalized: string, sliders: string[]): ParsedExpression {
  const split = findTopLevel(normalized, ["~"]);
  if (!split) return failure(text, normalized, "Use y ~ a x + b for a regression.");
  const lhs = normalized.slice(0, split.index).trim();
  const rhs = normalized.slice(split.index + 1).trim();
  if (lhs !== "y") return failure(text, normalized, "Regression must fit y.");
  let node: MathNode;
  try { node = parse(rhs); } catch (error) { return failure(text, normalized, (error as Error).message); }
  const free = symbolsOf(node);
  if (!free.length) return failure(text, normalized, "Regression needs at least one parameter, e.g. a and b.");
  return {
    text, kind: "regression", sliders: [...new Set([...sliders, ...free])],
    compiled: node.compile(), regression: { rhs: node.compile(), family: regressionFamily(rhs) },
    display: `y ~ ${rhs}`,
  };
}

function failure(text: string, normalized: string, message: string, extras: Partial<ParsedExpression> = {}): ParsedExpression {
  return { text, kind: "empty", error: message.replace(/\s+/g, " ").trim() || "Could not read this expression.", sliders: [], display: normalized, ...extras };
}

/**
 * Parse one row. Supports:
 *  y=f(x), bare f(x), x=g(y), r=f(theta), (x(t),y(t)), points/lists,
 *  F(x,y)=G(x,y), inequalities, a=3, f(x)=..., tables and `y ~ ...`.
 */
export function parseExpression(input: string): ParsedExpression {
  const text = input;
  try {
    const normalized = normalizeMath(input);
    if (!normalized) return { text, kind: "empty", sliders: [], display: "", error: "Enter an expression." };

    // Domain / parameter-range suffixes: {x>0}, {-1<x<2}, {0<=t<=2pi}.
    const domains: DomainRestriction[] = [];
    let working = normalized;
    for (;;) {
      const match = /\s*\{([^{}]*)\}\s*$/.exec(working);
      if (!match) break;
      const parsed = parseDomainPart(match[1]!);
      if (typeof parsed === "string") return failure(text, normalized, parsed);
      domains.unshift(parsed);
      working = working.slice(0, match.index).trim();
    }
    if (!working) return failure(text, normalized, "Enter an expression.");
    let domain: DomainRestriction | undefined;
    if (domains.length) {
      const combined = combineDomains(domains);
      if (typeof combined === "string") return failure(text, normalized, combined);
      domain = combined;
    }

    // Table: a matrix literal [[x, y], ...] supplies x/y data for regression.
    if (working.startsWith("[")) {
      let values: unknown;
      try {
        const evaluated = parse(working).evaluate({}) as unknown;
        const matrix = evaluated as { isMatrix?: boolean; toArray?: () => unknown };
        values = matrix?.isMatrix && typeof matrix.toArray === "function" ? matrix.toArray() : evaluated;
      } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
      if (!Array.isArray(values) || !values.every(row => Array.isArray(row) && row.length === 2)) {
        return failure(text, normalized, "A table needs rows of two numbers: [[1, 2], [3, 4]].", { domain });
      }
      const points: PointSpec[] = [];
      for (const row of values as unknown[][]) {
        const x = realNumber(row[0]);
        const y = realNumber(row[1]);
        if (x === undefined || y === undefined) return failure(text, normalized, "Table values must be real numbers.", { domain });
        points.push({ x: parse(String(x)).compile(), y: parse(String(y)).compile(), xText: String(x), yText: String(y) });
      }
      return { text, kind: "table", sliders: [], points, display: "table", domain };
    }

    // Point lists and parametric tuples.
    const chunks = splitTopLevel(working, ",");
    const tuples = chunks.map(tupleParts);
    if (tuples.length && tuples.every((tuple): tuple is string[] => !!tuple)) {
      const points: PointSpec[] = [];
      let parametric = false;
      for (const tuple of tuples) {
        const [xText, yText] = tuple as [string, string];
        const point = parsePoint(xText, yText);
        if (typeof point === "string") return failure(text, normalized, point, { domain });
        points.push(point);
        let hasT = false;
        try {
          hasT = /\bt\b/.test(xText) || /\bt\b/.test(yText);
        } catch { hasT = false; }
        if (hasT) parametric = true;
      }
      if (parametric) {
        if (points.length !== 1) return failure(text, normalized, "A parametric curve is one (x(t), y(t)) pair.", { domain });
        const point = points[0]!;
        const range: [number, number] = domain?.variable === "t" && domain.min !== undefined && domain.max !== undefined
          ? [domain.min, domain.max] : [0, 2 * Math.PI];
        return {
          text, kind: "parametric", sliders: [...new Set([...symbolsOf(parse(point.xText)), ...symbolsOf(parse(point.yText))])],
          compiled: point.x, secondary: point.y, domain, paramRange: range,
          display: `(${point.xText}, ${point.yText})`,
        };
      }
      return {
        text, kind: points.length === 1 ? "point" : "points",
        sliders: [...new Set(points.flatMap(point => [...symbolsOf(parse(point.xText)), ...symbolsOf(parse(point.yText))]))],
        points, domain, display: points.length === 1 ? `(${points[0]!.xText}, ${points[0]!.yText})` : `${points.length} points`,
      };
    }

    // Regression rows.
    if (findTopLevel(working, ["~"])) return parseRegression(text, working, []);

    // Function definition f(x)=...
    const equality = findTopLevel(working, ["="]);
    if (equality) {
      const left = working.slice(0, equality.index).trim();
      const right = working.slice(equality.index + 1).trim();
      if (!left || !right) return failure(text, normalized, "Both sides of = are required.", { domain });
      const definition = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)$/.exec(left);
      if (definition) {
        let node: MathNode;
        try { node = parse(`${left}=${right}`); } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
        if (node.type !== "FunctionAssignmentNode") return failure(text, normalized, "Use f(x) = ... to define a function.", { domain });
        const name = (node as MathNode & { name?: string }).name ?? definition[1]!;
        const params = ((node as MathNode & { params?: string[] }).params ?? []).filter(param => typeof param === "string");
        const body = (node as MathNode & { expr?: MathNode }).expr;
        if (!body) return failure(text, normalized, "Function body is missing.", { domain });
        return {
          text, kind: "function", sliders: symbolsOf(body).filter(symbol => !params.includes(symbol)),
          functionDef: { name, params }, compiled: body.compile(), domain, display: `${name}(${params.join(", ")}) = ${right}`,
        };
      }

      let leftNode: MathNode | undefined;
      let rightNode: MathNode | undefined;
      try { leftNode = parse(left); } catch { leftNode = undefined; }
      try { rightNode = parse(right); } catch { rightNode = undefined; }
      const leftName = leftNode ? nodeSymbol(leftNode) : undefined;
      const rightSymbols = rightNode ? symbolsOf(rightNode) : [];

      // Slider definition: a = 3
      if (leftName && !VARIABLES.has(leftName) && leftName !== "y") {
        const value = constantValue(right);
        if (value === undefined) return failure(text, normalized, "A slider needs a number, e.g. a = 3.", { domain });
        return {
          text, kind: "slider", sliders: [], sliderDef: { name: leftName, value },
          compiled: rightNode?.compile(), domain, display: `${leftName} = ${right}`,
        };
      }

      // y = f(x)
      if (leftName === "y") {
        const rhsSliders = rightNode ? symbolsOf(rightNode) : [];
        if (rightSymbols.includes("y")) {
          // y appears on both sides: treat as an implicit relation.
          try {
            const diff = parse(`(${right})-(${left})`).compile();
            return { text, kind: "implicit", sliders: [...new Set([...rhsSliders])], compiled: diff, op: "=", domain, display: normalized };
          } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
        }
        if (!rightNode) return failure(text, normalized, "The right side is not a valid expression.", { domain });
        return {
          text, kind: "explicit", sliders: rhsSliders, compiled: rightNode.compile(), domain,
          display: `y = ${right}`,
        };
      }

      // x = g(y)
      if (leftName === "x") {
        const rhsSliders = rightNode ? symbolsOf(rightNode) : [];
        if (rightSymbols.includes("x")) {
          try {
            const diff = parse(`(${right})-(${left})`).compile();
            return { text, kind: "implicit", sliders: [...new Set([...rhsSliders])], compiled: diff, op: "=", domain, display: normalized };
          } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
        }
        if (!rightNode) return failure(text, normalized, "The right side is not a valid expression.", { domain });
        return { text, kind: "explicitY", sliders: rhsSliders, compiled: rightNode.compile(), domain, display: `x = ${right}` };
      }

      // r = f(theta)   (polar; 2 is a circle of radius 2)
      if (leftName === "r") {
        if (!rightNode) return failure(text, normalized, "The polar radius is not a valid expression.", { domain });
        return {
          text, kind: "polar", sliders: symbolsOf(rightNode), compiled: rightNode.compile(), domain,
          display: `r = ${right}`,
        };
      }

      // Generic implicit F(x,y) = G(x,y).
      if (!leftNode || !rightNode) return failure(text, normalized, "Both sides must be valid expressions.", { domain });
      try {
        const diff = parse(`(${left})-(${right})`).compile();
        return {
          text, kind: "implicit", sliders: [...new Set([...symbolsOf(leftNode), ...symbolsOf(rightNode)])],
          compiled: diff, op: "=", domain, display: `${left} = ${right}`,
        };
      } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
    }

    // Inequality: y > f(x), x^2 + y^2 <= 1, ...
    const comparison = findTopLevel(working, ["<=", ">=", "<", ">"]);
    if (comparison) {
      const left = working.slice(0, comparison.index).trim();
      const right = working.slice(comparison.index + comparison.operator.length).trim();
      if (!left || !right) return failure(text, normalized, "Both sides of the inequality are required.", { domain });
      let node: MathNode;
      try { node = parse(`(${left})-(${right})`); } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
      return {
        text, kind: "inequality", sliders: symbolsOf(node), compiled: node.compile(),
        op: comparison.operator as ComparisonOp, domain, display: `${left} ${comparison.operator} ${right}`,
      };
    }

    // Bare expression = y = ...
    let node: MathNode;
    try { node = parse(working); } catch (error) { return failure(text, normalized, (error as Error).message, { domain }); }
    return {
      text, kind: "explicit", sliders: symbolsOf(node), compiled: node.compile(), domain,
      display: `y = ${working}`,
    };
  } catch (error) {
    return { text, kind: "empty", sliders: [], display: text, error: ((error as Error).message || "Could not read this expression.").split("\n")[0]! };
  }
}

/** All rows parsed; convenience for tests and the view. */
export function parseExpressions(texts: string[]): ParsedExpression[] {
  return texts.map(parseExpression);
}

/** Names defined as functions or sliders by the parsed rows. */
export function definedNames(rows: ParsedExpression[]): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    if (row.functionDef) names.add(row.functionDef.name);
    if (row.sliderDef) names.add(row.sliderDef.name);
  }
  return names;
}

/**
 * Find every free letter that is not a variable, constant or defined name and
 * give it a slider. Definitions keep their value when first created; the
 * stored slider otherwise wins so dragging/typing is never overwritten.
 */
export function collectSliders(rows: ParsedExpression[], existing: Record<string, SliderSpec> = {}): Record<string, SliderSpec> {
  const defined = definedNames(rows);
  const sliders: Record<string, SliderSpec> = { ...existing };
  const definitions = new Map<string, number>();
  for (const row of rows) if (row.sliderDef) definitions.set(row.sliderDef.name, row.sliderDef.value);
  for (const row of rows) {
    for (const name of row.sliders) {
      if (defined.has(name)) continue;
      if (!sliders[name]) sliders[name] = { ...DEFAULT_SLIDER, value: definitions.get(name) ?? DEFAULT_SLIDER.value };
    }
  }
  for (const [name, value] of definitions) {
    const spec = sliders[name];
    sliders[name] = spec ? { ...spec, value: spec.value } : { ...DEFAULT_SLIDER, value };
  }
  // A deleted definition should not leave an orphan slider.
  for (const name of Object.keys(sliders)) {
    if (defined.has(name) && definitions.has(name)) continue;
    const used = rows.some(row => row.sliders.includes(name));
    if (!used && !definitions.has(name)) delete sliders[name];
  }
  return sliders;
}

/**
 * Build the evaluation scope: slider values plus user functions (which close
 * over the same scope so they can call each other). Recursion is cut off.
 */
export function buildScope(rows: ParsedExpression[], sliders: Record<string, SliderSpec> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const scope: Record<string, unknown> = { ...extra };
  for (const [name, spec] of Object.entries(sliders)) scope[name] = spec.value;
  let depth = 0;
  for (const row of rows) {
    if (row.error || !row.compiled) continue;
    if (row.functionDef) {
      const { name, params } = row.functionDef;
      const body = row.compiled;
      scope[name] = (...args: unknown[]) => {
        if (depth > 32) return Number.NaN;
        depth += 1;
        try {
          const local: Record<string, unknown> = { ...scope };
          params.forEach((param, index) => { local[param] = args[index]; });
          return evaluateValue(body, local) ?? Number.NaN;
        } finally { depth -= 1; }
      };
    }
  }
  return scope;
}

/** Build a 1-D function from a row where `kind` is explicit/polar/parametric-x. */
export function curveFunction(row: ParsedExpression, scope: Record<string, unknown>, variable: "x" | "y" | "theta" | "t"): ((value: number) => number) | undefined {
  if (!row.compiled || row.error) return undefined;
  const compiled = row.compiled;
  return (value: number) => evaluateValue(compiled, { ...scope, [variable]: value }) ?? Number.NaN;
}

/** Short human label for a row (used in the legend and error cards). */
export function describeExpression(row: ParsedExpression): string {
  if (row.error) return row.error;
  return row.display || row.text;
}

/** True when the row should be drawn as a fill rather than a line. */
export function isRegion(row: ParsedExpression): boolean {
  return row.kind === "inequality" && !row.error;
}

/** Test the inequality/equality at a world point (used by masks). */
export function testRelation(row: ParsedExpression, scope: Record<string, unknown>, x: number, y: number): boolean {
  if (!row.compiled || row.error) return false;
  const value = evaluateValue(row.compiled, { ...scope, x, y });
  if (value === undefined) return false;
  switch (row.op) {
    case "<": return value < 0;
    case "<=": return value <= 0;
    case ">": return value > 0;
    case ">=": return value >= 0;
    case "=": return Math.abs(value) < 1e-9;
    default: return false;
  }
}

/** Test a domain restriction against the row's own parameter. */
export function domainAllows(row: ParsedExpression, variable: string, value: number): boolean {
  if (!row.domain) return true;
  if (row.domain.variable !== variable) return true;
  return row.domain.test(value);
}

/** Factor helper shared with the states/UI when composing labels. */
export { factor as factorize };
