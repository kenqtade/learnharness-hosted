import { httpRouter, type RoutableMethod } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { version } from "./version";

const MAX_BRIDGED_BODY_BYTES = 3 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 8192) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

const bridge = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
	const bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
	if (bytes.byteLength > MAX_BRIDGED_BODY_BYTES) {
		return Response.json({ error: "Request body too large for Convex bridge" }, { status: 413 });
	}
	const result = await ctx.runAction(internal.node.api.handle, {
		method: request.method as RoutableMethod,
		path: url.pathname,
		query: url.search,
		headers: [...request.headers].map(([name, value]) => ({ name, value })),
		bodyBase64: hasBody ? toBase64(bytes) : undefined,
	});
	const headers = new Headers();
	for (const header of result.headers) headers.append(header.name, header.value);
	const body = result.bodyBase64 && result.status !== 204 && result.status !== 304
		? fromBase64(result.bodyBase64)
		: null;
	return new Response(body, { status: result.status, headers });
});

const http = httpRouter();

http.route({ path: "/api/version", method: "GET", handler: version });

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
	http.route({ pathPrefix: "/api/", method, handler: bridge });
}

export default http;
