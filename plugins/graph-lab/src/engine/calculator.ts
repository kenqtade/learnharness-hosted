// TRACK A — the embeddable calculator. Exam Prep imports THIS signature; keep it stable.
export type CalculatorKind = "graphing" | "scientific" | "four-function" | "matrix";
export interface CalculatorOptions {
  kind: CalculatorKind;
  /** Theme follows host CSS variables; size follows the container. */
  signal?: AbortSignal;
}
export interface CalculatorHandle { dispose(): void }

export function mountCalculator(container: HTMLElement, options: CalculatorOptions): CalculatorHandle {
  container.textContent = `${options.kind} calculator — coming soon.`;
  return { dispose: () => container.replaceChildren() };
}
