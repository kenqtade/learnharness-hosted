import test from "node:test";
import assert from "node:assert/strict";
import { marchSquares, maskAt, maskRects, pointCount, sampleExplicit, sampleParametric, samplePolar, sampleRegion, sampleRow } from "../src/engine/sample.ts";
import { buildScope, collectSliders, parseExpression } from "../src/engine/expressions.ts";

const view: { x: [number, number]; y: [number, number] } = { x: [-5, 5], y: [-5, 5] };

test("explicit curves are sampled smoothly", () => {
  const segments = sampleExplicit(x => x * x, view, 400, 300);
  assert.ok(segments.length >= 1);
  assert.ok(pointCount(segments) > 50);
  const points = segments[0]!;
  assert.ok(points.some(point => Math.abs(point.x) < 1e-9 && Math.abs(point.y) < 1e-9));
  assert.ok(points.every(point => Math.abs(point.y - point.x * point.x) < 0.05));
});

test("tan(x) is broken at its asymptotes, not connected across them", () => {
  const segments = sampleExplicit(Math.tan, { x: [-4, 4], y: [-5, 5] }, 600, 300);
  assert.equal(segments.length, 3, `one branch between the visible poles, got ${segments.length}`);
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      const a = segment[index - 1]!;
      const b = segment[index]!;
      assert.ok(Math.abs(b.y - a.y) < 100, "no branch may jump across the pole");
    }
    const low = Math.min(...segment.map(point => point.x));
    const high = Math.max(...segment.map(point => point.x));
    assert.ok(!(low < -Math.PI / 2 && high > -Math.PI / 2), "no branch crosses x = -π/2");
    assert.ok(!(low < Math.PI / 2 && high > Math.PI / 2), "no branch crosses x = π/2");
  }
});

test("1/x is broken at x = 0", () => {
  const segments = sampleExplicit(x => 1 / x, { x: [-3, 3], y: [-4, 4] }, 600, 300);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    const signs = new Set(segment.map(point => Math.sign(point.x)));
    assert.equal(signs.size <= 1 || [...signs].every(sign => sign === 0), true, "a branch stays on one side of the pole");
  }
});

test("implicit circles produce a closed ring of segments", () => {
  const segments = marchSquares((x, y) => x * x + y * y - 1, { x: [-2, 2], y: [-2, 2] }, 40, 2);
  assert.ok(segments.length > 40, `expected many segments, got ${segments.length}`);
  for (const segment of segments) {
    for (const point of segment) {
      assert.ok(Math.abs(Math.hypot(point.x, point.y) - 1) < 0.08, `point off the circle: ${point.x},${point.y}`);
    }
  }
  const bins = new Set<number>();
  for (const segment of segments) {
    for (const point of segment) {
      bins.add(Math.floor(((Math.atan2(point.y, point.x) + Math.PI) / (2 * Math.PI)) * 36) % 36);
    }
  }
  assert.equal(bins.size, 36, "the sampled ring closes all the way around");
});

test("parametric and polar circles", () => {
  const circle = sampleParametric(t => Math.cos(t), t => Math.sin(t), [0, 2 * Math.PI], { x: [-2, 2], y: [-2, 2] }, 400, 400);
  assert.ok(circle.length >= 1);
  for (const point of circle.flat()) assert.ok(Math.abs(Math.hypot(point.x, point.y) - 1) < 0.02);
  const polar = samplePolar(theta => 2, { x: [-3, 3], y: [-3, 3] }, 400, 400);
  assert.ok(polar.length >= 1);
  for (const point of polar.flat()) assert.ok(Math.abs(Math.hypot(point.x, point.y) - 2) < 0.02);
});

test("inequality regions shade the right side", () => {
  const mask = sampleRegion((x, y) => x * x + y * y < 1, { x: [-2, 2], y: [-2, 2] }, 80);
  assert.equal(mask.any, true);
  assert.equal(maskAt(mask, 0, 0), true);
  assert.equal(maskAt(mask, 1.5, 0), false);
  assert.ok(maskRects(mask).length > 0);
  assert.ok(maskRects(mask).every(rect => rect.x1 > rect.x0 && rect.y1 > rect.y0));
});

test("sampleRow dispatches every drawable kind", () => {
  const rows = ["y = x^2", "x = y^2", "r = 1", "(cos(t), sin(t))", "x^2+y^2=1", "y > x^2"].map(parseExpression);
  const sliders = collectSliders(rows);
  const scope = buildScope(rows, sliders);
  rows.forEach((row, index) => {
    const sampled = sampleRow(row, scope, view, 300, 300);
    if (index === 5) assert.ok(sampled.mask?.any);
    else assert.ok(sampled.segments.length > 0, `row ${index} (${row.kind}) drew nothing`);
  });
});
