"use node";

/** Pure plumbing shared by the Convex Node bridge and its unit tests. */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export type HeaderPair = { name: string; value: string };

export type RouteParams = Record<string, string | string[]>;

export type RouteHandler = (
	request: Request,
	context: { params: Promise<RouteParams> },
) => unknown | Promise<unknown>;

export type RouteModule = Readonly<Record<string, unknown>>;

export type RouteEntry = {
	pattern: string;
	methods: readonly HttpMethod[];
	params: readonly string[];
	module: RouteModule;
};

export type BridgeArgs = {
	method: HttpMethod;
	path: string;
	query: string;
	headers: readonly HeaderPair[];
	bodyBase64?: string;
};

export type BridgeResponse = {
	status: number;
	headers: HeaderPair[];
	bodyBase64: string;
};

export type RouteMatch = { route: RouteEntry; params: RouteParams };

const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

function escapeLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a Next-style route pattern, decoding path params exactly once. */
export function matchRoute(pathname: string, routes: readonly RouteEntry[]): RouteMatch | null {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	for (const route of routes) {
		const parts = route.pattern.split("/").slice(1);
		const source = `^/${parts.map((part) => {
			if (part.startsWith("[...") && part.endsWith("]")) return "((?:[^/]+/)*[^/]+)";
			if (part.startsWith("[") && part.endsWith("]")) return "([^/]+)";
			return escapeLiteral(part);
		}).join("/")}/?$`;
		const found = new RegExp(source).exec(path);
		if (!found) continue;
		const params: RouteParams = {};
		try {
			route.params.forEach((name, index) => {
				const raw = found[index + 1] ?? "";
				params[name] = route.pattern.includes(`[...${name}]`) ? raw.split("/").map(decodeURIComponent) : decodeURIComponent(raw);
			});
		} catch {
			return null;
		}
		return { route, params };
	}
	return null;
}

/** Rebuild the Web Request the original route handler would have received. */
export function buildRequest(
	args: BridgeArgs,
	origin: string | undefined = process.env.CONVEX_SITE_URL ?? "https://convex.site",
): Request {
	const query = args.query.startsWith("?") ? args.query : args.query ? `?${args.query}` : "";
	const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
	const headers = new Headers();
	for (const header of args.headers) headers.append(header.name, header.value);
	const body = args.method === "GET" || args.method === "OPTIONS" || !args.bodyBase64
		? null
		: Uint8Array.from(atob(args.bodyBase64), (character) => character.charCodeAt(0));
	return new Request(new URL(`${path}${query}`, origin), {
		method: args.method,
		headers,
		body,
	});
}

function jsonResponse(status: number, body: unknown): BridgeResponse {
	return {
		status,
		headers: [{ name: "content-type", value: "application/json; charset=utf-8" }],
		bodyBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
	};
}

function isResponseLike(value: unknown): value is Response {
	return typeof value === "object" && value !== null && "status" in value && "headers" in value &&
		typeof (value as Response).arrayBuffer === "function";
}

/** Serialize every header (including repeated Set-Cookie) and the body. */
export async function serializeResponse(response: Response): Promise<BridgeResponse> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_RESPONSE_BYTES) return jsonResponse(502, { error: "Response too large for Convex HTTP action" });
	const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	const cookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
	const headers: HeaderPair[] = [];
	response.headers.forEach((value, name) => {
		if (name.toLowerCase() === "set-cookie") {
			if (cookies.length === 0) headers.push({ name, value });
			return;
		}
		headers.push({ name, value });
	});
	for (const cookie of cookies) headers.push({ name: "set-cookie", value: cookie });
	return { status: response.status, headers, bodyBase64: Buffer.from(bytes).toString("base64") };
}

/** Dispatch one bridged request to the generated route table. */
export async function dispatch(
	args: BridgeArgs,
	routes: readonly RouteEntry[],
	options: { origin?: string } = {},
): Promise<BridgeResponse> {
	const match = matchRoute(args.path, routes);
	if (!match) return jsonResponse(404, { error: "Unknown API route" });
	const handler = match.route.module[args.method];
	if (typeof handler !== "function") return jsonResponse(405, { error: "Method not allowed" });
	try {
		const request = buildRequest(args, options.origin);
		const result = await (handler as RouteHandler)(request, { params: Promise.resolve(match.params) });
		if (!isResponseLike(result)) return jsonResponse(500, { error: "Route handler did not return a Response" });
		return await serializeResponse(result);
	} catch {
		// Never echo an error string: it may contain a secret from a server module.
		return jsonResponse(500, { error: "Bridge handler failed" });
	}
}
