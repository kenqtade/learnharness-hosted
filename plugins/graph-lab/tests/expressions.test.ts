import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScope, collectSliders, evaluateValue, parseExpression, testRelation, type ParsedExpression,
} from "../src/engine/expressions.ts";

const kind = (text: string) => parseExpression(text);

test("explicit y = f(x) and a bare expression", () => {
  const explicit = kind("y = 2x + 1");
  assert.equal(explicit.kind, "explicit");
  assert.equal(evaluateValue(explicit.compiled, { x: 3 }), 7);
  const bare = kind("x^2 - 4");
  assert.equal(bare.kind, "explicit");
  assert.equal(evaluateValue(bare.compiled, { x: 3 }), 5);
});

test("x = g(y), polar, parametric, points", () => {
  const vertical = kind("x = 2y + 1");
  assert.equal(vertical.kind, "explicitY");
  assert.equal(evaluateValue(vertical.compiled, { y: 2 }), 5);

  const polar = kind("r = 2cos(theta)");
  assert.equal(polar.kind, "polar");
  assert.ok(Math.abs((evaluateValue(polar.compiled, { theta: 0 }) ?? 0) - 2) < 1e-12);
  assert.equal(kind("r = 2cos(θ)").kind, "polar");
  assert.equal(kind("r = 2cos(\\theta)").kind, "polar");

  const parametric = kind("(cos(t), sin(t))");
  assert.equal(parametric.kind, "parametric");
  assert.deepEqual(parametric.paramRange, [0, 2 * Math.PI]);
  const ranged = kind("(t, t^2) {0 < t < 3}");
  assert.deepEqual(ranged.paramRange, [0, 3]);

  const point = kind("(1, 2)");
  assert.equal(point.kind, "point");
  assert.equal(point.points?.length, 1);
  const points = kind("(1, 2), (3, 4)");
  assert.equal(points.kind, "points");
  assert.equal(points.points?.length, 2);
});

test("implicit curves and inequalities", () => {
  const circle = kind("x^2 + y^2 = 1");
  assert.equal(circle.kind, "implicit");
  assert.equal(evaluateValue(circle.compiled, { x: 0, y: 1 }), 0);
  const inequality = kind("y > x^2");
  assert.equal(inequality.kind, "inequality");
  assert.equal(inequality.op, ">");
  assert.equal(testRelation(inequality, {}, 0, 1), true);
  assert.equal(testRelation(inequality, {}, 0, -1), false);
  assert.equal(kind("x^2 + y^2 < 1").op, "<");
});

test("slider definitions, function definitions and free-letter sliders", () => {
  const slider = kind("a = 3");
  assert.equal(slider.kind, "slider");
  assert.deepEqual(slider.sliderDef, { name: "a", value: 3 });

  const fn = kind("f(x) = x^2 + a");
  assert.equal(fn.kind, "function");
  assert.deepEqual(fn.functionDef, { name: "f", params: ["x"] });
  assert.deepEqual(fn.sliders, ["a"]);

  const rows: ParsedExpression[] = ["a = 3", "f(x) = a x^2", "y = f(x) + b"].map(parseExpression);
  const sliders = collectSliders(rows);
  assert.deepEqual(Object.keys(sliders).sort(), ["a", "b"]);
  assert.equal(sliders.a?.value, 3);
  assert.equal(sliders.b?.value, 1);
  assert.deepEqual([sliders.b?.min, sliders.b?.max, sliders.b?.step], [-10, 10, 0.1]);

  const scope = buildScope(rows, sliders);
  assert.equal(evaluateValue(rows[2]!.compiled, { ...scope, x: 2 }), 13);
  // A stored slider value wins over the definition's initial value.
  const dragged = buildScope(rows, { ...sliders, a: { ...sliders.a!, value: 5 } });
  assert.equal(evaluateValue(rows[2]!.compiled, { ...dragged, x: 2 }), 21);
});

test("domain restrictions", () => {
  const row = kind("y = x {x > 0}");
  assert.equal(row.domain?.variable, "x");
  assert.equal(row.domain?.test(1), true);
  assert.equal(row.domain?.test(-1), false);
  const interval = kind("x^2 {-1 <= x < 2}");
  assert.equal(interval.domain?.min, -1);
  assert.equal(interval.domain?.max, 2);
  assert.equal(interval.domain?.test(-1), true);
  assert.equal(interval.domain?.test(2), false);
  assert.equal(kind("y=x {y>0}").domain?.variable, "y");
});

test("tables and regressions", () => {
  const table = kind("[[1, 2], [2, 4.1], [3, 8.9]]");
  assert.equal(table.kind, "table");
  assert.equal(table.points?.length, 3);
  assert.equal(evaluateValue(table.points?.[1]?.y), 4.1);
  assert.equal(kind("[[1,2,3]]").error !== undefined, true);

  const linear = kind("y ~ a x + b");
  assert.equal(linear.kind, "regression");
  assert.equal(linear.regression?.family, "linear");
  assert.deepEqual(linear.sliders.sort(), ["a", "b"]);
  assert.equal(kind("y ~ a x^2 + b x + c").regression?.family, "quadratic");
  assert.equal(kind("y ~ a e^(b x)").regression?.family, "exponential");
});

test("errors stay inside the row and are short", () => {
  const empty = kind("   ");
  assert.equal(empty.kind, "empty");
  assert.ok(empty.error);
  const broken = kind("y = (");
  assert.ok(broken.error);
  assert.ok((broken.error ?? "").length < 200);
  const badDomain = kind("y = x {x > }");
  assert.ok(badDomain.error);
  const notAFunction = kind("f(x) = x^2 {x>0}");
  assert.equal(notAFunction.kind, "function");
  // None of these throw.
  assert.doesNotThrow(() => parseExpression("@@@"));
});

test("unicode normalisation and defaults", () => {
  const row = kind("y = 2π x − 1");
  assert.equal(row.kind, "explicit");
  assert.ok(Math.abs((evaluateValue(row.compiled, { x: 1 }) ?? 0) - (2 * Math.PI - 1)) < 1e-9);
  const degree = kind("y = sin(90) {x>0}");
  assert.equal(degree.domain?.variable, "x");
});
