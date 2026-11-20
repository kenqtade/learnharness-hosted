export const FAMILIES = ["chemicalStructures", "musicalNotation", "technicalDiagrams"] as const;
export type Family = typeof FAMILIES[number];
export type Language = "smiles" | "abc" | "tikz";
export interface Settings {
  version: 1;
  revision: number;
  chemicalStructures: boolean;
  musicalNotation: boolean;
  technicalDiagrams: boolean;
}
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1, revision: 0, chemicalStructures: false, musicalNotation: false, technicalDiagrams: false,
});
export const LANGUAGES: Record<Family, Language> = {
  chemicalStructures: "smiles", musicalNotation: "abc", technicalDiagrams: "tikz",
};
export const LABELS: Record<Family, string> = {
  chemicalStructures: "Chemical structures", musicalNotation: "Musical notation", technicalDiagrams: "Technical diagrams",
};
export const INSTRUCTIONS: Record<Family, string> = {
  chemicalStructures: "For chemical structures, use a smiles fenced code block containing one SMILES molecule. Write explanations outside the block; do not author raw SVG.",
  musicalNotation: "For musical notation, use an abc fenced code block containing one complete ABC tune with X:, M:, L: and K: headers. It renders a static score, not audio; do not author raw SVG.",
  technicalDiagrams: [
    "For static technical diagrams, use a tikz fenced code block containing one self-contained TeX document. These blocks support physics/free-body diagrams, geometry, circuit schematics (not simulation), commutative diagrams, and analytic function plots.",
    "Every block is compiled independently. Put all required package and library declarations before \\begin{document}, then the diagram, then \\end{document}. The engine supplies the standalone document class: never include \\documentclass or \\documentstyle, and never rely on declarations from another block.",
    "Use a pgfplots axis only around \\addplot function or data plots; draw free-body, geometry and other diagrams with plain \\draw/\\node commands directly in the tikzpicture. Explicitly load the packages required by the diagram: \\usepackage{tikz}, \\usepackage{circuitikz}, \\usepackage{tikz-cd}, or \\usepackage{pgfplots}. For labels using \\text{...} or aligned equations, also load \\usepackage{amsmath}. Declare needed TikZ libraries with \\usetikzlibrary in the preamble.",
    "Place the tikzpicture, circuitikz, or tikzcd environment directly inside document. Do not wrap the diagram in \\[...\\], $$...$$, or an equation environment. Use $...$ for math in TikZ node labels; tikzcd cells already use math mode.",
    "The bundled PGFPlots version is 1.16. For plots, put \\pgfplotsset{compat=1.16} in the preamble; do not request 1.18 or another newer version.",
    "Write explanations outside the block. Author notation, not raw SVG, JavaScript, or external resources.",
  ].join("\n\n"),
};
export const SOURCE_LIMITS: Record<Language, number> = { smiles: 2 * 1024, abc: 16 * 1024, tikz: 32 * 1024 };
export const SVG_LIMIT = 2 * 1024 * 1024;
export const TEX_TIMEOUT_MS = 10_000;
export const TEX_QUEUE_LIMIT = 16;
export const CACHE_ENTRIES = 32;
export const CACHE_BYTES = 8 * 1024 * 1024;

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rich code blocks settings.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("Unsupported Rich code blocks settings version; the saved file has not been changed.");
  if (Object.keys(record).some(key => !["version", "revision", "inkColor", ...FAMILIES].includes(key))) throw new Error("Unknown Rich code blocks settings fields.");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || FAMILIES.some(key => typeof record[key] !== "boolean")) {
    throw new Error("Invalid Rich code blocks settings.");
  }
  // Legacy v1 inkColor is accepted above but deliberately omitted: theme Text
  // now owns neutral ink. Reads never rewrite disk; normal saves drop the key.
  return { version: 1, revision: record.revision as number, chemicalStructures: record.chemicalStructures as boolean,
    musicalNotation: record.musicalNotation as boolean, technicalDiagrams: record.technicalDiagrams as boolean };
}

