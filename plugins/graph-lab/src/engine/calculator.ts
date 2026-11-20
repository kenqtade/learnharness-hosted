// TRACK A — the embeddable calculator. Exam Prep imports THIS signature; keep it stable.
import { evaluate } from "mathjs";
import { buildScope, collectSliders, parseExpression, type SliderSpec } from "./expressions.ts";
import { sampleRow } from "./sample.ts";
import { makeViewport, panView, zoomView, type ViewRect } from "./viewport.ts";
import { CURVE_COLORS, GraphCanvas, readPalette, type SceneCurve } from "./render.ts";
import { det, eigen, formatMatrix, inverse, rref, transpose, multiply, solve, type Matrix } from "./matrix.ts";
import { formatComplex } from "./complex.ts";

export type CalculatorKind = "graphing" | "scientific" | "four-function" | "matrix";
export interface CalculatorOptions {
  kind: CalculatorKind;
  /** Theme follows host CSS variables; size follows the container. */
  signal?: AbortSignal;
  /** Optional initial state for the graphing calculator. */
  initialExpressions?: string[];
  /** Degree mode for the scientific calculator (default: radians). */
  degrees?: boolean;
  /** Show a compact trace readout (default: true). */
  trace?: boolean;
}
export interface CalculatorHandle {
  dispose(): void;
  /** Optional: replace the graphing calculator's expressions. */
  setExpressions?(expressions: string[]): void;
}

type Cleanup = () => void;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, properties: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, properties);
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, onClick: () => void, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const node = element("button", { type: "button", textContent: label, ...extra });
  node.addEventListener("click", onClick);
  return node;
}

function root(container: HTMLElement, kind: string): { shell: HTMLElement; cleanup: Cleanup } {
  const shell = element("div", { className: `graph-lab-calc graph-lab-calc--${kind}` });
  container.replaceChildren(shell);
  return { shell, cleanup: () => { container.replaceChildren(); } };
}

export function mountCalculator(container: HTMLElement, options: CalculatorOptions): CalculatorHandle {
  container.classList.add("graph-lab-calc-host");
  const controller = new AbortController();
  const cleanups: Cleanup[] = [];
  if (options.signal) {
    if (options.signal.aborted) { container.replaceChildren(); return { dispose: () => container.replaceChildren() }; }
    options.signal.addEventListener("abort", () => dispose(), { once: true });
  }
  let disposed = false;
  let setExpressions: ((expressions: string[]) => void) | undefined;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const cleanup of cleanups.splice(0)) cleanup();
    container.replaceChildren();
  }
  try {
    switch (options.kind) {
      case "graphing": setExpressions = mountGraphing(container, options, controller.signal, cleanups); break;
      case "scientific": mountScientific(container, options, controller.signal, cleanups); break;
      case "four-function": mountFourFunction(container, controller.signal, cleanups); break;
      case "matrix": mountMatrix(container, controller.signal, cleanups); break;
    }
  } catch (error) {
    container.replaceChildren(element("p", { className: "graph-lab-error", role: "alert", textContent: `Calculator failed: ${(error as Error).message}` }));
  }
  return { dispose, ...(setExpressions ? { setExpressions } : {}) };
}

/* ------------------------------- graphing -------------------------------- */

