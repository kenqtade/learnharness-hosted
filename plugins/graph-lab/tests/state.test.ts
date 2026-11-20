import test from "node:test";
import assert from "node:assert/strict";
import { GRAPH_COLORS, GraphStateError, cloneGraphState, parseGraphState, serializeGraphState } from "../src/engine/state.ts";

test("full state is validated and defaults are filled", () => {
  const state = parseGraphState(JSON.stringify({
    version: 1,
    expressions: [{ id: "a", text: "y=x^2" }, { text: "y=2x", hidden: true }],
    sliders: { a: { min: -3, max: 3, step: 0.5, value: 2 } },
    view: { x: [5, -5], y: [0, 10] },
  }));
  assert.equal(state.version, 1);
  assert.equal(state.mode, "2d");
  assert.equal(state.expressions.length, 2);
  assert.equal(state.expressions[0]?.id, "a");
  assert.equal(state.expressions[1]?.hidden, true);
  assert.deepEqual(state.view.x, [-5, 5]);
  assert.deepEqual(state.view.y, [0, 10]);
  assert.deepEqual(state.sliders.a, { min: -3, max: 3, step: 0.5, value: 2 });
  assert.equal(state.options?.grid, true);
  assert.equal(state.options?.degrees, false);
  assert.equal(state.options?.piTicks, false);
});

test("short form is one expression per line", () => {
  const state = parseGraphState("y = x^2\ny = 2x + 1\n\n# comment\n");
  assert.equal(state.expressions.length, 2);
  assert.equal(state.expressions[0]?.text, "y = x^2");
  assert.equal(state.expressions[1]?.text, "y = 2x + 1");
  assert.equal(state.expressions[0]?.color, GRAPH_COLORS[0]);
});

test("object short form accepts a mode and options", () => {
  const state = parseGraphState({ mode: "complex", expressions: ["z = 1 + i"], options: { degrees: true }, view: { x: [-2, 2], y: [-2, 2] } });
  assert.equal(state.mode, "complex");
  assert.equal(state.options?.degrees, true);
  assert.equal(state.expressions[0]?.text, "z = 1 + i");
});

test("invalid state throws GraphStateError", () => {
  assert.throws(() => parseGraphState("{"), GraphStateError);
  assert.throws(() => parseGraphState("{not json"), GraphStateError);
  assert.throws(() => parseGraphState({ version: 2 }), /Unsupported graph version/);
  assert.throws(() => parseGraphState({ expressions: "nope" }), GraphStateError);
  assert.throws(() => parseGraphState({ mode: "polar" }), /mode must be one of/);
  assert.throws(() => parseGraphState({ view: { x: [0, 0] } }), /different bounds/);
  assert.throws(() => parseGraphState({ sliders: { a: { min: 3, max: 1 } } }), /min < max/);
  assert.throws(() => parseGraphState({ sliders: { a: { step: 0 } } }), /step > 0/);
  assert.throws(() => parseGraphState({ expressions: [{ text: 5 }] }), /text string/);
  assert.throws(() => parseGraphState(""), GraphStateError);
});

test("serialisation round trips and clones are detached", () => {
  const state = parseGraphState({ expressions: [{ id: "x", text: "y=x" }], sliders: { a: { min: 0, max: 1, step: 0.1, value: 0.5 } } });
  const again = parseGraphState(serializeGraphState(state));
  assert.deepEqual(again.expressions, state.expressions);
  assert.deepEqual(again.sliders, state.sliders);
  const copy = cloneGraphState(state);
  copy.expressions[0]!.text = "changed";
  copy.sliders.a!.value = 0.1;
  assert.equal(state.expressions[0]?.text, "y=x");
  assert.equal(state.sliders.a?.value, 0.5);
});

test("duplicate expression ids are made unique", () => {
  const state = parseGraphState({ expressions: [{ id: "same", text: "1" }, { id: "same", text: "2" }] });
  assert.notEqual(state.expressions[0]?.id, state.expressions[1]?.id);
});
