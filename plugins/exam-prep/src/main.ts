// Exam Prep frontend entry (integration owner). Each part registers its own views.
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { activateBankFrontend } from "./bank/frontend.ts";
import { activateSimFrontend } from "./sim/frontend.ts";

export function activate(ctx: PluginFrontendContext): void {
  activateBankFrontend(ctx);
  activateSimFrontend(ctx);
}
