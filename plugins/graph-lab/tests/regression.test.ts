import test from "node:test";
import assert from "node:assert/strict";
import { exponentialRegression, linearRegression, quadraticRegression, regression } from "../src/engine/regression.ts";

test("linear regression recovers y = 2x + 1", () => {
  const result = linearRegression([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
  assert.ok(result);
  assert.ok(Math.abs(result!.coefficients[0]! - 1) < 1e-9);
  assert.ok(Math.abs(result!.coefficients[1]! - 2) < 1e-9);
  assert.ok(Math.abs(result!.r2 - 1) < 1e-9);
  assert.ok(Math.abs(result!.predict(10) - 21) < 1e-9);
  assert.match(result!.equation, /2x/);
});

test("quadratic regression recovers a parabola", () => {
  const result = quadraticRegression([{ x: -1, y: 3 }, { x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 9 }]);
  assert.ok(result);
  const [c, b, a] = result!.coefficients as [number, number, number];
  assert.ok(Math.abs(a - 2) < 1e-8);
  assert.ok(Math.abs(b) < 1e-8);
  assert.ok(Math.abs(c - 1) < 1e-8);
  assert.ok(Math.abs(result!.r2 - 1) < 1e-8);
});

test("exponential regression goes through a log fit", () => {
  const result = exponentialRegression([{ x: 0, y: 2 }, { x: 1, y: 6 }, { x: 2, y: 18 }, { x: 3, y: 54 }]);
  assert.ok(result);
  assert.ok(Math.abs(result!.coefficients[0]! - 2) < 1e-6);
  assert.ok(Math.abs(result!.coefficients[1]! - Math.log(3)) < 1e-6);
  assert.ok(Math.abs(result!.r2 - 1) < 1e-6);
});

test("bad data returns undefined instead of throwing", () => {
  assert.equal(linearRegression([{ x: 1, y: 1 }]), undefined);
  assert.equal(quadraticRegression([{ x: 0, y: 0 }]), undefined);
  assert.equal(exponentialRegression([{ x: 0, y: -1 }, { x: 1, y: -2 }]), undefined);
  assert.equal(regression("linear", []), undefined);
});
