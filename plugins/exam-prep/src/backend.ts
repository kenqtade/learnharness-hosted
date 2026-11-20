// Exam Prep backend entry (integration owner). The simulator reads the bank
// through the BankApi contract only (src/shared/contract.ts).
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activateBankBackend } from "./bank/backend.ts";
import { activateSimBackend } from "./sim/backend.ts";

export function activate(ctx: PluginBackendContext): void {
  const bank = activateBankBackend(ctx);
  activateSimBackend(ctx, bank);
}
