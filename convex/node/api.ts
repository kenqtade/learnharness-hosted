"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { dispatch, type BridgeResponse } from "./bridge";
import { routes } from "./routes.gen";

const header = v.object({ name: v.string(), value: v.string() });

export const handle = internalAction({
	args: {
		method: v.union(
			v.literal("GET"),
			v.literal("POST"),
			v.literal("PUT"),
			v.literal("PATCH"),
			v.literal("DELETE"),
			v.literal("OPTIONS"),
		),
		path: v.string(),
		query: v.string(),
		headers: v.array(header),
		bodyBase64: v.optional(v.string()),
	},
	returns: v.object({
		status: v.number(),
		headers: v.array(header),
		bodyBase64: v.string(),
	}),
	handler: async (_ctx, args): Promise<BridgeResponse> => dispatch(args, routes),
});
