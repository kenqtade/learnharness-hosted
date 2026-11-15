"use strict";
// Shipped as a real file, NOT imported into the Next module graph. Both this
// sidecar and plugin entrypoints are opened by Node's native createRequire.
const { createRequire } = require("node:module");
const { isAbsolute, sep } = require("node:path");
const Module = require("node:module");

// HOSTED FORK: a plugin backend that requires "node:fs" writes to the
// serverless instance disk — ephemeral, per instance, lost on the next cold
// start. The host can hand the backend the storage seam instead: this hook
// answers those requires with the host's object, but ONLY for modules inside
// a registered plugin package. Every other module keeps node:fs, so the app
// itself is untouched.
const pluginFilesystems = new Map(); // package directory → the fs object the host provided
let hookInstalled = false;

function inside(directory, filename) {
	return filename === directory || filename.startsWith(directory + sep);
}

function install() {
	if (hookInstalled) return;
	hookInstalled = true;
	const load = Module._load;
	Module._load = function (request, parent) {
		if ((request === "fs" || request === "node:fs") && parent && typeof parent.filename === "string") {
			for (const [directory, filesystem] of pluginFilesystems) {
				if (inside(directory, parent.filename)) return filesystem;
			}
		}
		return load.apply(this, arguments);
	};
}

/**
 * Load a plugin entrypoint.
 *
 * options.backendFs: the fs-compatible object the backend's own "fs" and
 *   "node:fs" requires resolve to (the storage seam on hosted servers).
 * options.packageDirectory: the package the entrypoint belongs to — the hook
 *   only answers for modules inside it.
 */
exports.load = function load(filename, options) {
	if (!isAbsolute(filename)) throw new Error("Plugin entrypoint must be absolute");
	if (options && options.backendFs) {
		if (!options.packageDirectory) throw new Error("A plugin package directory is required for the fs hook");
		pluginFilesystems.set(options.packageDirectory, options.backendFs);
		install();
	}
	// Keep Node's cache: toggling creates a fresh activation, not a code reload.
	return createRequire(filename)(filename);
};
