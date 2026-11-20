// Tiny DOM helpers shared by the Question Bank and Exam Simulator views.
type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
export type Child = Node | string | number | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = String(value);
    else if (key === "value" && "value" in el) (el as unknown as { value: string }).value = String(value);
    else if (key === "checked" && el instanceof HTMLInputElement) el.checked = !!value;
    else if (key === "selected" && el instanceof HTMLOptionElement) el.selected = !!value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function clear(el: Element): void { while (el.firstChild) el.firstChild.remove(); }

export function select(options: { value: string; label: string; group?: string }[], value: string, onChange: (value: string) => void, attrs: Attrs = {}): HTMLSelectElement {
  const el = h("select", attrs);
  let group: HTMLOptGroupElement | undefined;
  for (const o of options) {
    const option = h("option", { value: o.value, selected: o.value === value }, o.label);
    if (o.group) {
      if (!group || group.label !== o.group) { group = h("optgroup", { label: o.group }); el.append(group); }
      group.append(option);
    } else { group = undefined; el.append(option); }
  }
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "ep-field" }, h("span", { class: "ep-field-label" }, label), control, hint ? h("span", { class: "ep-hint" }, hint) : null);
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60), sec = s % 60;
  return hrs ? `${hrs}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${min}:${String(sec).padStart(2, "0")}`;
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Markdown + LaTeX through the host renderer, scoped to a signal. */
export type MarkdownMount = (el: HTMLElement, text: string) => void;
