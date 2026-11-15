// TRACK A — Graph Lab frontend. Replace this stub (see docs/exam-prep-design.md §1).
import type { PluginFrontendContext } from "learnharness-plugin-api";

export function activate(ctx: PluginFrontendContext): void {
  ctx.registerView({ id: "lab", name: "Graph Lab", mount(container) { container.textContent = "Graph Lab — coming soon."; } });
  ctx.registerAction({ id: "open-lab", name: "Graph Lab", run: () => ctx.app.openView("lab") });
  ctx.placeAction({ id: "sidebar-lab", actionId: "open-lab", location: "sidebar" });
}
