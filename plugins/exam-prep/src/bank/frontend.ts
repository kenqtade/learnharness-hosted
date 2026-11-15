// TRACK B — Question Bank view. Replace this stub (see docs/exam-prep-design.md §2.2).
import type { PluginFrontendContext } from "learnharness-plugin-api";

export function activateBankFrontend(ctx: PluginFrontendContext): void {
  ctx.registerView({ id: "bank", name: "Question Bank", mount(container) { container.textContent = "Question Bank — coming soon."; } });
  ctx.registerAction({ id: "open-bank", name: "Question Bank", run: () => ctx.app.openView("bank") });
  ctx.placeAction({ id: "sidebar-bank", actionId: "open-bank", location: "sidebar" });
}
