import test from "node:test";
import assert from "node:assert/strict";
import {
  axisLabels, formatPi, formatTick, makeViewport, niceStep, panView, piTicks, tickValues, toScreen, toWorld, zoomView,
} from "../src/engine/viewport.ts";

test("world <-> screen round trips", () => {
  const viewport = makeViewport({ x: [-10, 10], y: [-5, 5] }, 800, 400);
  const screen = toScreen(viewport, 0, 0);
  assert.deepEqual(screen, { x: 400, y: 200 });
  assert.deepEqual(toScreen(viewport, -10, 5), { x: 0, y: 0 });
  assert.deepEqual(toScreen(viewport, 10, -5), { x: 800, y: 400 });
  for (const point of [{ x: -3.5, y: 2.25 }, { x: 7, y: -4.1 }]) {
    const back = toWorld(viewport, toScreen(viewport, point.x, point.y).x, toScreen(viewport, point.x, point.y).y);
    assert.ok(Math.abs(back.x - point.x) < 1e-9);
    assert.ok(Math.abs(back.y - point.y) < 1e-9);
  }
});

test("pan follows the drag and zoom keeps the anchor fixed", () => {
  const view = { x: [-10, 10], y: [-10, 10] };
  const size = { width: 400, height: 400 };
  const panned = panView(view, 40, 20, size);
  assert.deepEqual(panned.x, [-12, 8]);
  assert.deepEqual(panned.y, [-9, 11]);
  const anchor = { x: 100, y: 300 };
  const worldBefore = toWorld({ view, ...size }, anchor.x, anchor.y);
  const zoomed = zoomView(view, 2, anchor, size);
  const worldAfter = toWorld({ view: zoomed, ...size }, anchor.x, anchor.y);
  assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-9);
  assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-9);
  assert.equal(zoomed.x[1] - zoomed.x[0], 10);
});

test("nice steps are 1/2/5 × 10^n", () => {
  assert.equal(niceStep(10, 10), 1);
  assert.equal(niceStep(100, 10), 10);
  assert.equal(niceStep(37, 10), 5);
  assert.equal(niceStep(4.2, 10), 0.5);
  assert.equal(niceStep(0.09, 10), 0.01);
  assert.deepEqual(tickValues([-2, 2], 1), [-2, -1, 0, 1, 2]);
  const ticks = tickValues([0, 1], 0.2);
  assert.equal(ticks.length, 6);
  assert.ok(Math.abs((ticks[3] ?? 0) - 0.6) < 1e-9);
});

test("labels avoid floating-point noise", () => {
  assert.equal(formatTick(0.3, 0.1), "0.3");
  assert.equal(formatTick(2, 1), "2");
  assert.equal(formatTick(0, 0.5), "0");
  assert.equal(formatPi(Math.PI / 2), "π/2");
  assert.equal(formatPi(-Math.PI), "−π");
  assert.equal(formatPi(2 * Math.PI), "2π");
  assert.equal(formatPi(0), "0");
  const ticks = piTicks([-Math.PI, Math.PI], 4);
  assert.ok(ticks.some(tick => tick.label === "π/2"));
  assert.ok(ticks.every(tick => Math.abs(tick.value - Math.round((tick.value / Math.PI) * 4) * Math.PI / 4) < 1e-9));
});

test("axis labels carry positions", () => {
  const viewport = makeViewport({ x: [-4, 4], y: [-2, 2] }, 400, 200);
  const labels = axisLabels(viewport, { piTicks: true });
  assert.ok(labels.x.length > 0 && labels.y.length > 0);
  assert.ok(labels.x.some(tick => tick.value === 0));
  assert.ok(labels.x.every(tick => tick.position >= 0 && tick.position <= 400));
  assert.ok(labels.y.every(tick => tick.position >= 0 && tick.position <= 200));
});
