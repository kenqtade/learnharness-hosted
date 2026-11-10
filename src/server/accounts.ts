/**
 * ACCOUNTS (branch feat/multi-user): users, passwords, sessions, invites.
 *
 * Records are platform-wide JSON files under the storage seam's
 * PLATFORM_ROOT (Convex keys `platform/…` on Vercel, a sibling folder of
 * the data dir locally) — never inside anyone's data space.
 *
 * - Passwords: scrypt (N=2^14, r=8, p=1, 16-byte salt, 64-byte key),
 *   compared in constant time. Plain passwords are never stored or logged.
 * - Sessions: a stateless signed cookie `<payload>.<HMAC-SHA256>` holding
 *   the user id, the account's sessionVersion and an expiry. Bumping
 *   sessionVersion (sign out everywhere, password change, disable) kills
 *   every outstanding cookie for that account at once.
 * - Sign-in is USERNAME + password (owner request: keep it easy). No email
 *   is needed; accounts made by an earlier build (email-only) sign in
 *   with either their derived username or their old email.
 * - The first account is the OWNER and needs LH_OWNER_SETUP_CODE, so a
 *   stranger who finds the URL first cannot claim the platform. After
 *   that, new accounts need an invite code unless the owner turned on
 *   open sign-ups.
 */
import crypto from "node:crypto";
import path from "node:path";
import vfs, { PLATFORM_ROOT } from "../store/vfs.ts";
import { PATHS } from "../../config.ts";
import { runAsUser, type Role, type ScopeUser } from "../store/user-scope.ts";

const USERS_FILE = path.join(PLATFORM_ROOT, "users.json");
const INVITES_FILE = path.join(PLATFORM_ROOT, "invites.json");
const CONFIG_FILE = path.join(PLATFORM_ROOT, "config.json");

export const SESSION_COOKIE = "lh_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;

export interface Account {
	id: string;
	/** Sign-in name: lowercase a–z, 0–9, dot, dash, underscore; 3–32 chars. */
	username: string;
	/** Legacy (first staging build) — optional, never required. */
	email?: string;
	name: string;
	role: Role;
	passwordHash: string;
	sessionVersion: number;
	createdAt: string;
	lastLoginAt?: string;
	disabled?: boolean;
}
export type PublicAccount = Omit<Account, "passwordHash" | "sessionVersion">;
/** `maxUses` absent = classic single-use invite (closed once `usedBy` is set).
 *  `maxUses` set = a shareable code (e.g. one early-access code sent to a
 *  group); `useCount` counts sign-ups and `usedBy`/`usedAt` record the latest. */
export interface Invite { code: string; createdBy: string; createdAt: string; expiresAt: string; note?: string; usedBy?: string; usedAt?: string; maxUses?: number; useCount?: number }

/** Still accepts sign-ups: not expired and uses left. */
export function inviteOpen(i: Invite, now = Date.now()): boolean {
	if (Date.parse(i.expiresAt) <= now) return false;
	return i.maxUses ? (i.useCount ?? 0) < i.maxUses : !i.usedBy;
}
/** Codes are compared without case or surrounding spaces, so a code typed
 *  from a message ("early-access-2026") still works. */
const sameCode = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const CUSTOM_CODE_RULE = "4–40 letters, digits or dashes";
interface PlatformConfig { openSignups?: boolean }

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });

// ─── files ────────────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(vfs.readFileSync(file, "utf-8")) as T;
	} catch {
		return fallback;
	}
}
function writeJson(file: string, value: unknown): void {
	vfs.mkdirSync(PLATFORM_ROOT, { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	vfs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	vfs.renameSync(tmp, file);
}
/** Records from the email-only build get a username derived from the
 *  email's local part (made unique) the first time they're read. */
function withUsernames(users: Account[]): Account[] {
	const taken = new Set(users.map((u) => u.username).filter(Boolean));
	for (const u of users) {
		if (u.username) continue;
		const base = (normalizeUsername((u.email ?? "").split("@")[0]) ?? "user").slice(0, 28);
		let name = base.length >= 3 ? base : `${base}user`;
		for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
		u.username = name;
		taken.add(name);
	}
	return users;
}
const readUsers = () => withUsernames(readJson<{ users: Account[] }>(USERS_FILE, { users: [] }).users);
const writeUsers = (users: Account[]) => writeJson(USERS_FILE, { version: 1, users });
const readInvites = () => readJson<{ invites: Invite[] }>(INVITES_FILE, { invites: [] }).invites;
const writeInvites = (invites: Invite[]) => writeJson(INVITES_FILE, { version: 1, invites });
const readConfig = () => readJson<PlatformConfig>(CONFIG_FILE, {});

export function publicAccount(a: Account): PublicAccount {
	const { passwordHash: _h, sessionVersion: _v, ...rest } = a;
	return rest;
}

// ─── passwords ────────────────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
	const salt = crypto.randomBytes(16);
	const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
	const expected = Buffer.from(keyB64, "base64");
	const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// spent on unknown emails so a login reply does not reveal whether one exists
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));

