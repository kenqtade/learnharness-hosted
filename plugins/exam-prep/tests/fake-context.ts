// A minimal fake PluginBackendContext for Exam Prep backend tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FakeContext {
  ctx: any;
  call: (op: string, input?: unknown) => Promise<any>;
  tools: () => any[];
  instructions: string[];
  events: { topic: string; data: unknown }[];
  workers: Map<string, any>;
  started: any[];
  dir: string;
  dispose: () => void;
}

export function fakeContext(options: { dir?: string } = {}): FakeContext {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "exam-prep-"));
  const handlers = new Map<string, (input: unknown) => unknown>();
  const toolFactories: any[] = [];
  const instructions: string[] = [];
  const events: { topic: string; data: unknown }[] = [];
  const workers = new Map<string, any>();
  const started: any[] = [];
  const cleanups: (() => void)[] = [];
  const controller = new AbortController();
  const tasks = new Map<string, any>();
  const ctx = {
    manifest: { id: "exam-prep" }, directory: dir, dataDirectory: dir, signal: controller.signal,
    cleanup: (fn: () => void) => { cleanups.push(fn); },
    handle: (name: string, fn: (input: unknown) => unknown) => { handlers.set(name, fn); return () => handlers.delete(name); },
    events: { on: () => () => {}, emit: (topic: string, data?: unknown) => { events.push({ topic, data }); } },
    registerTools: (c: any) => { toolFactories.push(c); return () => {}; },
    registerInstructions: (c: any) => { instructions.push(c.text); return () => {}; },
    inference: {
      catalog: async () => ({ models: [{ provider: "test", id: "cheap", supportedLevels: [] }], slots: { cheap: { model: { provider: "test", id: "cheap" } } } }),
      complete: async () => { throw new Error("no inference in tests"); },
    },
    workers: {
      register: (def: any) => { workers.set(def.id, def); return () => workers.delete(def.id); },
      start: (id: string, opts: any) => {
        const existing = [...tasks.values()].find(t => t.requestId === opts.requestId);
        if (existing) return existing;
        const task = { id: `task_${tasks.size + 1}`, definitionId: id, requestId: opts.requestId, status: "queued", input: opts.input, prompt: opts.prompt };
        tasks.set(task.id, task); started.push(task); return task;
      },
      list: () => [...tasks.values()],
      get: (id: string) => tasks.get(id) ?? (() => { throw new Error("unknown task"); })(),
      subscribe: () => () => {},
      wait: () => new Promise(() => {}),
      cancel: (id: string) => { const t = tasks.get(id); if (t) t.status = "cancelled"; },
      dispose: async () => {},
    },
    agents: {}, learning: {},
    createBackgroundTool: () => { throw new Error("not in tests"); },
    registerQuestionType: () => () => {}, registerProblemType: () => () => {},
  };
  return {
    ctx, instructions, events, workers, started, dir,
    call: async (op, input) => {
      const fn = handlers.get(op);
      if (!fn) throw new Error(`no handler ${op}`);
      return await fn(input ?? {});
    },
    tools: () => toolFactories.flatMap(f => f.create({ chatId: "c1", agent: "teacher" })),
    dispose: () => { controller.abort(); for (const fn of cleanups) fn(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
