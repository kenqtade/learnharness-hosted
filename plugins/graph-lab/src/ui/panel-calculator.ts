// Graph Lab UI — the Calculator tab: any of the four embeddable calculators.
import { mountCalculator, type CalculatorHandle, type CalculatorKind } from "../engine/calculator.ts";
import { element, select } from "./dom.ts";
import type { PanelOptions } from "./types.ts";

const KINDS: { value: CalculatorKind; label: string }[] = [
  { value: "scientific", label: "Scientific" },
  { value: "graphing", label: "Graphing" },
  { value: "four-function", label: "Four-function" },
  { value: "matrix", label: "Matrix" },
];

export function mountCalculatorPanel(host: HTMLElement, options: PanelOptions): () => void {
  const root = element("div", { className: "graph-lab-calculator-panel" });
  const bar = element("div", { className: "graph-lab-list-head" }, [
    element("h3", { className: "graph-lab-list-title", textContent: "Calculator" }),
  ]);
  const kindSelect = select(KINDS, "Calculator type");
  bar.append(kindSelect);
  const mountHost = element("div", { className: "graph-lab-calculator-host" });
  root.append(bar, mountHost);
  host.append(root);

  let kind: CalculatorKind = "scientific";
  let handle: CalculatorHandle | undefined;
  let controller = new AbortController();

  function mount(): void {
    handle?.dispose();
    controller.abort();
    controller = new AbortController();
    const texts = options.state.expressions.map(expression => expression.text).filter(text => text.trim());
    handle = mountCalculator(mountHost, {
      kind,
      signal: controller.signal,
      degrees: options.state.options?.degrees === true,
      initialExpressions: texts.length ? texts : undefined,
      trace: true,
    });
  }

  kindSelect.addEventListener("change", () => {
    kind = (kindSelect.value as CalculatorKind) ?? "scientific";
    mount();
  });

  mount();

  return () => {
    controller.abort();
    handle?.dispose();
    root.remove();
  };
}
