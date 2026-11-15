// TRACK B — Question Bank backend. Replace this stub (see docs/exam-prep-design.md §2.2).
import type { PluginBackendContext } from "learnharness-plugin-api";
import type { BankApi } from "../shared/contract.ts";

export function activateBankBackend(_ctx: PluginBackendContext): BankApi {
  return {
    query: () => [], get: () => [], skills: () => [], upsertSkills: () => {},
    author: () => { throw new Error("Question authoring is not built yet."); },
    job: () => undefined, recordResponses: () => {},
  };
}
