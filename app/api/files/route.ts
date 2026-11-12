import { withStore, createUploadUrl, commitUpload, deleteUpload, listUploads, uploadsEnabled } from "@/src/server";

/**
 * HOSTED FORK — /api/files: the metadata side of learner uploads.
 *
 * Blob bytes never pass through this route (Vercel caps a request body at
 * 4.5 MB): POST {action:"upload-url"} returns a Convex upload URL, the
 * browser PUTs the file straight to storage, then POST {action:"commit"}
 * verifies the blob and records it in this user's index. withStore runs the
 * request inside the signed-in user's scope (routeAccess: ordinary user).
 *
 *   GET              → { enabled, files }
 *   POST upload-url  → { url }
 *   POST commit      → { id, name, size, path }
 *   DELETE ?id=      → { ok }
 *
 * When uploads are not offered (desktop / local), GET says
 * {enabled:false} and every mutating verb is 404.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const disabled = () => Response.json({ enabled: false }, { status: 404, headers: NO_STORE });

async function body(request: Request): Promise<Record<string, unknown>> {
	try {
		const parsed = await request.json();
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

async function GET_handler() {
	if (!uploadsEnabled()) return Response.json({ enabled: false }, { headers: NO_STORE });
	return Response.json({ enabled: true, files: listUploads() }, { headers: NO_STORE });
}

async function POST_handler(request: Request) {
	if (!uploadsEnabled()) return disabled();
	const payload = await body(request);
	if (payload.action === "upload-url") {
		try {
			return Response.json({ url: await createUploadUrl() }, { headers: NO_STORE });
		} catch (error) {
			return Response.json({ error: (error as Error).message }, { status: 502, headers: NO_STORE });
		}
	}
	if (payload.action === "commit") {
		const storageId = typeof payload.storageId === "string" ? payload.storageId : "";
		if (!storageId) return Response.json({ error: "The upload is missing its storage id." }, { status: 400, headers: NO_STORE });
		try {
			const entry = await commitUpload({ storageId, name: typeof payload.name === "string" ? payload.name : "" });
			return Response.json(entry, { headers: NO_STORE });
		} catch (error) {
			return Response.json({ error: (error as Error).message }, { status: 400, headers: NO_STORE });
		}
	}
	return Response.json({ error: "Unknown upload action." }, { status: 400, headers: NO_STORE });
}

async function DELETE_handler(request: Request) {
	if (!uploadsEnabled()) return disabled();
	const id = new URL(request.url).searchParams.get("id") ?? "";
	if (!id) return Response.json({ error: "Missing file id." }, { status: 400, headers: NO_STORE });
	const ok = await deleteUpload(id);
	return Response.json({ ok }, { status: ok ? 200 : 404, headers: NO_STORE });
}

export const GET = withStore(GET_handler);
export const POST = withStore(POST_handler);
export const DELETE = withStore(DELETE_handler);