function mountGraphing(container: HTMLElement, options: CalculatorOptions, signal: AbortSignal, cleanups: Cleanup[]): (expressions: string[]) => void {
  const { shell, cleanup } = root(container, "graphing");
  cleanups.push(cleanup);
  let texts = options.initialExpressions?.length ? [...options.initialExpressions] : ["y = x^2"];
  let view: ViewRect = { x: [-6, 6], y: [-4, 4] };
  const rowsHost = element("div", { className: "graph-lab-calc-rows" });
  const sliderHost = element("div", { className: "graph-lab-calc-sliders" });
  const canvas = element("canvas", { className: "graph-lab-calc-canvas" });
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Graphing calculator canvas");
  const trace = element("div", { className: "graph-lab-calc-trace", textContent: "Drag to pan · scroll to zoom" });
  const graph = new GraphCanvas(canvas);
  let sliders: Record<string, SliderSpec> = {};
  let traceEnabled = options.trace !== false;

  function rebuildRows(): void {
    rowsHost.replaceChildren();
    texts.forEach((text, index) => {
      const row = element("div", { className: "graph-lab-calc-row" });
      const dot = element("span", { className: "graph-lab-dot" });
      dot.style.background = CURVE_COLORS[index % CURVE_COLORS.length]!;
      const input = element("input", {
        type: "text", value: text, className: "graph-lab-input",
        spellcheck: false, autocapitalize: "off", autocomplete: "off",
      });
      input.setAttribute("aria-label", `Expression ${index + 1}`);
      input.addEventListener("input", () => { texts[index] = input.value; draw(); });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); addRow(); }
      });
      const remove = button("×", () => {
        texts.splice(index, 1);
        if (!texts.length) texts.push("");
        rebuildRows(); draw();
      }, { className: "graph-lab-icon-button", title: "Remove row" });
      remove.setAttribute("aria-label", `Remove expression ${index + 1}`);
      row.append(dot, input, remove);
      rowsHost.append(row);
    });
  }

  function addRow(): void {
    texts.push("");
    rebuildRows();
    const inputs = rowsHost.querySelectorAll("input");
    inputs[inputs.length - 1]?.focus();
  }

  function rebuildSliders(parsed: ReturnType<typeof parseExpression>[]): void {
    const next = collectSliders(parsed, sliders);
    const names = Object.keys(next);
    const current = [...sliderHost.querySelectorAll<HTMLElement>("[data-slider]")].map(node => node.dataset.slider ?? "");
    const changed = names.length !== current.length || names.some((name, index) => current[index] !== name);
    sliders = next;
    if (!changed) return;
    sliderHost.replaceChildren();
    for (const name of names) {
      const spec = sliders[name]!;
      const row = element("label", { className: "graph-lab-calc-slider" });
      row.dataset.slider = name;
      const label = element("span", { textContent: `${name} = ${Number(spec.value.toFixed(3))}` });
      const input = element("input", { type: "range", min: String(spec.min), max: String(spec.max), step: String(spec.step), value: String(spec.value) });
      input.setAttribute("aria-label", `Slider ${name}`);
      input.addEventListener("input", () => {
        spec.value = Number(input.value);
        label.textContent = `${name} = ${Number(spec.value.toFixed(3))}`;
        draw();
      });
      row.append(label, input);
      sliderHost.append(row);
    }
  }

  function draw(): void {
    if (signal.aborted) return;
    const size = graph.resize();
    const palette = readPalette(container);
    const parsed = texts.map(parseExpression);
    rebuildSliders(parsed);
    const scope = buildScope(parsed, sliders);
    const curves: SceneCurve[] = [];
    parsed.forEach((row, index) => {
      if (row.error) return;
      const sampled = sampleRow(row, scope, view, size.width, size.height);
      if (sampled.segments.length || sampled.mask) {
        curves.push({ id: `row-${index}`, color: CURVE_COLORS[index % CURVE_COLORS.length]!, segments: sampled.segments, mask: sampled.mask });
      }
    });
    graph.draw(view, { curves, showGrid: true }, palette);
    const errors = parsed.map(row => row.error).filter((message): message is string => !!message);
    if (errors.length) trace.textContent = errors[0]!;
    else if (!traceEnabled) trace.textContent = "Drag to pan · scroll to zoom";
  }

  rebuildRows();
  shell.append(
    element("div", { className: "graph-lab-calc-title", textContent: "Graphing calculator" }),
    rowsHost,
    sliderHost,
    element("div", { className: "graph-lab-calc-actions" }, [
      button("+ Row", addRow, { className: "graph-lab-small-button" }),
      button("+", () => { view = zoomView(view, 1.25, { x: graph.width / 2, y: graph.height / 2 }, graph); draw(); }, { className: "graph-lab-small-button", title: "Zoom in" }),
      button("−", () => { view = zoomView(view, 0.8, { x: graph.width / 2, y: graph.height / 2 }, graph); draw(); }, { className: "graph-lab-small-button", title: "Zoom out" }),
      button("Reset", () => { view = { x: [-6, 6], y: [-4, 4] }; draw(); }, { className: "graph-lab-small-button" }),
    ]),
    canvas,
    trace,
  );

  let drag: { x: number; y: number } | undefined;
  canvas.addEventListener("pointerdown", event => {
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (drag) {
      view = panView(view, event.clientX - drag.x, event.clientY - drag.y, graph);
      drag = { x: event.clientX, y: event.clientY };
      draw();
      return;
    }
    if (!traceEnabled) return;
    const rect = canvas.getBoundingClientRect();
    const world = { x: 0, y: 0 };
    const viewport = graph.viewport(view);
    world.x = viewport.view.x[0] + ((event.clientX - rect.left) / Math.max(1, rect.width)) * (viewport.view.x[1] - viewport.view.x[0]);
    world.y = viewport.view.y[1] - ((event.clientY - rect.top) / Math.max(1, rect.height)) * (viewport.view.y[1] - viewport.view.y[0]);
    trace.textContent = `(${world.x.toFixed(2)}, ${world.y.toFixed(2)})`;
  });
  const stopDrag = () => { drag = undefined; };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    view = zoomView(view, event.deltaY < 0 ? 1.15 : 0.87, { x: event.clientX - rect.left, y: event.clientY - rect.top }, graph);
    draw();
  }, { passive: false });

  const observer = new ResizeObserver(() => draw());
  observer.observe(canvas);
  cleanups.push(() => observer.disconnect());
  // Paint after layout so clientWidth/clientHeight are real.
  queueMicrotask(() => { draw(); });
  setTimeout(() => draw(), 0);

  return (expressions: string[]) => {
    texts = expressions.length ? [...expressions] : [""];
    rebuildRows(); draw();
  };
}

