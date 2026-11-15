// TRACK C — Exam Simulator view. Replace this stub (see docs/exam-prep-design.md §2.3).
import type { PluginFrontendContext } from "learnharness-plugin-api";

export function activateSimFrontend(ctx: PluginFrontendContext): void {
  ctx.registerView({ id: "exams", name: "Exam Simulator", mount(container) { container.textContent = "Exam Simulator — coming soon."; } });
  ctx.registerAction({ id: "open-exams", name: "Exam Simulator", run: () => ctx.app.openView("exams") });
  ctx.placeAction({ id: "sidebar-exams", actionId: "open-exams", location: "sidebar" });
}
