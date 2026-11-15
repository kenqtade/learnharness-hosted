import * as path from "node:path";
import { PATHS, GRAPH_FORMAT_FILE, RENDER_SETTINGS_FILE } from "../../config.ts";
import packageJson from "../../package.json";
import { emit, subscribe } from "../core/events.ts";
import { createPluginAgentService } from "../agent/plugin-agents.ts";
import { createPluginWorkerService } from "../agent/plugin-workers.ts";
import { registerJobAbort, unregisterJobAbort } from "../agent/subagents/aborts.ts";
import { createPluginAgentRecordStore } from "../store/plugin-agent-records.ts";
import { createPluginTaskRecordStore, readPluginTaskRecord, recoverPluginTaskRecords } from "../store/plugin-task-records.ts";
// HOSTED FORK: the storage seam. On Vercel every file under the data dir
// lives in Convex; the plugin backends get the seam instead of node:fs.
import vfs, { convexMode } from "../store/vfs.ts";
import { keepAlive } from "./keep-alive.ts";
import corePluginIds from "../../core-plugins.json";
import { assertGraphFormat } from "../store/graph-format.ts";
import { createPluginLearningData } from "./plugin-learning.ts";
import { createPluginInference } from "./plugin-inference.ts";
import { createPluginBackgroundTool, recoverPluginBackgroundJob } from "./plugin-background-tools.ts";
import { registerPluginWorkerActivity } from "./plugin-worker-activity.ts";
import { deliverJobResult, setPluginJobRecovery } from "./jobs.ts";
import { createPluginHost, PluginHostError } from "./plugin-host.ts";
import { createPluginTransport, type PluginTransportHost } from "./plugin-transport.ts";
import { createPluginDocumentConverter } from "./plugin-documents.ts";
import type { AgentBuildOptions } from "../agent/teacher-agent.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";

export const pluginDirectory = path.join(/* turbopackIgnore: true */ PATHS.data, "plugins");
// HOSTED FORK: a hosted serverless function freezes once the response is
// sent, so background plugin work must be kept alive explicitly. Locally the
// process stays up and nothing changes.
const hostedRuntime = convexMode || process.env.VERCEL === "1";
/** The longest background plugin task a hosted function may run. */
const HOSTED_WORKER_TIMEOUT_MS = 240_000;
// Explicitly staged by build-server, not discovered by Next's filesystem tracer.
const core = {
	directory: path.join(/* turbopackIgnore: true */ PATHS.root, "core-plugins"),
	dataDirectory: path.join(/* turbopackIgnore: true */ PATHS.data, "core-plugin-data"),
	ids: corePluginIds,
};
const coreData = { directory: core.dataDirectory, ids: core.ids };
type Host = ReturnType<typeof createPluginHost>;
interface Runtime { host: Host; ready: Promise<void> }
interface PluginGlobal { __lhPlugins?: Runtime }

/** Single composition for every Next entry. Importing this module does not load
 * plugin code or touch plugin storage; instrumentation (or a route) initializes it. */
