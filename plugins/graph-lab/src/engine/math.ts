// Graph Lab engine — the one place mathjs is imported (expression parsing and
// evaluation only; sampling, rendering, domain colouring, matrices and 3D are
// Graph Lab's own code).
//
// mathjs's ESM entry pulls in `seedrandom`, whose Node path calls
// `require("crypto")`. esbuild cannot resolve that for the browser (the build
// metafile records a `(disabled):crypto` input and the plugin build rejects it).
// mathjs ships a prebuilt browser bundle that already contains a browser-safe
// seedrandom, so the whole engine imports mathjs through this module. The bundle
// is UMD: import its default (module.exports) — named ESM imports fail in Node.
// Types: the slim declarations in ../mathjs-browser.d.ts (never "mathjs" itself).
import math from "mathjs/lib/browser/math.js";

export const { Complex, evaluate, parse, eigs, fraction } = math;
export type { Fraction, MathNode } from "mathjs/lib/browser/math.js";
