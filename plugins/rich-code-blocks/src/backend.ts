import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { DEFAULT_SETTINGS, FAMILIES, INSTRUCTIONS, parseChange, parseSettings, type Settings } from "./contract.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const file = path.join(ctx.dataDirectory, "settings.json");
  const read = (): Settings => {
    try { return parseSettings(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_SETTINGS };
    }
  };
  let settings = read();
  // HOSTED FORK: several serverless instances share this data directory, so
  // another instance may have written settings.json since this one cached
  // it. Re-read before answering and before changing, so a revision never
  // overwrites a newer one. An unreadable file keeps the cached settings.
  const reload = (): void => {
    try { settings = read(); }
    catch { /* unreadable or malformed: keep the cached settings */ }
  };
  const instructionDisposers: (() => void)[] = [];
  const updateInstructions = () => {
    instructionDisposers.splice(0).forEach(dispose => dispose());
    for (const family of FAMILIES) if (settings[family]) {
      instructionDisposers.push(ctx.registerInstructions({ agents: ["prober", "teacher", "practice"], text: INSTRUCTIONS[family] }));
    }
  };
  const assertActive = () => { if (ctx.signal.aborted) throw new Error("Rich code blocks is disabled."); };
  updateInstructions();
  const unregisterGet = ctx.handle("get-settings", () => { assertActive(); reload(); return { ...settings }; });
  const nextRevision = () => {
    if (settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
    return settings.revision + 1;
  };
  const commit = (next: Settings, instructionsChanged = false) => {
    fs.mkdirSync(ctx.dataDirectory, { recursive: true });
    const temporary = path.join(ctx.dataDirectory, `.settings-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    settings = next;
    if (instructionsChanged) updateInstructions();
    ctx.events.emit("settings-changed", { ...settings });
    return { ...settings };
  };
  const unregisterSave = ctx.handle("set-family", input => {
    assertActive();
    const { family, enabled } = parseChange(input);
    reload(); // HOSTED FORK: build the new revision on the newest stored one.
    if (settings[family] === enabled) return { ...settings };
    return commit({ ...settings, revision: nextRevision(), [family]: enabled }, true);
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregisterGet(); unregisterSave();
    instructionDisposers.splice(0).forEach(dispose => dispose());
  };
}