function runtime(): Runtime {
	const global = globalThis as typeof globalThis & PluginGlobal;
	if (global.__lhPlugins) return global.__lhPlugins;
	const learning = createPluginLearningData({
		directory: PATHS.data, chatStore: stores.chatStore, graphStore: stores.graphStore,
		isBusy: isTurnRunning, isCompacting: compactionInFlight,
		readMetadata(name) {
			assertGraphFormat();
			try { return JSON.parse(vfs.readFileSync(name === "format.json" ? GRAPH_FORMAT_FILE : RENDER_SETTINGS_FILE, "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		},
	});
	const installationErrors: Record<string, string> = Object.create(null);
	Object.assign(installationErrors, hostedPluginBlocks()); // HOSTED FORK: never activate code-running plugins
	const host = createPluginHost({
		directory: pluginDirectory, core, appVersion: packageJson.version, installationErrors,
		// The process-global runtime owns one admission slot across all plugins
		// and every separately compiled Next route module.
		convertDocument: createPluginDocumentConverter().convert,
		// HOSTED FORK: only on hosted servers do plugin backends get the
		// storage seam instead of node:fs. Locally there is no hook at all.
		...(convexMode ? { backendFs: vfs } : {}),
		createServices({ manifest, dataDirectory, signal }) {
			const inference = createPluginInference({ signal, dataDirectory });
			const agents = createPluginAgentService({
				store: createPluginAgentRecordStore(path.join(/* turbopackIgnore: true */ dataDirectory, "agents")),
				engineFor: inference.engineFor, onUsage: inference.onUsage, signal,
				onChange: () => { if (!signal.aborted) emit("plugin-message", { pluginId: manifest.id, topic: "agents-changed" }); },
				...(hostedRuntime ? { background: keepAlive } : {}),
			});
			const workerActivity = registerPluginWorkerActivity({
				pluginId: manifest.id, pluginName: manifest.name, signal,
				cancel: taskId => workers.cancel(taskId),
			});
			const workers = createPluginWorkerService({
				store: createPluginTaskRecordStore(path.join(/* turbopackIgnore: true */ dataDirectory, "tasks")),
				engineFor: inference.engineFor, onUsage: inference.onUsage, signal,
				onChange: workerActivity,
				...(hostedRuntime ? { background: keepAlive, maxTimeoutMs: HOSTED_WORKER_TIMEOUT_MS } : {}),
			});
			return { learning, inference: inference.inference, agents, workers,
				createBackgroundTool(context, definition) {
					return createPluginBackgroundTool({
						pluginId: manifest.id, context, definition, workers, signal, jobStore: stores.jobStore,
						deliver: deliverJobResult, isActive: () => !signal.aborted,
						registerAbort: registerJobAbort, unregisterAbort: unregisterJobAbort,
					});
				},
			};
		},
		subscribeEvents: subscribe,
		onChange: () => emit("plugins-changed", {}),
		onNotification: (notification) => emit("plugin-message", notification),
	});
	// Defer recovery/activation until the process-wide holder is published.
	const ready = Promise.resolve().then(async () => {
		setPluginJobRecovery(job => recoverPluginBackgroundJob(job, {
			jobStore: stores.jobStore, deliver: deliverJobResult,
			readTask: (pluginId, taskId, requestId) => readPluginTaskRecord(pluginDirectory, pluginId, taskId, requestId, coreData),
			registerAbort: registerJobAbort, unregisterAbort: unregisterJobAbort,
		}));
		// Exclusive bootstrap sweep, including disabled packages whose services
		// will not construct. Read-only job recovery never activates plugin code.
		for (const [id, error] of Object.entries(recoverPluginTaskRecords(pluginDirectory, coreData))) {
			installationErrors[id] = `Task recovery failed: ${error}`;
		}
		await host.initialize();
	});
	global.__lhPlugins = { host, ready };
	return global.__lhPlugins;
}

/** HOSTED GATE (merge of upstream v0.6.0, 2026-11-11). Plugins are trusted
 *  LOCAL code, not sandboxed: core Coding Questions runs tutor/learner tests
 *  with the server's permissions, and community plugins run arbitrary code.
 *  On a hosted server (LH_PROFILE=hosted — every account shares the machine,
 *  and serverless disks are per-instance and ephemeral) that is remote code
 *  execution for any member, so the platform stays OFF there unless the
 *  operator opts in with LH_PLUGINS=1. Desktop/local: unchanged. Every caller
 *  already treats an unavailable host as "native lesson only". */
export function pluginsAllowed(env: Record<string, string | undefined> = process.env): boolean {
	// HOSTED FORK (core plugins, 2026-11): a plugin backend is ONE server-wide
	// activation with ONE data folder — not per account. With accounts on,
	// members would share each other's plugin data (decks, settings), so a
	// multi-user deployment keeps the platform off unless the operator
	// explicitly accepts that with LH_PLUGINS_MULTI_USER=1.
	if (env.LH_MULTI_USER === "1" && env.LH_PLUGINS_MULTI_USER !== "1") return false;
	if (env.LH_PLUGINS === "1") return true;
	if (env.LH_PLUGINS === "0") return false;
	return env.LH_PROFILE?.trim() !== "hosted";
}
/** HOSTED FORK (core plugins, 2026-11): Core plugins that execute programs
 *  on the server stay unavailable on a hosted deployment even when the
 *  platform is on. Coding Questions runs tutor/learner tests as processes with
 *  the server's permissions — and the server's environment holds deployment
 *  secrets. LH_PLUGINS_ALLOW_CODE=1 lifts it (operator's explicit choice). */
export const HOSTED_CODE_PLUGINS = ["coding-questions"] as const;
export const HOSTED_CODE_PLUGIN_MESSAGE = "Not available on this hosted server: it runs programs on the server, which would expose the deployment's secrets.";
export function hostedPluginBlocks(env: Record<string, string | undefined> = process.env): Record<string, string> {
	if (env.LH_PROFILE?.trim() !== "hosted" || env.LH_PLUGINS_ALLOW_CODE === "1") return {};
	return Object.fromEntries(HOSTED_CODE_PLUGINS.map(id => [id, HOSTED_CODE_PLUGIN_MESSAGE]));
}
export const PLUGINS_OFF_MESSAGE = "Plugins are turned off on this hosted server: plugin code (including coding-question tests) would run on the server for every account. The operator can allow them with LH_PLUGINS=1.";
const refuse = (): never => { throw new PluginHostError(503, PLUGINS_OFF_MESSAGE); };
/** What the plugin routes talk to when the platform is off: an empty catalog. */
export const disabledPluginHost: PluginTransportHost = {
	list: () => [], conflicts: () => [], refresh: async () => {},
	setEnabled: async () => refuse(), call: async () => refuse(),
	convertDocument: async () => refuse(), asset: () => refuse(),
};

export async function initializePlugins(): Promise<void> {
	if (!pluginsAllowed()) return;
	await runtime().ready;
}
export async function getPluginHost(): Promise<Host> {
	if (!pluginsAllowed()) refuse();
	const { host, ready } = runtime();
	await ready;
	return host;
}
/** Await startup once; actual factories run synchronously during per-turn Agent construction. */
export async function getPluginAgentContributions(): Promise<NonNullable<AgentBuildOptions["pluginContributions"]>> {
	return (await getPluginHost()).agentContributions;
}
/** Await startup before reading canonical truth; the returned resolver itself is synchronous. */
export async function getPluginQuestionTypeResolver(): Promise<Host["resolveQuestionType"]> {
	return (await getPluginHost()).resolveQuestionType;
}
export const pluginTransport = createPluginTransport({
	getHost: async () => (pluginsAllowed() ? getPluginHost() : disabledPluginHost),
	get directory() { return pluginsAllowed() ? pluginDirectory : ""; },
});
