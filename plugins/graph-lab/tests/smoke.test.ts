import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/engine/math.ts";

test("mathjs is available for the engine (complex + matrices)", () => {
  assert.equal(String(evaluate("sqrt(-4)")), "2i");
  assert.equal(evaluate("det([1,2;3,4])"), -2);
});