// ─── validation ───────────────────────────────────────────────────────────

export function normalizeUsername(username: unknown): string | null {
	if (typeof username !== "string") return null;
	const u = username.trim().toLowerCase().replace(/^@/, "");
	return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u) ? u : null;
}
export const USERNAME_RULE = "Usernames are 3–32 characters: letters, numbers, dot, dash or underscore.";
export function passwordProblem(password: unknown): string | null {
	if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters.";
	if (password.length > 200) return "Password is too long.";
	return null;
}
function cleanName(name: unknown, fallback: string): string {
	const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
	return n || fallback;
}
const newId = () => `u_${crypto.randomBytes(9).toString("hex")}`;
const sameText = (a: string, b: string) => {
	const x = Buffer.from(a), y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ─── platform state ───────────────────────────────────────────────────────

export function platformState(): { ownerExists: boolean; openSignups: boolean; setupConfigured: boolean } {
	return {
		ownerExists: readUsers().some((u) => u.role === "owner"),
		openSignups: readConfig().openSignups === true,
		setupConfigured: Boolean(process.env.LH_OWNER_SETUP_CODE),
	};
}

export function setOpenSignups(open: boolean): void {
	writeJson(CONFIG_FILE, { ...readConfig(), openSignups: open });
}

// ─── accounts ─────────────────────────────────────────────────────────────

export function getAccount(id: string): Account | undefined {
	return readUsers().find((u) => u.id === id);
}
export function listAccounts(): PublicAccount[] {
	return readUsers().map(publicAccount);
}

export function signup(input: { username?: unknown; password?: unknown; name?: unknown; inviteCode?: unknown; setupCode?: unknown }): Result<Account> {
	const username = normalizeUsername(input.username);
	if (!username) return fail(USERNAME_RULE);
	const bad = passwordProblem(input.password);
	if (bad) return fail(bad);
	const users = readUsers();
	if (users.some((u) => u.username === username)) return fail("That username is taken. Try another one.", 409);
	const ownerExists = users.some((u) => u.role === "owner");
	let role: Role = "member";
	let invite: Invite | undefined;
	const invites = readInvites();
	if (!ownerExists) {
		const expected = process.env.LH_OWNER_SETUP_CODE;
		if (!expected) return fail("This platform has no owner yet and no setup code is configured (LH_OWNER_SETUP_CODE).", 503);
		if (typeof input.setupCode !== "string" || !sameText(input.setupCode.trim(), expected)) return fail("The setup code is not correct.", 403);
		role = "owner";
	} else if (readConfig().openSignups !== true) {
		const code = typeof input.inviteCode === "string" ? input.inviteCode.trim() : "";
		invite = invites.find((i) => sameCode(i.code, code) && inviteOpen(i));
		if (!code || !invite) return fail("A valid invite code is required to create an account.", 403);
	}
	const now = new Date().toISOString();
	const account: Account = {
		id: newId(), username, name: cleanName(input.name, username), role,
		passwordHash: hashPassword(input.password as string), sessionVersion: 1, createdAt: now, lastLoginAt: now,
	};
	writeUsers([...users, account]);
	if (invite) {
		if (invite.maxUses) invite.useCount = (invite.useCount ?? 0) + 1;
		invite.usedBy = account.id;
		invite.usedAt = now;
		writeInvites(invites);
	}
	return { ok: true, value: account };
}

const failures = new Map<string, { count: number; until: number }>();

/** Sign in by username (or, for accounts from the email-only build, the
 *  old email). */
export function login(identifier: unknown, password: unknown): Result<Account> {
	const id = typeof identifier === "string" ? identifier.trim().toLowerCase().replace(/^@/, "") : "";
	const gate = failures.get(id);
	if (gate && gate.until > Date.now()) return fail("Too many attempts. Wait a minute and try again.", 429);
	const users = readUsers();
	const account = users.find((u) => u.username === id || (u.email !== undefined && u.email === id));
	const ok = verifyPassword(typeof password === "string" ? password : "", account?.passwordHash ?? DUMMY_HASH) && !!account;
	if (!ok || !account) {
		const count = (gate?.count ?? 0) + 1;
		failures.set(id, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
		return fail("Username or password is not correct.", 401);
	}
	failures.delete(id);
	if (account.disabled) return fail("This account has been disabled by the platform owner.", 403);
	account.lastLoginAt = new Date().toISOString();
	writeUsers(users);
	return { ok: true, value: account };
}

function updateAccount(id: string, change: (a: Account) => Result<void> | void): Result<Account> {
	const users = readUsers();
	const account = users.find((u) => u.id === id);
	if (!account) return fail("Account not found.", 404);
	const verdict = change(account);
	if (verdict && !verdict.ok) return verdict;
	writeUsers(users);
	return { ok: true, value: account };
}

export function updateProfile(id: string, input: { name?: unknown }): Result<Account> {
	return updateAccount(id, (a) => { a.name = cleanName(input.name, a.username); });
}

export function changePassword(id: string, current: unknown, next: unknown): Result<Account> {
	return updateAccount(id, (a) => {
		if (!verifyPassword(typeof current === "string" ? current : "", a.passwordHash)) return fail("Current password is not correct.", 403);
		const bad = passwordProblem(next);
		if (bad) return fail(bad);
		a.passwordHash = hashPassword(next as string);
		a.sessionVersion += 1; // every other device signs out
	});
}

export function signOutEverywhere(id: string): Result<Account> {
	return updateAccount(id, (a) => { a.sessionVersion += 1; });
}

export function setDisabled(id: string, disabled: boolean): Result<Account> {
	return updateAccount(id, (a) => {
		if (a.role === "owner") return fail("The owner account cannot be disabled.", 400);
		a.disabled = disabled;
		if (disabled) a.sessionVersion += 1;
	});
}

/** Delete an account AND its whole data space. The owner cannot be deleted. */
export function deleteAccount(id: string): Result<PublicAccount> {
	const users = readUsers();
	const account = users.find((u) => u.id === id);
	if (!account) return fail("Account not found.", 404);
	if (account.role === "owner") return fail("The owner account cannot be deleted.", 400);
	runAsUser({ id: account.id, role: "member" }, () => vfs.rmSync(PATHS.data, { recursive: true, force: true }));
	writeUsers(users.filter((u) => u.id !== id));
	return { ok: true, value: publicAccount(account) };
}

// ─── invites ──────────────────────────────────────────────────────────────

export function listInvites(): Invite[] {
	return readInvites();
}
export function createInvite(createdBy: string, note?: unknown): Invite {
	const invites = readInvites();
	const now = Date.now();
	const invite: Invite = {
		code: crypto.randomBytes(6).toString("base64url"),
		createdBy, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
		...(typeof note === "string" && note.trim() ? { note: note.trim().slice(0, 80) } : {}),
	};
	// keep the list tidy: drop expired, unused invites
	writeInvites([...invites.filter((i) => i.usedBy || Date.parse(i.expiresAt) > now), invite]);
	return invite;
}
/** An invite with an owner-chosen, memorable code and optionally several
 *  uses and a custom lifetime (1–365 days, default 14). */
export function createCustomInvite(createdBy: string, opts: { code?: unknown; note?: unknown; maxUses?: unknown; days?: unknown }): Result<Invite> {
	const code = typeof opts.code === "string" ? opts.code.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,38}[A-Za-z0-9]$/.test(code)) return fail(`Invite codes are ${CUSTOM_CODE_RULE}.`, 400);
	const maxUses = opts.maxUses === undefined ? 1 : Number(opts.maxUses);
	if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) return fail("Uses must be a whole number from 1 to 1000.", 400);
	const days = opts.days === undefined ? 14 : Number(opts.days);
	if (!Number.isFinite(days) || days < 1 || days > 365) return fail("Lifetime must be 1 to 365 days.", 400);
	const invites = readInvites();
	const now = Date.now();
	if (invites.some((i) => sameCode(i.code, code) && Date.parse(i.expiresAt) > now)) return fail("That invite code already exists.", 409);
	const invite: Invite = {
		code, createdBy, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 24 * 3600 * 1000).toISOString(),
		...(typeof opts.note === "string" && opts.note.trim() ? { note: opts.note.trim().slice(0, 80) } : {}),
		...(maxUses > 1 ? { maxUses, useCount: 0 } : {}),
	};
	writeInvites([...invites.filter((i) => i.usedBy || Date.parse(i.expiresAt) > now), invite]);
	return { ok: true, value: invite };
}
export function revokeInvite(code: string): boolean {
	const invites = readInvites();
	const next = invites.filter((i) => i.code !== code);
	if (next.length === invites.length) return false;
	writeInvites(next);
	return true;
}

