// Graph Lab — frontend entry: the Lab view, the sidebar action, the ```graph
// code block and the plugin settings (default mode, degrees).
import type {
  PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle,
} from "learnharness-plugin-api";
import type { GraphMode } from "./engine/state.ts";
import { mountLab } from "./ui/lab.ts";
import { mountGraphBlock } from "./ui/block.ts";

interface Settings {
  revision?: number;
  defaultMode: GraphMode;
  degrees: boolean;
}

const MODES: { value: GraphMode; label: string }[] = [
  { value: "2d", label: "2D graphing" },
  { value: "complex", label: "Complex plane" },
  { value: "matrix", label: "Matrix" },
  { value: "3d", label: "3D surface" },
];

function parseSettings(value: unknown): Settings {
  const raw = (value ?? {}) as Partial<Settings>;
  const mode = MODES.some(entry => entry.value === raw.defaultMode) ? raw.defaultMode! : "2d";
  return {
    ...(typeof raw.revision === "number" ? { revision: raw.revision } : {}),
    defaultMode: mode,
    degrees: raw.degrees === true,
  };
}

export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  const cleanups: (() => void)[] = [];
  cleanups.push(ctx.registerView({
    id: "lab",
    name: "Graph Lab",
    mount(container, signal) { return mountLab(container, ctx, signal); },
  }));
  cleanups.push(ctx.registerAction({
    id: "open-lab",
    name: "Graph Lab",
    run: () => ctx.app.openView("lab"),
  }));
  cleanups.push(ctx.placeAction({ id: "sidebar-lab", actionId: "open-lab", location: "sidebar" }));
  cleanups.push(ctx.registerCodeBlock({
    language: "graph",
    mount(container, block) { return mountGraphBlock(container, block, ctx); },
  }));

  let disposed = false;
  let current: Settings = { defaultMode: "2d", degrees: false };
  let registration: PluginWidgetHandle<PluginSettingsSchema> | undefined;

  const rows = (value: Settings): PluginSettingsSchema["rows"] => [
    {
      key: "defaultMode", type: "dropdown", label: "Default mode", value: value.defaultMode,
      options: MODES.map(entry => ({ value: entry.value, label: entry.label })),
      description: "The tab Graph Lab opens on. Existing graphs keep their own mode.",
      async onChange(defaultMode) { await save({ defaultMode: defaultMode as GraphMode }); },
    },
    {
      key: "degrees", type: "toggle", label: "Degrees", value: value.degrees,
      description: "Interpret sin, cos and tan arguments in degrees in new graphs.",
      async onChange(degrees) { await save({ degrees }); },
    },
  ];

  function apply(value: unknown): void {
    if (disposed || ctx.signal.aborted) return;
    const next = parseSettings(value);
    if (current.revision !== undefined && next.revision !== undefined && next.revision < current.revision) return;
    current = next;
    if (registration) registration.update({ rows: rows(current) });
    else registration = ctx.registerSettings({ rows: rows(current) });
  }

  async function save(patch: Partial<Pick<Settings, "defaultMode" | "degrees">>): Promise<void> {
    const accepted = await ctx.call("settings.set", patch);
    apply(accepted);
  }

  try {
    apply(await ctx.call("settings.get"));
  } catch (error) {
    if (!disposed && !ctx.signal.aborted) console.error("Graph Lab settings could not be read.", error);
    apply(current);
  }
  cleanups.push(ctx.onNotification(event => {
    if (event.pluginId === ctx.manifest.id && event.topic === "settings-changed") apply(event.data);
  }));

  return () => {
    if (disposed) return;
    disposed = true;
    registration?.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
