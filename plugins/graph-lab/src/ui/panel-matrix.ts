// Graph Lab UI — 2×2 and 3×3 matrix transformation: deformed grid, unit square
// (signed area = det), eigenlines, morph animation, and exact results.
import { parse } from "../engine/math.ts";
import { createExpression, GRAPH_COLORS, type GraphState } from "../engine/state.ts";
import {
  det, eigen, eigenLines, formatMatrix, gridLineImages, inverse, morphFromIdentity,
  rref, signedArea, transformPoint, transpose, unitSquareImage, type Matrix,
} from "../engine/matrix.ts";
import { formatComplex } from "../engine/complex.ts";
import { GraphCanvas, drawTransformation, readPalette } from "../engine/render.ts";
import { paddedView, type ViewRect } from "../engine/viewport.ts";
import { button, element, select } from "./dom.ts";
import type { PanelOptions } from "./types.ts";

const MATRIX_ID = /^matrix/;
const SOURCE_DOMAIN: ViewRect = { x: [-3, 3], y: [-3, 3] };

function readMatrix(text: string): Matrix | undefined {
  try {
    const value = parse(text).evaluate({}) as unknown as { toArray?: () => unknown };
    const array = value && typeof value.toArray === "function" ? value.toArray() : value;
    if (!Array.isArray(array) || !array.length) return undefined;
    const rows = array.map(row => Array.isArray(row) ? row.map(entry => Number(entry)) : []);
    if (rows.some(row => row.some(value => !Number.isFinite(value)))) return undefined;
    const size = rows.length;
    if (rows.some(row => row.length !== size)) return undefined;
    return rows;
  } catch { return undefined; }
}

function resize(matrix: Matrix, size: number): Matrix {
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (
    Number.isFinite(matrix[row]?.[column]) ? matrix[row]![column]! : row === column ? 1 : 0
  )));
}

function fitView(matrix: Matrix): ViewRect {
  const corners = [transformPoint(matrix, { x: -3, y: -3 }), transformPoint(matrix, { x: 3, y: -3 }),
    transformPoint(matrix, { x: 3, y: 3 }), transformPoint(matrix, { x: -3, y: 3 })];
  const xs = corners.map(point => point.x);
  const ys = corners.map(point => point.y);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const halfX = Math.max(2, (maxX - minX) / 2);
  const halfY = Math.max(2, (maxY - minY) / 2);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  return paddedView(centreX - halfX, centreX + halfX, centreY - halfY, centreY + halfY, 0.08);
}

