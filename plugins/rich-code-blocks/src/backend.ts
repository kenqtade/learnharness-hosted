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
  // The tutor instructions follow the families: when another instance switched
  // a family on or off, re-register them here too, or this instance's tutor
  // never learns the block format (bare TikZ → "TeX engine render failed").
  const reload = (): void => {
    const before = settings;
    try { settings = read(); }
    catch { /* unreadable or malformed: keep the cached settings */ }
    if (FAMILIES.some(family => before[family] !== settings[family])) updateInstructions();
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
  // HOSTED FORK: the host calls this once per request on a hosted server.
  const unregisterSync = ctx.handle("hosted-sync", () => { assertActive(); reload(); return null; });
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
    unregisterGet(); unregisterSave(); unregisterSync();
    instructionDisposers.splice(0).forEach(dispose => dispose());
  };
}
