import test from "node:test";
import assert from "node:assert/strict";
import {
  bisect, curvePoints, findExtrema, findIntersections, findZeros, integrate, integralSamples, numericDerivative, tangentLine, yIntercept,
} from "../src/engine/analysis.ts";

test("numeric derivative and tangent", () => {
  assert.ok(Math.abs(numericDerivative(x => x * x, 2) - 4) < 1e-6);
  const tangent = tangentLine(x => x * x, 2);
  assert.ok(tangent);
  assert.equal(tangent!.point.y, 4);
  assert.ok(Math.abs(tangent!.slope - 4) < 1e-6);
  assert.ok(Math.abs(tangent!.line(3) - 8) < 1e-6);
});

test("adaptive Simpson integrates x^2 exactly enough", () => {
  assert.ok(Math.abs(integrate(x => x * x, 0, 1) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(integrate(x => Math.sin(x), 0, Math.PI) - 2) < 1e-8);
  assert.ok(Math.abs(integrate(x => x * x, 1, 0) + 1 / 3) < 1e-9);
  const samples = integralSamples(x => x * x, 0, 1, 20);
  assert.ok(samples.length === 1 && samples[0]!.length === 21);
});

test("zeros of x^2 - 2", () => {
  const zeros = findZeros(x => x * x - 2, [-3, 3]);
  assert.equal(zeros.length, 2);
  assert.ok(Math.abs(Math.abs(zeros[0]!.x) - Math.SQRT2) < 1e-6);
  assert.ok(Math.abs(Math.abs(zeros[1]!.x) - Math.SQRT2) < 1e-6);
  assert.equal(bisect(x => x - 0.25, 0, 1), 0.25);
});

test("extremum of x^2 - 4x", () => {
  const extrema = findExtrema(x => x * x - 4 * x, [-5, 5]);
  assert.equal(extrema.length, 1);
  assert.ok(Math.abs(extrema[0]!.x - 2) < 1e-4);
  assert.ok(Math.abs(extrema[0]!.y + 4) < 1e-4);
  assert.equal(extrema[0]!.detail, "min");
});

test("intersections of y = x and y = 2 - x", () => {
  const intersections = findIntersections(x => x, x => 2 - x, [-5, 5]);
  assert.equal(intersections.length, 1);
  assert.ok(Math.abs(intersections[0]!.x - 1) < 1e-6);
  assert.ok(Math.abs(intersections[0]!.y - 1) < 1e-6);
});

test("y-intercept and points of interest", () => {
  const intercept = yIntercept(x => x * x + 3);
  assert.deepEqual(intercept, { x: 0, y: 3, label: "y-intercept", kind: "intercept" });
  const points = curvePoints(x => x * x - 4 * x, [-5, 5]);
  assert.ok(points.some(point => point.kind === "zero"));
  assert.ok(points.some(point => point.kind === "extremum"));
  assert.ok(points.some(point => point.kind === "intercept"));
});