export function parseChange(value: unknown): { family: Family; enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A family and boolean enabled value are required.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !FAMILIES.includes(record.family as Family) || typeof record.enabled !== "boolean") {
    throw new Error("A known family and boolean enabled value are required.");
  }
  return { family: record.family as Family, enabled: record.enabled };
}

export function checkSource(language: Language, source: string): void {
  if (new TextEncoder().encode(source).byteLength > SOURCE_LIMITS[language]) throw new Error(`${language} source exceeds the ${SOURCE_LIMITS[language] / 1024} KiB limit.`);
  if (!source.trim()) throw new Error(`Empty ${language} source.`);
}

export function checkSvgSize(svg: string): void {
  if (new TextEncoder().encode(svg).byteLength > SVG_LIMIT) throw new Error("Rendered SVG exceeds the 2 MiB limit.");
}

/** HOSTED FORK (2026-11): small/fast tutor models often write a bare
 *  `\begin{tikzpicture}…` (or add `\documentclass`) despite the instructions,
 *  and the engine then fails with "TeX engine render failed". Repair the
 *  common shapes before compiling; a complete, correct document is returned
 *  unchanged.
 *  - drops `\documentclass`/`\documentstyle` lines (the engine supplies one)
 *  - adds `\usepackage{…}` for the environments/commands the body uses
 *  - wraps the body in `\begin{document}…\end{document}` when missing */
export function normalizeTikz(source: string): string {
  // HOSTED FORK (2026-11): models wrap plain \draw diagrams in a pgfplots axis
  // with no \addplot; pgfplots then has no limits and the picture renders empty.
  // Such an axis is only a wrapper — drop it so TikZ draws in ordinary units.
  source = source.replace(/[ \t]*\\begin\{axis\}(?:\[[^\]]*\])?[ \t]*\r?\n?([\s\S]*?)[ \t]*\\end\{axis\}[ \t]*\r?\n?/g,
    (whole, body: string) => /\\addplot|\\addlegendentry|\bcoordinates\b/.test(body) ? whole : body);
  let text = source.replace(/^[ \t]*\\document(?:class|style)(?:\[[^\]]*\])?\{[^}]*\}[ \t]*\r?\n?/gm, "");
  const hasDocument = /\\begin\{document\}/.test(text);
  const needs: [string, RegExp][] = [
    ["tikz", /\\begin\{tikzpicture\}|\\tikz\b|\\usetikzlibrary/],
    ["circuitikz", /\\begin\{circuitikz\}/],
    ["tikz-cd", /\\begin\{tikzcd\}/],
    ["pgfplots", /\\begin\{axis\}|\\addplot/],
    ["amsmath", /\\text\{|\\begin\{(?:align|aligned|cases|pmatrix|bmatrix)\*?\}/],
  ];
  const loaded = (pkg: string) => new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${pkg.replace("-", "\\-")}\\b[^}]*\\}`).test(text);
  const missing = needs.filter(([pkg, used]) => used.test(text) && !loaded(pkg)).map(([pkg]) => pkg);
  const compat = missing.includes("pgfplots") && !/\\pgfplotsset\{[^}]*compat/.test(text) ? "\\pgfplotsset{compat=1.16}\n" : "";
  const packages = missing.map(pkg => `\\usepackage{${pkg}}\n`).join("") + compat;
  if (hasDocument) return packages ? text.replace(/\\begin\{document\}/, `${packages}\\begin{document}`) : text;
  // Preamble lines the model wrote above the picture stay in the preamble.
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [], body: string[] = [];
  for (const line of lines) (body.length === 0 && /^\s*(\\usepackage|\\usetikzlibrary|\\pgfplotsset|\\tikzset|\\newcommand|\\definecolor|%|$)/.test(line) ? preamble : body).push(line);
  const head = [packages.trimEnd(), preamble.join("\n").trim()].filter(Boolean).join("\n");
  return `${head ? head + "\n" : ""}\\begin{document}\n${body.join("\n").trim()}\n\\end{document}\n`;
}
