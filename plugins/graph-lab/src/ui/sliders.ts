// Graph Lab UI — slider rows shared by the Lab view and ```graph blocks.
// A slider row owns only presentation: the value lives in GraphState.sliders.
import type { GraphState } from "../engine/state.ts";
import { button, element, formatNumber, numberInput } from "./dom.ts";

export interface SliderControlsOptions {
  state: GraphState;
  /** Redraw the graph (value changed). */
  onChange(): void;
  /** Persist / mark dirty (value changed by the learner). */
  onCommit?(): void;
  /** Show min / max / step inputs (the full Lab view does; blocks do not). */
  editable?: boolean;
}

export interface SliderControls {
  readonly element: HTMLElement;
  /** Re-read state.sliders; rebuilds only when the set of names changes. */
  refresh(): void;
  /** Stop a running animation. */
  stop(): void;
  dispose(): void;
}

interface Row {
  root: HTMLElement;
  label: HTMLElement;
  range: HTMLInputElement;
  play: HTMLButtonElement;
  min?: HTMLInputElement;
  max?: HTMLInputElement;
  step?: HTMLInputElement;
}

const ANIMATION_MS = 4200;

function quantize(value: number, step: number, min: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  const steps = Math.round((value - min) / step);
  return Number((min + steps * step).toPrecision(12));
}

export function mountSliders(host: HTMLElement, options: SliderControlsOptions): SliderControls {
  const root = element("div", { className: "graph-lab-sliders" });
  const rows = new Map<string, Row>();
  let signature = "";
  let frame: number | undefined;
  let playing: string | undefined;
  let started = 0;
  let disposed = false;

  function syncRow(name: string, row: Row): void {
    const spec = options.state.sliders[name];
    if (!spec) return;
    row.range.min = String(spec.min);
    row.range.max = String(spec.max);
    row.range.step = String(spec.step);
    row.range.value = String(spec.value);
    row.label.textContent = `${name} = ${formatNumber(spec.value, 3)}`;
    if (row.min) row.min.value = String(spec.min);
    if (row.max) row.max.value = String(spec.max);
    if (row.step) row.step.value = String(spec.step);
    row.play.textContent = playing === name ? "⏸" : "▶";
    row.play.setAttribute("aria-label", `${playing === name ? "Pause" : "Play"} slider ${name}`);
    row.play.setAttribute("aria-pressed", String(playing === name));
  }

  function setValue(name: string, value: number): void {
    const spec = options.state.sliders[name];
    if (!spec) return;
    spec.value = Math.max(spec.min, Math.min(spec.max, quantize(value, spec.step, spec.min)));
    const row = rows.get(name);
    if (row) syncRow(name, row);
    options.onChange();
  }

  function stop(): void {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    const previous = playing;
    playing = undefined;
    if (previous) {
      const row = rows.get(previous);
      if (row) syncRow(previous, row);
    }
  }

  function play(name: string): void {
    if (playing === name) { stop(); return; }
    stop();
    const spec = options.state.sliders[name];
    if (!spec) return;
    playing = name;
    started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const tick = (now: number) => {
      if (disposed) return;
      const current = options.state.sliders[name];
      if (!current) { stop(); return; }
      const phase = ((now - started) % ANIMATION_MS) / ANIMATION_MS;
      const fraction = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      setValue(name, current.min + fraction * (current.max - current.min));
      frame = requestAnimationFrame(tick);
    };
    const row = rows.get(name);
    if (row) syncRow(name, row);
    frame = requestAnimationFrame(tick);
  }

  function numberField(name: string, key: "min" | "max" | "step"): HTMLInputElement {
    const input = numberInput("", `${key} of slider ${name}`, { step: "any" });
    input.className = "graph-lab-slider-bound";
    input.addEventListener("change", () => {
      const spec = options.state.sliders[name];
      if (!spec) return;
      const value = Number(input.value);
      if (!Number.isFinite(value)) { syncRow(name, rows.get(name)!); return; }
      if (key === "step" ? value <= 0 : key === "min" ? value >= spec.max : value <= spec.min) {
        syncRow(name, rows.get(name)!);
        return;
      }
      spec[key] = value;
      spec.value = Math.max(spec.min, Math.min(spec.max, spec.value));
      syncRow(name, rows.get(name)!);
      options.onChange();
      options.onCommit?.();
    });
    return input;
  }

  function buildRow(name: string): Row {
    const spec = options.state.sliders[name]!;
    const row = element("div", { className: "graph-lab-slider" });
    const label = element("span", { className: "graph-lab-slider-name" });
    const range = element("input", {
      type: "range", className: "graph-lab-slider-range",
      min: String(spec.min), max: String(spec.max), step: String(spec.step), value: String(spec.value),
    });
    range.setAttribute("aria-label", `Slider ${name}`);
    range.addEventListener("input", () => {
      stop();
      setValue(name, Number(range.value));
      options.onCommit?.();
    });
    const playButton = button("▶", () => play(name), { className: "graph-lab-icon-button graph-lab-slider-play", title: `Animate ${name}` });
    playButton.setAttribute("aria-label", `Play slider ${name}`);
    const top = element("div", { className: "graph-lab-slider-top" }, [label, playButton]);
    const entry: Row = { root: row, label, range, play: playButton };
    row.append(top, range);
    if (options.editable) {
      const bounds = element("div", { className: "graph-lab-slider-bounds" });
      entry.min = numberField(name, "min");
      entry.max = numberField(name, "max");
      entry.step = numberField(name, "step");
      for (const [key, input] of [["min", entry.min], ["max", entry.max], ["step", entry.step]] as const) {
        const field = element("label", { className: "graph-lab-slider-bound-field" }, [
          element("span", { textContent: key }), input,
        ]);
        bounds.append(field);
      }
      row.append(bounds);
    }
    syncRow(name, entry);
    return entry;
  }

  function refresh(): void {
    if (disposed) return;
    const names = Object.keys(options.state.sliders);
    const nextSignature = names.join("|") + (options.editable ? "#e" : "");
    if (nextSignature !== signature) {
      if (playing && !names.includes(playing)) stop();
      signature = nextSignature;
      rows.clear();
      root.replaceChildren();
      for (const name of names) {
        const row = buildRow(name);
        rows.set(name, row);
        root.append(row.root);
      }
    } else {
      for (const name of names) {
        const row = rows.get(name);
        if (row) syncRow(name, row);
      }
    }
    root.hidden = names.length === 0;
  }

  host.append(root);
  refresh();

  return {
    element: root,
    refresh,
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      root.remove();
    },
  };
}
