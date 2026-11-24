import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = path.join(root, "app", "api");
const generated = fs.readFileSync(path.join(root, "convex", "node", "routes.gen.ts"), "utf8");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function routeFiles(): string[] {
	const result: string[] = [];
	function visit(directory: string) {
		for (const name of fs.readdirSync(directory).sort()) {
			const filename = path.join(directory, name);
			const stat = fs.lstatSync(filename);
			if (stat.isDirectory()) visit(filename);
			else if (name === "route.ts") result.push(filename);
		}
	}
	visit(apiRoot);
	return result;
}

function patternFor(filename: string): string {
	const relative = path.relative(apiRoot, filename).split(path.sep).join("/");
	const routePath = `/${relative.slice(0, -"/route.ts".length)}`.replace(/\/$/, "");
	return `/api${routePath}`;
}

function methodsFor(filename: string): string[] {
	const source = fs.readFileSync(filename, "utf8");
	return METHODS.filter((method) => new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`).test(source));
}

const patterns = [...generated.matchAll(/^\t\tpattern: ("(?:[^"\\]|\\.)*"),$/gm)].map((match) => JSON.parse(match[1]!) as string);
const methods = [...generated.matchAll(/^\t\tmethods: \[([^\]]*)\],$/gm)]
	.map((match) => [...match[1]!.matchAll(/"([A-Z]+)"/g)].map((method) => method[1]!));
const params = [...generated.matchAll(/^\t\tparams: \[([^\]]*)\],$/gm)]
	.map((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((param) => param[1]!));

test("generated Convex route table covers every app/api route exactly once", () => {
	assert.equal(patterns.length, routeFiles().length);
	assert.deepEqual([...patterns].sort(), routeFiles().map(patternFor).sort());
	assert.equal(new Set(patterns).size, patterns.length);
	assert(patterns.every((pattern) => pattern === "/api" || pattern.startsWith("/api/")));
});

test("generated methods and params match the exported handlers and dynamic segments", () => {
	const byPattern = new Map(patterns.map((pattern, index) => [pattern, { methods: methods[index], params: params[index] }]));
	for (const filename of routeFiles()) {
		const entry = byPattern.get(patternFor(filename));
		assert(entry, `missing generated entry for ${filename}`);
		assert.deepEqual(entry.methods, methodsFor(filename), filename);
		assert.deepEqual(entry.params, patternFor(filename).split("/").filter((segment) => segment.startsWith("[") && segment.endsWith("]"))
			.map((segment) => segment.replace(/^\[(\.\.\.)?/, "").replace(/\]$/, "")), filename);
		for (const param of entry.params) assert.match(param, /^[A-Za-z0-9_]+$/, filename);
	}
});

test("generated route table is a Node-only module", () => {
	assert(generated.startsWith("\"use node\";"), "routes.gen.ts must stay in the Node bundle");
});
