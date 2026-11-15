// HOSTED FORK: cross-instance instruction refresh + TikZ repair.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { INSTRUCTIONS, normalizeTikz } from "../src/contract.ts";

function instance(directory: string) {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const instructions = new Set<{ text: string }>();
  const ctx = {
    dataDirectory: directory, signal: new AbortController().signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    registerInstructions(value: { text: string }) { instructions.add(value); return () => { instructions.delete(value); }; },
    events: { emit() {} },
  } as unknown as PluginBackendContext;
  activate(ctx);
  return { instructions, call: (name: string, input?: unknown) => handlers.get(name)!(input) };
}

test("a family switched on by ANOTHER instance reaches this instance's tutor after hosted-sync", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-hosted-"));
  try {
    const a = instance(directory), b = instance(directory); // two warm serverless instances, one shared store
    assert.equal(a.instructions.size, 0);
    b.call("set-family", { family: "technicalDiagrams", enabled: true });
    assert.equal(a.instructions.size, 0, "nothing changes on A until it syncs");
    a.call("hosted-sync");
    assert.deepEqual([...a.instructions].map(i => i.text), [INSTRUCTIONS.technicalDiagrams]);
    b.call("set-family", { family: "technicalDiagrams", enabled: false });
    a.call("get-settings"); // any re-read also re-registers
    assert.equal(a.instructions.size, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("normalizeTikz wraps a bare picture and loads the packages it uses", () => {
  const bare = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}";
  const fixed = normalizeTikz(bare);
  assert.match(fixed, /^\\usepackage\{tikz\}\n\\begin\{document\}\n\\begin\{tikzpicture\}/);
  assert.match(fixed, /\\end\{tikzpicture\}\n\\end\{document\}\n$/);
  const plot = normalizeTikz("\\begin{tikzpicture}\\begin{axis}\\addplot {x^2};\\end{axis}\\end{tikzpicture}");
  assert.match(plot, /\\usepackage\{tikz\}\n\\usepackage\{pgfplots\}\n\\pgfplotsset\{compat=1\.16\}\n\\begin\{document\}/);
  assert.match(normalizeTikz("\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}"), /\\usepackage\{tikz-cd\}/);
  assert.match(normalizeTikz("\\begin{circuitikz}\\draw (0,0) to[R] (2,0);\\end{circuitikz}"), /\\usepackage\{circuitikz\}/);
});

test("normalizeTikz keeps the model's preamble lines, drops \\documentclass, leaves a correct document alone", () => {
  const withPreamble = normalizeTikz("\\documentclass{standalone}\n\\usepackage{tikz}\n\\usetikzlibrary{arrows}\n\\begin{tikzpicture}\\draw (0,0) -- (1,0);\\end{tikzpicture}");
  assert.doesNotMatch(withPreamble, /documentclass/);
  assert.equal((withPreamble.match(/\\usepackage\{tikz\}/g) ?? []).length, 1);
  assert.match(withPreamble, /\\usetikzlibrary\{arrows\}\n\\begin\{document\}/);
  const correct = "\\usepackage{tikz}\n\\begin{document}\n\\begin{tikzpicture}\\draw (0,0) -- (1,0);\\end{tikzpicture}\n\\end{document}\n";
  assert.equal(normalizeTikz(correct), correct);
  const missingPkg = normalizeTikz("\\begin{document}\\begin{tikzpicture}\\end{tikzpicture}\\end{document}");
  assert.match(missingPkg, /^\\usepackage\{tikz\}\n\\begin\{document\}/);
});
