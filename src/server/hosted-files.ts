/**
 * HOSTED FORK — the learner filesystem on a hosted deployment.
 *
 * Upstream's learner file tools (read / ls / find / grep, show_image, the
 * learner-image loader, the pdf job and the PDF reader) all resolve paths
 * through ONE choke point — fs-shared `resolveSourcePath` /
 * `sourceSearchRoots` → file-access `guardSourcePath(policy)` — against
 * the SERVER's filesystem. On a desktop that is the learner's own machine.
 * On a hosted deployment it is the shared function container: its process
 * environment (`/proc/self/environ` holds the deployment secrets), the app
 * bundle, and every other user's files cached in `/tmp` on a warm instance.
 *
 * So on a hosted deployment the policy is NOT the learner's preference: it
 * is always restricted to the signed-in user's own uploads folder (and
 * nothing else), whatever Settings → Agent → Tools says. The folder holds
 * only files the user uploaded (materialized from blob storage on demand);
 * it is created empty so the tools answer "nothing here" instead of an
 * unavailable-folder error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { currentUser, safeUserId } from "../store/user-scope.ts";
import { publicDeployment } from "./desktop-access.ts";

/** True when the learner filesystem must be confined to uploads. */
export function hostedFileAccess(env: Record<string, string | undefined> = process.env): boolean {
	if (env.LH_HOSTED_FILE_ACCESS === "0") return false; // explicit operator opt-out (self-hosted single user)
	return publicDeployment(env) || env.LH_STORE === "convex";
}

/** Root of every user's materialized uploads on this instance. */
export function uploadsRoot(): string {
	return path.join(process.env.LH_UPLOADS_DIR || path.join(os.tmpdir(), "lh-uploads"));
}

/** The signed-in user's uploads folder ("owner" when no one is signed in —
 *  single-user mode). A signed-in user whose id is not a safe path segment
 *  gets null (a closed policy), never someone else's folder. */
export function userUploadsDir(): string | null {
	const user = currentUser();
	if (!user) return path.join(uploadsRoot(), "owner");
	return safeUserId(user.id) ? path.join(uploadsRoot(), user.id) : null;
}

/** The hosted learner-source policy: the user's uploads folder only. */
export function hostedFileAccessPolicy(): FileAccessPolicy {
	const dir = userUploadsDir();
	if (!dir) return { restricted: true, folders: [] };
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// An unavailable folder still yields a CLOSED policy (restricted with
		// no usable root) — never a fallback to the open server filesystem.
	}
	return { restricted: true, folders: [dir] };
}