/* ------------------------------ scientific ------------------------------- */

function formatResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? "Error" : value > 0 ? "∞" : "−∞";
    return String(Number(value.toPrecision(12)));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  const candidate = value as { re?: unknown; im?: unknown; toString(): string; isMatrix?: boolean; toArray?: () => unknown };
  if (typeof candidate.re === "number" && typeof candidate.im === "number") return formatComplex({ re: candidate.re, im: candidate.im });
  if (candidate.isMatrix && candidate.toArray) {
    const array = candidate.toArray() as unknown[];
    if (Array.isArray(array) && array.every(row => Array.isArray(row))) return formatMatrix(array as Matrix);
  }
  try { return candidate.toString(); } catch { return String(value); }
}

function degreeScope(degrees: boolean): Record<string, unknown> {
  if (!degrees) return {};
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const toDegrees = (value: number) => (value * 180) / Math.PI;
  return {
    sin: (value: number) => Math.sin(toRadians(value)),
    cos: (value: number) => Math.cos(toRadians(value)),
    tan: (value: number) => Math.tan(toRadians(value)),
    asin: (value: number) => toDegrees(Math.asin(value)),
    acos: (value: number) => toDegrees(Math.acos(value)),
    atan: (value: number) => toDegrees(Math.atan(value)),
    atan2: (y: number, x: number) => toDegrees(Math.atan2(y, x)),
  };
}

