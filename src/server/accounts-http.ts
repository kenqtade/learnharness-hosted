/**
 * HTTP bodies for the platform-mode routes (multi-user branch):
 * /api/auth/{login,logout,signup,me}, /api/account, /api/admin/*.
 * The route files stay thin (the import law). withStore has already run
 * the access policy (routeAccess) before any of these is reached; these
 * bodies re-read the session only to know WHICH account is acting.
 *
 * With LH_MULTI_USER unset every route here except /api/auth/me answers
 * 404, so the single-user app grows no new surface.
 */
import { multiUser } from "../store/user-scope.ts";
import {
	changePassword, clearSessionCookie, createInvite, deleteAccount, issueSession, listAccounts, listInvites,
	login, platformState, publicAccount, revokeInvite, sessionCookie, setDisabled, setOpenSignups, signOutEverywhere,
	signup, updateProfile, verifySession, cookieValue, type Account, type Result,
} from "./accounts.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const ok = (body: unknown, init: ResponseInit = {}) =>
	Response.json(body, { ...init, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
const err = (status: number, error: string) => ok({ error }, { status });
const off = () => err(404, "Accounts are not enabled on this server.");
const failed = (r: Result<unknown> & { ok: false }) => err(r.status, r.error);

function secure(req: Request): boolean {
	const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
	return proto.split(",")[0]!.trim() === "https";
}
async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		const v = await req.json();
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
function actor(req: Request) {
	return verifySession(cookieValue(req.headers.get("cookie")));
}
const signedIn = (req: Request, account: Account, extra: Record<string, unknown> = {}) =>
	ok({ user: publicAccount(account), ...extra }, { headers: { "Set-Cookie": sessionCookie(issueSession(account), secure(req)) } });

// ─── /api/auth ────────────────────────────────────────────────────────────

/** GET /api/auth/me: what the UI needs to pick its shell. */
export function authMeResponse(req: Request): Response {
	if (!multiUser) return ok({ multiUser: false });
	const session = actor(req);
	return ok({ multiUser: true, user: session ? publicAccount(session.account) : null, platform: platformState() });
}

export async function authLoginResponse(req: Request): Promise<Response> {
	if (!multiUser) return off();
	const b = await body(req);
	const r = login(b.email, b.password);
	return r.ok ? signedIn(req, r.value) : failed(r);
}

export async function authSignupResponse(req: Request): Promise<Response> {
	if (!multiUser) return off();
	const b = await body(req);
	const r = signup({ email: b.email, password: b.password, name: b.name, inviteCode: b.inviteCode, setupCode: b.setupCode });
	return r.ok ? signedIn(req, r.value, { created: true }) : failed(r);
}

export function authLogoutResponse(req: Request): Response {
	return ok({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(secure(req)) } });
}

// ─── /api/account ─────────────────────────────────────────────────────────

/** GET profile · PATCH {name} · POST {action:"password",current,next} | {action:"signout-all"}. */
export async function accountResponse(req: Request): Promise<Response> {
	if (!multiUser) return off();
	const session = actor(req);
	if (!session) return err(401, "Sign in to continue.");
	const method = req.method.toUpperCase();
	if (method === "GET") return ok({ user: publicAccount(session.account) });
	const b = await body(req);
	if (method === "PATCH") {
		const r = updateProfile(session.id, { name: b.name });
		return r.ok ? ok({ user: publicAccount(r.value) }) : failed(r);
	}
	if (method === "POST" && b.action === "password") {
		const r = changePassword(session.id, b.current, b.next);
		// other devices are signed out; this one gets a fresh cookie
		return r.ok ? signedIn(req, r.value) : failed(r);
	}
	if (method === "POST" && b.action === "signout-all") {
		const r = signOutEverywhere(session.id);
		return r.ok ? ok({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(secure(req)) } }) : failed(r);
	}
	return err(405, "Unsupported request.");
}

// ─── /api/admin (owner only; enforced by routeAccess in withStore) ────────

/** GET list · PATCH {id, disabled} · DELETE ?id= (deletes the account AND its data). */
export async function adminUsersResponse(req: Request): Promise<Response> {
	if (!multiUser) return off();
	const method = req.method.toUpperCase();
	if (method === "GET") return ok({ users: listAccounts() });
	if (method === "PATCH") {
		const b = await body(req);
		if (typeof b.id !== "string" || typeof b.disabled !== "boolean") return err(400, "Body must be {id, disabled}.");
		const r = setDisabled(b.id, b.disabled);
		return r.ok ? ok({ user: publicAccount(r.value) }) : failed(r);
	}
	if (method === "DELETE") {
		const id = new URL(req.url).searchParams.get("id");
		if (!id) return err(400, "Missing ?id=");
		const r = deleteAccount(id);
		return r.ok ? ok({ deleted: r.value }) : failed(r);
	}
	return err(405, "Unsupported request.");
}

/** GET list · POST {note?} → new code · DELETE ?code=. */
export async function adminInvitesResponse(req: Request): Promise<Response> {
	if (!multiUser) return off();
	const method = req.method.toUpperCase();
	if (method === "GET") return ok({ invites: listInvites() });
	if (method === "POST") {
		const session = actor(req);
		const b = await body(req);
		return ok({ invite: createInvite(session?.id ?? "owner", b.note) }, { status: 201 });
	}
	if (method === "DELETE") {
		const code = new URL(req.url).searchParams.get("code");
		if (!code) return err(400, "Missing ?code=");
		return revokeInvite(code) ? ok({ ok: true }) : err(404, "Invite not found.");
	}
	return err(405, "Unsupported request.");
}

/** GET {openSignups} · PUT {openSignups: boolean}. */
export async function adminConfigResponse(req: Request): Promise<Response> {
	if (!multiUser) return off();
	if (req.method.toUpperCase() === "PUT") {
		const b = await body(req);
		if (typeof b.openSignups !== "boolean") return err(400, "Body must be {openSignups: boolean}.");
		setOpenSignups(b.openSignups);
	}
	const { openSignups } = platformState();
	return ok({ openSignups });
}
