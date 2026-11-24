import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = path.join(root, "app", "api");
const output = path.join(root, "convex", "node", "routes.gen.ts");

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function routeFiles() {
	const result = [];
	function visit(directory) {
		for (const name of fs.readdirSync(directory).sort()) {
			const filename = path.join(directory, name);
			const stat = fs.lstatSync(filename);
			if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in app/api: ${filename}`);
			if (stat.isDirectory()) visit(filename);
			else if (name === "route.ts") result.push(filename);
		}
	}
	visit(apiRoot);
	return result;
}

export function routePattern(filename) {
	const relative = path.relative(apiRoot, filename).split(path.sep).join("/");
	if (!relative.endsWith("/route.ts")) throw new Error(`Not a route file: ${filename}`);
	const routePath = `/${relative.slice(0, -"/route.ts".length)}`.replace(/\/$/, "");
	return `/api${routePath}`;
}

export function routeParams(pattern) {
	return pattern.split("/").filter((segment) => segment.startsWith("[") && segment.endsWith("]"))
		.map((segment) => segment.replace(/^\[(\.\.\.)?/, "").replace(/\]$/, ""));
}

export function exportedMethods(filename) {
	const source = fs.readFileSync(filename, "utf8");
	return METHODS.filter((method) => new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`).test(source));
}

export function generate() {
	const files = routeFiles();
	const entries = files.map((filename, index) => {
		const pattern = routePattern(filename);
		const methods = exportedMethods(filename);
		if (methods.length === 0) throw new Error(`No HTTP methods exported by ${filename}`);
		let modulePath = path.relative(path.dirname(output), filename).split(path.sep).join("/");
		if (!modulePath.startsWith(".")) modulePath = `./${modulePath}`;
		return { alias: `route${index}`, modulePath: modulePath.replace(/\.ts$/, ""), pattern, methods, params: routeParams(pattern) };
	});
	const seen = new Set();
	for (const entry of entries) {
		if (seen.has(entry.pattern)) throw new Error(`Duplicate route pattern: ${entry.pattern}`);
		seen.add(entry.pattern);
	}
	const lines = ["\"use node\";", "", "import type { RouteEntry } from \"./bridge\";", ""];
	for (const entry of entries) lines.push(`import * as ${entry.alias} from ${JSON.stringify(entry.modulePath)};`);
	lines.push("", "export const routes: readonly RouteEntry[] = [");
	for (const entry of entries) {
		lines.push("\t{");
		lines.push(`\t\tpattern: ${JSON.stringify(entry.pattern)},`);
		lines.push(`\t\tmethods: [${entry.methods.map((method) => JSON.stringify(method)).join(", ")}],`);
		lines.push(`\t\tparams: [${entry.params.map((param) => JSON.stringify(param)).join(", ")}],`);
		lines.push(`\t\tmodule: ${entry.alias},`);
		lines.push("\t},");
	}
	lines.push("];", "");
	return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const source = generate();
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, source);
	process.stdout.write(`convex:routes: wrote ${routeFiles().length} routes to ${path.relative(root, output)}\n`);
}