function mountScientific(container: HTMLElement, options: CalculatorOptions, signal: AbortSignal, cleanups: Cleanup[]): void {
  const { shell, cleanup } = root(container, "scientific");
  cleanups.push(cleanup);
  let degrees = options.degrees ?? false;
  let ans = 0;
  let history: { expression: string; result: string }[] = [];
  const display = element("input", { className: "graph-lab-calc-display", type: "text", value: "", placeholder: "0", spellcheck: false, autocomplete: "off" });
  display.setAttribute("aria-label", "Scientific calculator expression");
  const resultLine = element("div", { className: "graph-lab-calc-result", textContent: "0" });
  resultLine.setAttribute("aria-live", "polite");
  const historyHost = element("ol", { className: "graph-lab-calc-history" });
  const modeButton = button(degrees ? "DEG" : "RAD", () => {
    degrees = !degrees;
    modeButton.textContent = degrees ? "DEG" : "RAD";
    modeButton.setAttribute("aria-pressed", String(degrees));
    evaluateDisplay();
  }, { className: "graph-lab-small-button", title: "Angle unit" });
  modeButton.setAttribute("aria-pressed", String(degrees));

  const insert = (text: string) => {
    const start = display.selectionStart ?? display.value.length;
    const end = display.selectionEnd ?? start;
    display.value = display.value.slice(0, start) + text + display.value.slice(end);
    const caret = start + text.length;
    display.setSelectionRange(caret, caret);
    display.focus();
  };

  function evaluateDisplay(): void {
    const expression = display.value.trim();
    if (!expression) { resultLine.textContent = "0"; return; }
    try {
      const value = evaluate(expression, { ...degreeScope(degrees), Ans: ans } as Record<string, unknown>);
      const text = formatResult(value);
      resultLine.textContent = text;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) ans = numeric;
      history = [{ expression, result: text }, ...history].slice(0, 20);
      rebuildHistory();
    } catch (error) {
      resultLine.textContent = (error as Error).message.split("\n")[0]!.slice(0, 120);
    }
  }

  function rebuildHistory(): void {
    historyHost.replaceChildren();
    for (const entry of history) {
      const item = element("li", {});
      const select = button(`${entry.expression} = ${entry.result}`, () => { display.value = entry.expression; display.focus(); }, { className: "graph-lab-history-entry" });
      item.append(select);
      historyHost.append(item);
    }
  }

  const keys: { label: string; run: () => void; wide?: boolean; kind?: string }[] = [
    { label: "7", run: () => insert("7") }, { label: "8", run: () => insert("8") }, { label: "9", run: () => insert("9") }, { label: "÷", run: () => insert("/") },
    { label: "4", run: () => insert("4") }, { label: "5", run: () => insert("5") }, { label: "6", run: () => insert("6") }, { label: "×", run: () => insert("*") },
    { label: "1", run: () => insert("1") }, { label: "2", run: () => insert("2") }, { label: "3", run: () => insert("3") }, { label: "−", run: () => insert("-") },
    { label: "0", run: () => insert("0") }, { label: ".", run: () => insert(".") }, { label: "=", run: evaluateDisplay }, { label: "+", run: () => insert("+") },
    { label: "(", run: () => insert("(") }, { label: ")", run: () => insert(")") }, { label: "^", run: () => insert("^") }, { label: "√", run: () => insert("sqrt(") },
    { label: "x²", run: () => insert("^2") }, { label: "sin", run: () => insert("sin(") }, { label: "cos", run: () => insert("cos(") }, { label: "tan", run: () => insert("tan(") },
    { label: "sin⁻¹", run: () => insert("asin(") }, { label: "cos⁻¹", run: () => insert("acos(") }, { label: "tan⁻¹", run: () => insert("atan(") }, { label: "ln", run: () => insert("log(") },
    { label: "log", run: () => insert("log10(") }, { label: "π", run: () => insert("pi") }, { label: "e", run: () => insert("e") }, { label: "Ans", run: () => insert("Ans") },
    { label: "AC", run: () => { display.value = ""; resultLine.textContent = "0"; display.focus(); } }, { label: "←", run: () => { display.value = display.value.slice(0, -1); display.focus(); } }, { label: "±", run: () => insert("-") }, { label: "!", run: () => insert("!") },
  ];
  const keypad = element("div", { className: "graph-lab-calc-keypad" });
  for (const key of keys) {
    const node = button(key.label, key.run, { className: `graph-lab-key${key.label === "=" ? " graph-lab-key--accent" : ""}` });
    keypad.append(node);
  }

  display.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); evaluateDisplay(); }
    if (event.key === "Escape") { event.preventDefault(); display.value = ""; resultLine.textContent = "0"; }
  });
  shell.append(
    element("div", { className: "graph-lab-calc-display-wrap" }, [display, resultLine]),
    element("div", { className: "graph-lab-calc-actions" }, [modeButton]),
    keypad,
    element("div", { className: "graph-lab-calc-history-title", textContent: "History" }),
    historyHost,
  );
  signal.addEventListener("abort", () => display.blur(), { once: true });
  display.focus();
}

/* ----------------------------- four-function ----------------------------- */

