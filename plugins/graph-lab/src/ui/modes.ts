// Graph Lab UI — mount one mode panel. Shared by the full view and code blocks.
import { mount2D } from "./panel-2d.ts";
import { mountComplex } from "./panel-complex.ts";
import { mountMatrix } from "./panel-matrix.ts";
import { mountSurface } from "./panel-surface.ts";
import { mountCalculatorPanel } from "./panel-calculator.ts";
import type { PanelOptions } from "./types.ts";

export type LabTab = "2d" | "complex" | "matrix" | "3d" | "calculator";

export function mountModePanel(tab: LabTab, host: HTMLElement, options: PanelOptions): () => void {
  switch (tab) {
    case "complex": return mountComplex(host, options);
    case "matrix": return mountMatrix(host, options);
    case "3d": return mountSurface(host, options);
    case "calculator": return mountCalculatorPanel(host, options);
    default: return mount2D(host, options);
  }
}