// ─── sessions ─────────────────────────────────────────────────────────────

let devSecret: string | undefined;
function sessionSecret(): string {
	if (process.env.LH_SESSION_SECRET) return process.env.LH_SESSION_SECRET;
	if (process.env.LH_CONVEX_SECRET) return crypto.createHmac("sha256", process.env.LH_CONVEX_SECRET).update("lh-session-v1").digest("hex");
	// local runs without either: sessions last until the server restarts
	return (devSecret ??= crypto.randomBytes(32).toString("hex"));
}
const sign = (payload: string) => crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");

export function issueSession(account: Account, now = Date.now()): string {
	const payload = Buffer.from(JSON.stringify({ u: account.id, v: account.sessionVersion, e: Math.floor(now / 1000) + SESSION_MAX_AGE_S })).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

export type Session = ScopeUser & { account: Account };

export function verifySession(token: string | undefined | null, now = Date.now()): Session | null {
	if (!token) return null;
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const payload = token.slice(0, dot);
	if (!sameText(token.slice(dot + 1), sign(payload))) return null;
	let data: { u?: string; v?: number; e?: number };
	try {
		data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
	} catch {
		return null;
	}
	if (typeof data.u !== "string" || typeof data.e !== "number" || data.e * 1000 < now) return null;
	const account = getAccount(data.u);
	if (!account || account.disabled || account.sessionVersion !== data.v) return null;
	return { id: account.id, role: account.role, account };
}

export function cookieValue(header: string | null | undefined, name = SESSION_COOKIE): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
	}
	return null;
}