export function mountMatrix(host: HTMLElement, options: PanelOptions): () => void {
  const { state, signal } = options;
  const root = element("div", { className: "graph-lab-2d" });
  const side = element("div", { className: "graph-lab-list" });
  const canvasWrap = element("div", { className: "graph-lab-canvas-wrap" });
  root.append(side, canvasWrap);
  host.append(root);

  const stored = state.expressions.find(expression => MATRIX_ID.test(expression.id) && readMatrix(expression.text));
  const initial = stored ? readMatrix(stored.text)! : [[2, 0], [0, 3]];
  let values: Matrix = resize(initial, initial.length >= 3 ? 3 : 2);
  let size = values.length;
  let morph = 1;
  let frame: number | undefined;
  let playing = false;
  let disposed = false;
  let drawFrame: number | undefined;

  function commit(): void {
    const text = JSON.stringify(values);
    const row = state.expressions.find(expression => MATRIX_ID.test(expression.id));
    if (row) row.text = text;
    else {
      const created = createExpression(text, GRAPH_COLORS[3]);
      created.id = `matrix${created.id}`;
      state.expressions.push(created);
    }
    options.onChange();
  }

  /* ------------------------------- editor -------------------------------- */

  const sizeSelect = select([{ value: "2", label: "2 × 2" }, { value: "3", label: "3 × 3" }], "Matrix size");
  sizeSelect.value = String(size);
  sizeSelect.addEventListener("change", () => {
    size = Number(sizeSelect.value) === 3 ? 3 : 2;
    values = resize(values, size);
    commit();
    renderGrid();
    draw();
    renderResults();
  });

  const gridHost = element("div", { className: "graph-lab-matrix-grid" });

  function renderGrid(): void {
    gridHost.replaceChildren();
    gridHost.style.gridTemplateColumns = `repeat(${size}, 3.4rem)`;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const input = element("input", { type: "number", className: "graph-lab-matrix-cell", inputMode: "decimal", value: String(values[row]?.[column] ?? 0) });
        input.setAttribute("aria-label", `A row ${row + 1} column ${column + 1}`);
        input.addEventListener("input", () => {
          const parsed = Number(input.value);
          values[row]![column] = Number.isFinite(parsed) ? parsed : 0;
          commit();
          draw();
          renderResults();
        });
        gridHost.append(input);
      }
    }
  }

  const results = element("pre", { className: "graph-lab-matrix-results", textContent: "Change a cell to see det, inverse, RREF and eigenvalues." });

  function renderResults(): void {
    const lines: string[] = [];
    try {
      const determinant = det(values);
      lines.push(`det A = ${Number(determinant.toPrecision(10))}`);
      lines.push(`trace = ${Number(values.reduce((sum, row, index) => sum + (row[index] ?? 0), 0).toPrecision(10))}`);
      lines.push(`signed area = ${Number(signedArea(unitSquareImage(values)).toPrecision(10))}`);
      const reduced = rref(values);
      lines.push(`rank = ${reduced.rank}`);
      lines.push("RREF");
      for (const row of reduced.exact) lines.push(`  ${row.join("   ")}`);
      const inverted = inverse(values);
      lines.push("A⁻¹");
      lines.push(inverted ? formatMatrix(inverted) : "  singular — no inverse");
      lines.push("Aᵀ");
      lines.push(formatMatrix(transpose(values)));
      const spectral = eigen(values);
      lines.push("Eigenvalues / eigenvectors");
      spectral.values.forEach((value, index) => {
        lines.push(`  λ = ${formatComplex(value, 4)}   →   [${spectral.eigenvectors[index]!.map(entry => formatComplex(entry, 4)).join(", ")}]`);
      });
    } catch (error) {
      lines.push((error as Error).message);
    }
    results.textContent = lines.join("\n");
  }

  /* -------------------------------- canvas ------------------------------- */

  const canvas = element("canvas", { className: "graph-lab-canvas" });
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Matrix transformation: grid image, unit square and eigenlines.");
  const hint = element("div", { className: "graph-lab-trace", textContent: "Unit square → parallelogram; dashed lines are eigenlines." });
  canvasWrap.append(canvas, hint);
  const graph = new GraphCanvas(canvas);

  function requestDraw(): void {
    if (disposed || drawFrame !== undefined) return;
    drawFrame = requestAnimationFrame(() => { drawFrame = undefined; draw(); });
  }

  function draw(): void {
    if (disposed || signal.aborted) return;
    const sizePixels = graph.resize();
    if (sizePixels.width < 2 || sizePixels.height < 2) return;
    const palette = readPalette(root);
    const matrix = morphFromIdentity(values, morph);
    drawTransformation(graph.context, graph.viewport(fitView(values)), {
      grid: gridLineImages(matrix, SOURCE_DOMAIN, 8),
      unitSquare: unitSquareImage(matrix),
      eigenLines: eigenLines(matrix),
      color: GRAPH_COLORS[0],
    }, palette);
  }

  /* ------------------------------ morphing ------------------------------- */

  const morphInput = element("input", { type: "range", className: "graph-lab-slider-range", min: "0", max: "1", step: "0.01", value: String(morph) });
  morphInput.setAttribute("aria-label", "Morph from identity to A");
  morphInput.addEventListener("input", () => {
    morph = Number(morphInput.value);
    stopAnimation();
    requestDraw();
  });
  const morphLabel = element("span", { className: "graph-lab-slider-name", textContent: "I → A" });
  const playButton = button("▶ Animate", () => toggleAnimation(), { className: "graph-lab-small-button" });
  playButton.setAttribute("aria-label", "Animate the transformation");

  function stopAnimation(): void {
    playing = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    playButton.textContent = "▶ Animate";
    playButton.setAttribute("aria-pressed", "false");
  }

  function toggleAnimation(): void {
    if (playing) { stopAnimation(); return; }
    playing = true;
    playButton.textContent = "⏸ Pause";
    playButton.setAttribute("aria-pressed", "true");
    const started = performance.now();
    const tick = (now: number) => {
      if (!playing || disposed) return;
      const phase = ((now - started) % 4200) / 4200;
      morph = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      morphInput.value = String(morph);
      requestDraw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  side.append(
    element("div", { className: "graph-lab-list-head" }, [
      element("h3", { className: "graph-lab-list-title", textContent: "Transformation" }), sizeSelect,
    ]),
    gridHost,
    element("div", { className: "graph-lab-section-title", textContent: "Morph" }),
    element("div", { className: "graph-lab-inline" }, [morphLabel, morphInput, playButton]),
    element("div", { className: "graph-lab-section-title", textContent: "Results" }),
    results,
  );

  renderGrid();
  renderResults();
  queueMicrotask(() => requestDraw());

  const observer = new ResizeObserver(() => requestDraw());
  observer.observe(canvasWrap);

  return () => {
    disposed = true;
    stopAnimation();
    if (drawFrame !== undefined) cancelAnimationFrame(drawFrame);
    observer.disconnect();
    root.remove();
  };
}
