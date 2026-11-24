import { test } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { buildRequest, dispatch, matchRoute, serializeResponse, type RouteEntry } from "../convex/node/bridge.ts";

const origin = "https://demo.convex.site";

function decode(bodyBase64: string): string {
	return Buffer.from(bodyBase64, "base64").toString("utf8");
}

const routes: RouteEntry[] = [
	{
		pattern: "/api/chats/[id]/steer",
		methods: ["POST"],
		params: ["id"],
		module: {
			POST: async (request: Request, context: { params: Promise<{ id: string }> }) => {
				const { id } = await context.params;
				const response = NextResponse.json({ id, method: request.method, url: request.url, body: await request.text() });
				response.headers.append("set-cookie", "lh_session=first; Path=/");
				response.headers.append("set-cookie", "lh_theme=dark; Path=/");
				return response;
			},
		},
	},
	{
		pattern: "/api/plugins/[id]/assets/[...file]",
		methods: ["GET"],
		params: ["id", "file"],
		module: {
			GET: async (_request: Request, context: { params: Promise<{ id: string; file: string[] }> }) =>
				Response.json(await context.params),
		},
	},
	{
		pattern: "/api/version",
		methods: ["GET"],
		params: [],
		module: { GET: () => new Response("ok") },
	},
];

test("matchRoute decodes single and catch-all params, and rejects unknown paths", () => {
	assert.deepEqual(matchRoute("/api/chats/a%20b/steer", routes)?.params, { id: "a b" });
	assert.deepEqual(matchRoute("/api/plugins/flashcards/assets/js/index.js", routes)?.params, {
		id: "flashcards",
		file: ["js", "index.js"],
	});
	assert.equal(matchRoute("/api/chats/a/other", routes), null);
});

test("buildRequest preserves method, headers, query, body and the Convex site origin", () => {
	const request = buildRequest({
		method: "POST",
		path: "/api/chats/chat-1/steer",
		query: "?source=test",
		headers: [{ name: "host", value: "demo.convex.site" }, { name: "content-type", value: "text/plain" }],
		bodyBase64: Buffer.from("hello").toString("base64"),
	}, origin);
	assert.equal(request.method, "POST");
	assert.equal(request.url, `${origin}/api/chats/chat-1/steer?source=test`);
	assert.equal(request.headers.get("host"), "demo.convex.site");
	assert.equal(request.headers.get("content-type"), "text/plain");
	return request.text().then((body) => assert.equal(body, "hello"));
});

test("dispatch calls the handler with resolved params and serializes NextResponse and repeated cookies", async () => {
	const result = await dispatch({
		method: "POST",
		path: "/api/chats/chat-1/steer",
		query: "",
		headers: [{ name: "content-type", value: "text/plain" }],
		bodyBase64: Buffer.from("steer me").toString("base64"),
	}, routes, { origin });
	assert.equal(result.status, 200);
	const body = JSON.parse(decode(result.bodyBase64)) as { id: string; method: string; url: string; body: string };
	assert.deepEqual(body, {
		id: "chat-1",
		method: "POST",
		url: `${origin}/api/chats/chat-1/steer`,
		body: "steer me",
	});
	assert.deepEqual(result.headers.filter((header) => header.name === "set-cookie").map((header) => header.value), [
		"lh_session=first; Path=/",
		"lh_theme=dark; Path=/",
	]);
});

test("dispatch reports unknown routes, unsupported methods and failing handlers without leaking errors", async () => {
	const unknown = await dispatch({ method: "GET", path: "/api/nope", query: "", headers: [] }, routes, { origin });
	assert.equal(unknown.status, 404);
	const wrongMethod = await dispatch({ method: "DELETE", path: "/api/version", query: "", headers: [] }, routes, { origin });
	assert.equal(wrongMethod.status, 405);
	const failing = await dispatch({
		method: "GET",
		path: "/api/version",
		query: "",
		headers: [],
	}, [
		{
			pattern: "/api/version",
			methods: ["GET"],
			params: [],
			module: { GET: () => { throw new Error("super-secret-value"); } },
		},
	], { origin });
	assert.equal(failing.status, 500);
	assert(!decode(failing.bodyBase64).includes("super-secret-value"));
});

test("serializeResponse handles an empty body and plain Response", async () => {
	const result = await serializeResponse(new Response(null, { status: 204 }));
	assert.equal(result.status, 204);
	assert.equal(result.bodyBase64, "");
	assert(result.headers.every((header) => header.name !== "set-cookie"));
});
