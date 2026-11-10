import { withStore } from "@/src/server";
/**
 * POST-less BYOK mint: the renderer never holds the real Deepgram key.
 *
 * The key lives server-side only (auth.json → process.env in the desktop
 * app; .env.local in dev — same seam as OPENROUTER_API_KEY). A dictation
 * run starts here: mint a short-lived access token (TTL 300s — a run can
 * outlast the 30s default), the renderer opens its WebSocket to Deepgram
 * with it, and audio flows renderer → Deepgram directly, never through
 * this server. The token is only checked at the WebSocket handshake, so
 * long dictation sessions survive the TTL fine (Deepgram docs).
 *
 * NOTE: the key needs ≥ Member permission in the Deepgram console to call
 * /auth/grant (their docs, token-based auth FAQ) — plain read/transcribe
 * keys return FORBIDDEN here.
 */
import { keyValue } from "@/src/server";

async function GET_handler() {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) {
		// 200 + keyless, not 503: the page pre-mints on every load, and "no
		// key configured" is a normal state, not a server error (it showed
		// up as a red console error on every page — the open /api/stt/token
		// bug). dictation.tsx maps `keyless` to its short "needs a key" line.
		return Response.json(
			{ keyless: true, message: "No DEEPGRAM_API_KEY — add it in Settings → Keys." },
			{ status: 200 },
		);
	}

	try {
		const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
		});
		if (!res.ok) {
			const detail = await res.text();
			return Response.json(
				{ message: `Deepgram token grant failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			return Response.json({ message: "Deepgram grant returned no token" }, { status: 502 });
		}
		return Response.json({ token: data.access_token });
	} catch {
		return Response.json({ message: "Deepgram unreachable" }, { status: 502 });
	}
}

// convex-store: refresh before, save to Convex before replying (src/server/store-ready.ts)
export const GET = withStore(GET_handler);