function mountFourFunction(container: HTMLElement, signal: AbortSignal, cleanups: Cleanup[]): void {
  const { shell, cleanup } = root(container, "four-function");
  cleanups.push(cleanup);
  let current = "0";
  let accumulator = 0;
  let pending: string | null = null;
  let fresh = true;
  let memory = 0;
  const display = element("div", { className: "graph-lab-calc-display", role: "status", textContent: "0" });
  display.setAttribute("aria-live", "polite");
  const memoryLine = element("div", { className: "graph-lab-calc-memory", textContent: "M 0" });
  shell.tabIndex = 0;
  const paint = () => { display.textContent = current; memoryLine.textContent = `M ${Number(memory.toPrecision(8))}`; };

  const apply = (a: number, b: number, operator: string): number => {
    switch (operator) {
      case "+": return a + b;
      case "−": return a - b;
      case "×": return a * b;
      case "÷": return b === 0 ? Number.NaN : a / b;
      case "%": return (a * b) / 100;
      default: return b;
    }
  };

  function enterDigit(digit: string): void {
    if (fresh) { current = digit === "." ? "0." : digit; fresh = false; }
    else if (digit === "." && current.includes(".")) return;
    else current = current === "0" && digit !== "." ? digit : current + digit;
    paint();
  }

  function press(operator: string): void {
    const value = Number(current);
    if (pending) accumulator = apply(accumulator, value, pending);
    else accumulator = value;
    pending = operator;
    current = String(Number(accumulator.toPrecision(12)));
    fresh = true;
    paint();
  }

  function equals(): void {
    if (!pending) { accumulator = Number(current); return; }
    accumulator = apply(accumulator, Number(current), pending);
    pending = null;
    current = String(Number(accumulator.toPrecision(12)));
    fresh = true;
    paint();
  }

  function keyboard(key: string): boolean {
    if (/^[0-9.]$/.test(key)) { enterDigit(key); return true; }
    if (key === "+") { press("+"); return true; }
    if (key === "-") { press("−"); return true; }
    if (key === "*" || key === "x") { press("×"); return true; }
    if (key === "/") { press("÷"); return true; }
    if (key === "%") { press("%"); return true; }
    if (key === "Enter" || key === "=") { equals(); return true; }
    if (key === "Escape" || key === "c" || key === "C") { current = "0"; accumulator = 0; pending = null; fresh = true; paint(); return true; }
    if (key === "Backspace") { current = current.length > 1 ? current.slice(0, -1) : "0"; paint(); return true; }
    return false;
  }

  const keypad = element("div", { className: "graph-lab-calc-keypad graph-lab-calc-keypad--four" });
  const keys: { label: string; run: () => void }[] = [];
  for (const label of ["MC", "MR", "M+", "M−"]) keys.push({
    label,
    run: () => {
      if (label === "MC") memory = 0;
      if (label === "MR") { current = String(memory); fresh = true; }
      if (label === "M+") memory += Number(current);
      if (label === "M−") memory -= Number(current);
      paint();
    },
  });
  for (const label of ["C", "CE", "√", "÷"]) keys.push({
    label,
    run: () => {
      if (label === "C") { current = "0"; accumulator = 0; pending = null; fresh = true; }
      if (label === "CE") { current = "0"; fresh = true; }
      if (label === "√") { current = String(Number(Math.sqrt(Number(current)).toPrecision(12))); fresh = true; }
      if (label === "÷") press("÷");
      paint();
    },
  });
  for (const label of ["7", "8", "9", "×"]) keys.push({ label, run: () => (label === "×" ? press("×") : enterDigit(label)) });
  for (const label of ["4", "5", "6", "−"]) keys.push({ label, run: () => (label === "−" ? press("−") : enterDigit(label)) });
  for (const label of ["1", "2", "3", "+"]) keys.push({ label, run: () => (label === "+" ? press("+") : enterDigit(label)) });
  keys.push({ label: "±", run: () => { current = current.startsWith("-") ? current.slice(1) : `-${current}`; paint(); } });
  keys.push({ label: "0", run: () => enterDigit("0") });
  keys.push({ label: ".", run: () => enterDigit(".") });
  keys.push({ label: "=", run: equals });
  for (const key of keys) keypad.append(button(key.label, key.run, { className: `graph-lab-key${key.label === "=" ? " graph-lab-key--accent" : ""}` }));

  const onKey = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (keyboard(event.key)) event.preventDefault();
  };
  container.addEventListener("keydown", onKey);
  cleanups.push(() => container.removeEventListener("keydown", onKey));
  container.addEventListener("pointerdown", () => shell.focus(), { once: false });
  signal.addEventListener("abort", () => shell.blur(), { once: true });
  shell.append(display, memoryLine, keypad, element("div", { className: "graph-lab-calc-hint", textContent: "Type digits and + − * /, Enter to evaluate, C to clear." }));
  paint();
}

/* -------------------------------- matrix --------------------------------- */

