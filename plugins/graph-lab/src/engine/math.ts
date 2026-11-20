// Graph Lab engine — the one place mathjs is imported.
//
// mathjs's ESM entry pulls in `seedrandom`, whose Node path calls
// `require("crypto")`. esbuild cannot resolve that for the browser (the build
// metafile records a `(disabled):crypto` input and the plugin build rejects it).
// mathjs ships a prebuilt browser bundle that already contains a browser-safe
// seedrandom, so the whole engine imports mathjs through this module.
export {
  Complex, evaluate, parse, eigs, fraction,
} from "mathjs/lib/browser/math.js";
export type { Fraction, MathNode } from "mathjs/lib/browser/math.js";
