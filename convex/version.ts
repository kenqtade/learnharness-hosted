import { httpAction } from "./_generated/server";
import packageMetadata from "../package.json" with { type: "json" };

export const version = httpAction(async () => {
	const buildId = process.env.LH_BUILD_ID || process.env.VERCEL_DEPLOYMENT_ID || "dev";
	return new Response(JSON.stringify({ version: packageMetadata.version, buildId }), {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
});