function mountMatrix(container: HTMLElement, signal: AbortSignal, cleanups: Cleanup[]): void {
  const { shell, cleanup } = root(container, "matrix");
  cleanups.push(cleanup);
  let size = 2;
  let sizeB = 2;
  const valuesA: number[][] = [[2, 0], [0, 3]];
  const valuesB: number[][] = [[1, 0], [0, 1]];
  const gridA = element("div", { className: "graph-lab-matrix-grid" });
  const gridB = element("div", { className: "graph-lab-matrix-grid" });
  const result = element("pre", { className: "graph-lab-matrix-result", textContent: "Choose an operation." });

  function resizeValues(values: number[][], next: number): void {
    for (let row = 0; row < next; row += 1) {
      values[row] ??= [];
      for (let column = 0; column < next; column += 1) {
        values[row]![column] ??= row === column ? 1 : 0;
      }
      values[row]!.length = next;
    }
    values.length = next;
  }

  function renderGrid(host: HTMLElement, values: number[][], count: number, label: string): void {
    host.replaceChildren();
    host.style.gridTemplateColumns = `repeat(${count}, 3.6rem)`;
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        const input = element("input", { type: "number", value: String(values[row]?.[column] ?? 0), className: "graph-lab-matrix-cell", inputMode: "decimal" });
        input.setAttribute("aria-label", `${label} row ${row + 1} column ${column + 1}`);
        input.addEventListener("input", () => {
          const parsed = Number(input.value);
          values[row]![column] = Number.isFinite(parsed) ? parsed : 0;
        });
        host.append(input);
      }
    }
  }

  const sizeSelect = element("select", { className: "graph-lab-select" });
  for (const count of [2, 3, 4]) sizeSelect.append(element("option", { value: String(count), textContent: `${count} × ${count}` }));
  sizeSelect.setAttribute("aria-label", "Matrix A size");
  sizeSelect.addEventListener("change", () => { size = Number(sizeSelect.value); resizeValues(valuesA, size); renderGrid(gridA, valuesA, size, "A"); });

  const sizeSelectB = element("select", { className: "graph-lab-select" });
  for (const count of [2, 3, 4]) sizeSelectB.append(element("option", { value: String(count), textContent: `${count} × ${count}` }));
  sizeSelectB.setAttribute("aria-label", "Matrix B size");
  sizeSelectB.addEventListener("change", () => { sizeB = Number(sizeSelectB.value); resizeValues(valuesB, sizeB); renderGrid(gridB, valuesB, sizeB, "B"); });

  const show = (label: string, value: unknown) => {
    result.textContent = `${label}\n${typeof value === "string" ? value : formatResult(value)}`;
  };
  const matrixA = (): Matrix => valuesA.slice(0, size).map(row => row.slice(0, size));
  const matrixB = (): Matrix => valuesB.slice(0, sizeB).map(row => row.slice(0, sizeB));

  const operations: { label: string; run: () => void }[] = [
    { label: "det A", run: () => show("det A", Number(det(matrixA()).toPrecision(10))) },
    { label: "A⁻¹", run: () => { const value = inverse(matrixA()); show("A⁻¹", value ? formatMatrix(value) : "singular — no inverse"); } },
    { label: "Aᵀ", run: () => show("Aᵀ", formatMatrix(transpose(matrixA()))) },
    { label: "A×B", run: () => { try { show("A × B", formatMatrix(multiply(matrixA(), matrixB()))); } catch (error) { show("A × B", (error as Error).message); } } },
    { label: "RREF A", run: () => { const value = rref(matrixA()); show(`RREF A (rank ${value.rank})`, value.exact.map(row => row.join("  ")).join("\n")); } },
    { label: "eigen A", run: () => {
      try {
        const value = eigen(matrixA());
        show("Eigenvalues / eigenvectors", value.values.map((entry, index) => `${formatComplex(entry)}   →   [${value.eigenvectors[index]!.map(formatComplex).join(", ")}]`).join("\n"));
      } catch (error) { show("Eigenvalues", (error as Error).message); }
    } },
    { label: "solve Ax=b", run: () => {
      const solution = solve(matrixA(), valuesB.slice(0, sizeB).map(row => row[0] ?? 0).slice(0, size).concat(Array(Math.max(0, size - sizeB)).fill(0)));
      show("Solve A x = b (b = first column of B)", solution ? solution.map(value => Number(value.toPrecision(10))).join(", ") : "no unique solution");
    } },
  ];
  const operationHost = element("div", { className: "graph-lab-calc-actions" });
  for (const operation of operations) operationHost.append(button(operation.label, operation.run, { className: "graph-lab-small-button" }));

  container.addEventListener("pointerdown", () => container.focus());
  signal.addEventListener("abort", () => { result.textContent = ""; });
  shell.append(
    element("div", { className: "graph-lab-calc-title", textContent: "Matrix calculator" }),
    element("div", { className: "graph-lab-matrix-labels" }, [
      element("label", {}, ["A ", sizeSelect]),
      element("label", {}, ["B ", sizeSelectB]),
    ]),
    element("div", { className: "graph-lab-matrix-pair" }, [gridA, gridB]),
    operationHost,
    result,
  );
  renderGrid(gridA, valuesA, size, "A");
  renderGrid(gridB, valuesB, sizeB, "B");
}
