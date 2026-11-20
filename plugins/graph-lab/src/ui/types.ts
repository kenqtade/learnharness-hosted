// Graph Lab UI — shared contracts between the Lab view and its mode panels.
import type { GraphState } from "../engine/state.ts";

export interface PanelOptions {
  state: GraphState;
  signal: AbortSignal;
  /** Something the learner would want saved changed (text, colour, view…). */
  onChange(): void;
}

export type PanelMount = (host: HTMLElement, options: PanelOptions) => () => void;