export function sessionCookie(token: string, secure: boolean): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secure ? "; Secure" : ""}`;
}
export function clearSessionCookie(secure: boolean): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// ─── route access policy ──────────────────────────────────────────────────

export type Access = "public" | "user" | "owner";

/** Who may call an API route in platform mode. Every account manages its
 *  OWN API keys and custom endpoint (owner ruling 2026-11-10: nobody runs
 *  on someone else's credentials), so those are ordinary user routes. Only
 *  the server machine's own logins stay with the owner: subscription
 *  connections (one per server process) and the Claude Code CLI. */
export function routeAccess(method: string, pathname: string): Access {
	const p = pathname.replace(/\/+$/, "") || "/";
	if (p.startsWith("/api/auth/")) return "public";
	// auto-update: the cron authenticates itself (CRON_SECRET); the version
	// probe is public (the refresh banner also runs on the sign-in page);
	// everyone may READ the update status, only the owner starts a check.
	if (p === "/api/cron/update" || p === "/api/version") return "public";
	// internal dispatch authenticates itself (HMAC-signed task)
	if (p === "/api/internal/run") return "public";
	if (p === "/api/update") return method.toUpperCase() === "GET" ? "user" : "owner";
	if (p.startsWith("/api/admin")) return "owner";
	if (p.startsWith("/api/subscriptions") || p === "/api/claude-code") return "owner";
	return "user";
}
