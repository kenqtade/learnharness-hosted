import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";

interface Harness {
  ctx: PluginBackendContext;
  call(name: string, input?: unknown): Promise<unknown>;
  instructions: string[];
  dispose(): void;
  directory: string;
}

function harness(): Harness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-lab-backend-"));
  const handlers = new Map<string, (input: unknown) => unknown>();
  const instructions: string[] = [];
  const cleanups: (() => void)[] = [];
  const controller = new AbortController();
  const ctx = {
    manifest: { apiVersion: 1, id: "graph-lab", name: "Graph Lab", version: "0.1.0", minAppVersion: "0.6.0" },
    directory,
    dataDirectory: directory,
    signal: controller.signal,
    cleanup(dispose: () => void) { cleanups.push(dispose); },
    handle(name: string, handler: (input: unknown) => unknown) {
      if (handlers.has(name)) throw new Error(`duplicate ${name}`);
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerInstructions(contribution: { text: string }) {
      instructions.push(contribution.text);
      return () => { const index = instructions.indexOf(contribution.text); if (index >= 0) instructions.splice(index, 1); };
    },
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as PluginBackendContext;
  const dispose = activate(ctx);
  return {
    ctx, instructions, directory,
    async call(name, input) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`unknown operation ${name}`);
      return handler(input);
    },
    dispose,
  };
}

const state = {
  version: 1,
  mode: "2d",
  expressions: [{ id: "e1", text: "y=x^2" }],
  sliders: { a: { min: -2, max: 2, step: 0.5, value: 1 } },
  view: { x: [-5, 5], y: [-5, 5] },
};

test("tutor instructions teach the graph format", () => {
  const app = harness();
  assert.equal(app.instructions.length, 1);
  assert.match(app.instructions[0]!, /```graph/);
  assert.match(app.instructions[0]!, /"mode":"2d"/);
  assert.match(app.instructions[0]!, /complex/);
  assert.match(app.instructions[0]!, /matrix/);
  assert.ok((app.instructions[0]!.match(/```graph/g) ?? []).length >= 3);
  app.dispose();
  assert.equal(app.instructions.length, 0);
});

test("save, list, get and delete are revisioned", async () => {
  const app = harness();
  const saved = await app.call("graphs.save", { name: "Parabola", state }) as { revision: number; graph: { id: string; name: string; state: typeof state } };
  assert.equal(saved.revision, 1);
  assert.match(saved.graph.id, /^graph_/);
  assert.equal(saved.graph.name, "Parabola");
  assert.equal(saved.graph.state.expressions[0]?.text, "y=x^2");

  const listed = await app.call("graphs.list") as { revision: number; graphs: { id: string; state: typeof state }[] };
  assert.equal(listed.revision, 1);
  assert.equal(listed.graphs.length, 1);
  assert.equal(listed.graphs[0]?.id, saved.graph.id);
  assert.equal(listed.graphs[0]?.state.sliders.a?.value, 1);

  const fetched = await app.call("graphs.get", { id: saved.graph.id }) as { graph: { name: string } };
  assert.equal(fetched.graph.name, "Parabola");

  const updated = await app.call("graphs.save", { id: saved.graph.id, name: "Parabola v2", state: { ...state, view: { x: [-1, 1], y: [-1, 1] } } }) as { revision: number; graph: { id: string; name: string; createdAt: string; updatedAt: string } };
  assert.equal(updated.revision, 2);
  assert.equal(updated.graph.id, saved.graph.id);
  assert.equal(updated.graph.name, "Parabola v2");
  assert.equal((await app.call("graphs.list") as { graphs: unknown[] }).graphs.length, 1);

  const deleted = await app.call("graphs.delete", { id: saved.graph.id }) as { revision: number; deleted: boolean };
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.revision, 3);
  assert.equal((await app.call("graphs.list") as { graphs: unknown[] }).graphs.length, 0);
  assert.equal((await app.call("graphs.delete", { id: "graph_missing" }) as { deleted: boolean }).deleted, false);
  app.dispose();
});

test("another activation sees the same file (serverless-safe)", async () => {
  const first = harness();
  const saved = await first.call("graphs.save", { name: "Shared", state }) as { graph: { id: string } };
  const second = { ...first, ctx: undefined };
  // Re-activate against the same directory to simulate a second instance.
  const handlers = new Map<string, (input: unknown) => unknown>();
  const directory = first.directory;
  const { activate: activateAgain } = await import("../src/backend.ts");
  const dispose = activateAgain({
    dataDirectory: directory,
    signal: new AbortController().signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => handlers.delete(name); },
    registerInstructions() { return () => {}; },
  } as unknown as PluginBackendContext);
  void second;
  const listed = await handlers.get("graphs.list")!({}) as { graphs: { id: string }[] };
  assert.equal(listed.graphs[0]?.id, saved.graph.id);
  dispose();
  first.dispose();
});

test("stash is one-shot and carries a whole state", async () => {
  const app = harness();
  const stashed = await app.call("graphs.stash", { state: { ...state, mode: "complex" } }) as { id: string };
  assert.match(stashed.id, /^stash_/);
  const first = await app.call("graphs.unstash") as { state: { mode: string } | null };
  assert.equal(first.state?.mode, "complex");
  const second = await app.call("graphs.unstash") as { state: unknown };
  assert.equal(second.state, null);
  app.dispose();
});

test("settings persist with defaults and validation", async () => {
  const app = harness();
  const defaults = await app.call("settings.get") as { defaultMode: string; degrees: boolean };
  assert.equal(defaults.defaultMode, "2d");
  assert.equal(defaults.degrees, false);
  const updated = await app.call("settings.set", { defaultMode: "3d", degrees: true }) as { defaultMode: string; degrees: boolean; revision: number };
  assert.equal(updated.defaultMode, "3d");
  assert.equal(updated.degrees, true);
  assert.equal(updated.revision, 1);
  const again = await app.call("settings.get") as { defaultMode: string };
  assert.equal(again.defaultMode, "3d");
  await assert.rejects(() => app.call("settings.set", { defaultMode: "nope" }), /Default mode/);
  app.dispose();
});

test("invalid input is rejected without writing", async () => {
  const app = harness();
  await assert.rejects(() => app.call("graphs.save", { name: "", state }), /name/i);
  await assert.rejects(() => app.call("graphs.save", { name: "x", state: { version: 2 } }), /version 1/);
  await assert.rejects(() => app.call("graphs.save", { name: "x", state: { view: { x: [0, 0] } } }), /range/);
  await assert.rejects(() => app.call("graphs.delete", { id: "bad" }), /id/);
  await assert.rejects(() => app.call("graphs.get", { id: "graph_zzzz" }), /id/);
  assert.ok(fs.existsSync(path.join(app.directory, "graphs.json")) === false);
  app.dispose();
});
