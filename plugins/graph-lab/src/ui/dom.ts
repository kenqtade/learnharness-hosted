// Graph Lab UI — tiny plain-DOM helpers. No model or learner text ever goes
// through innerHTML; everything is created with textContent.

export type Child = Node | string;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<Omit<HTMLElementTagNameMap[K], "style">> & { style?: Partial<CSSStyleDeclaration> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, ...rest } = properties as { style?: Partial<CSSStyleDeclaration> } & Record<string, unknown>;
  Object.assign(node, rest);
  if (style) Object.assign(node.style, style);
  for (const child of children) node.append(child);
  return node;
}

export function button(label: string, onClick: (event: MouseEvent) => void, extra: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const node = element("button", { type: "button", textContent: label, ...extra });
  node.addEventListener("click", onClick);
  return node;
}

export function labelled(labelText: string, control: HTMLElement, className = "graph-lab-field"): HTMLLabelElement {
  const label = element("label", { className });
  label.append(element("span", { textContent: labelText }), control);
  return label;
}

export function textInput(value: string, ariaLabel: string, extra: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const input = element("input", {
    type: "text", value, spellcheck: false, autocomplete: "off", autocapitalize: "off",
    className: "graph-lab-input", ...extra,
  });
  input.setAttribute("aria-label", ariaLabel);
  return input;
}

export function numberInput(value: number | string, ariaLabel: string, extra: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const input = element("input", {
    type: "number", value: String(value), inputMode: "decimal",
    className: "graph-lab-number", ...extra,
  });
  input.setAttribute("aria-label", ariaLabel);
  return input;
}

export function select(values: { value: string; label: string }[], ariaLabel: string): HTMLSelectElement {
  const node = element("select", { className: "graph-lab-select" });
  for (const value of values) node.append(element("option", { value: value.value, textContent: value.label }));
  node.setAttribute("aria-label", ariaLabel);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "undefined" : value > 0 ? "∞" : "−∞";
  if (Math.abs(value) < 1e-12) return "0";
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

export function errorLine(message: string): HTMLElement {
  const line = element("p", { className: "graph-lab-row-error", textContent: message });
  line.setAttribute("role", "alert");
  return line;
}
