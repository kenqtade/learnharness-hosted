/** PLATFORM MODE contracts (multi-user branch): per-user data spaces in the
 * storage seam, accounts + sessions + invites, the route access policy,
 * the withStore auth gate, and the scoped event bus. Runs the real stores
 * on real files in a scratch dir (fs mode — the Convex mode shares the
 * same key mapping). Env is installed BEFORE any app import because the
 * platform flag and data paths are read at module load. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Access, Account, Result } from "../src/server/accounts.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-multi-user-"));
const DATA = path.join(scratch, "data");
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
process.env.LH_DATA_DIR = DATA;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.LH_MULTI_USER = "1";
process.env.LH_OWNER_SETUP_CODE = "setup-code-123";
process.env.LH_SESSION_SECRET = "test-session-secret";
delete process.env.LH_STORE;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const scope = await import("../src/store/user-scope.ts");
const accounts = await import("../src/server/accounts.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { withStore, enterPageScope } = await import("../src/server/store-ready.ts");
const events = await import("../src/core/events.ts");
await import("../src/server/stores.ts"); // installs the event/extraction scope hooks
const { extractionStatuses, abortExtraction } = await import("../src/agent/subagents/extraction.ts");

const must = <T,>(r: Result<T>): T => {
	if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`);
	return r.value;
};

test("the platform flag is read from LH_MULTI_USER", () => {
	assert.equal(scope.multiUser, true);
});

// ─── accounts ─────────────────────────────────────────────────────────────

let owner: Account;
let alice: Account;
let bob: Account;

test("the first account needs the owner setup code and becomes the owner", () => {
	const none = accounts.signup({ username: "owner", password: "password-1" });
	assert.equal(none.ok, false);
	assert.equal((none as { status: number }).status, 403);
	const wrong = accounts.signup({ username: "owner", password: "password-1", setupCode: "nope" });
	assert.equal(wrong.ok, false);
	owner = must(accounts.signup({ username: "Owner ", password: "password-1", setupCode: "setup-code-123", name: "Owner" }));
	assert.equal(owner.role, "owner");
	assert.equal(owner.username, "owner", "usernames are case-insensitive and trimmed");
	assert.ok(!JSON.stringify(accounts.listAccounts()).includes("password-1"));
	assert.ok(!("passwordHash" in accounts.listAccounts()[0]!));
});

test("after the owner, sign-up needs a valid single-use invite unless open sign-ups is on", () => {
	assert.equal(accounts.signup({ username: "alice", password: "password-a" }).ok, false);
	assert.equal(accounts.signup({ username: "alice", password: "password-a", inviteCode: "made-up" }).ok, false);
	const invite = accounts.createInvite(owner.id, "for alice");
	alice = must(accounts.signup({ username: "alice", password: "password-a", inviteCode: invite.code }));
	assert.equal(alice.role, "member");
	const reuse = accounts.signup({ username: "xavier", password: "password-x", inviteCode: invite.code });
	assert.equal(reuse.ok, false, "an invite works once");
	const dup = accounts.signup({ username: "ALICE", password: "password-a", inviteCode: accounts.createInvite(owner.id).code });
	assert.equal(dup.ok, false, "usernames are unique, case-insensitively");
	accounts.setOpenSignups(true);
	bob = must(accounts.signup({ username: "bob", password: "password-b" }));
	accounts.setOpenSignups(false);
	assert.equal(accounts.signup({ username: "carol", password: "password-c" }).ok, false);
});

test("weak input is refused with plain messages", () => {
	accounts.setOpenSignups(true);
	assert.match((accounts.signup({ username: "a b", password: "password-1" }) as { error: string }).error, /3–32 characters/);
	assert.match((accounts.signup({ username: "ab", password: "password-1" }) as { error: string }).error, /3–32 characters/);
	assert.match((accounts.signup({ username: "dave", password: "short" }) as { error: string }).error, /8 characters/);
	accounts.setOpenSignups(false);
});

test("accounts from the email-only build get a username and can sign in with either", () => {
	const file = path.join(`${DATA}-platform`, "users.json");
	const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
	rec.users.push({ id: "u_legacy00001", email: "old.timer@example.com", name: "Old", role: "member", passwordHash: accounts.hashPassword("legacy-pass"), sessionVersion: 1, createdAt: new Date().toISOString() });
	fs.writeFileSync(file, JSON.stringify(rec));
	assert.equal(must(accounts.login("old.timer", "legacy-pass")).id, "u_legacy00001");
	assert.equal(must(accounts.login("old.timer@example.com", "legacy-pass")).id, "u_legacy00001");
	assert.equal(accounts.getAccount("u_legacy00001")?.username, "old.timer");
	must(accounts.deleteAccount("u_legacy00001"));
});

test("login checks the password; repeated failures are throttled", () => {
	assert.equal(must(accounts.login("alice", "password-a")).id, alice.id);
	assert.equal(accounts.login("alice", "wrong").ok, false);
	assert.equal(accounts.login("nobody", "x").ok, false);
	for (let i = 0; i < 5; i++) accounts.login("bob", "wrong");
	const locked = accounts.login("bob", "password-b");
	assert.equal(locked.ok, false);
	assert.equal((locked as { status: number }).status, 429);
});

test("sessions: signed, expiring, revocable", () => {
	const token = accounts.issueSession(alice);
	assert.equal(accounts.verifySession(token)?.id, alice.id);
	assert.equal(accounts.verifySession(`${token}x`), null, "tampered signature");
	const [payload, sig] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), u: owner.id })).toString("base64url");
	assert.equal(accounts.verifySession(`${forged}.${sig}`), null, "a changed payload breaks the signature");
	assert.equal(accounts.verifySession(token, Date.now() + 31 * 24 * 3600 * 1000), null, "expired");
	must(accounts.signOutEverywhere(alice.id));
	assert.equal(accounts.verifySession(token), null, "sign-out-everywhere revokes old cookies");
	const fresh = accounts.issueSession(accounts.getAccount(alice.id)!);
	assert.equal(accounts.verifySession(fresh)?.id, alice.id);
	assert.equal(accounts.cookieValue(`a=1; lh_session=${encodeURIComponent(fresh)}; b=2`), fresh);
});

test("password change: needs the current one, signs other devices out", () => {
	const before = accounts.issueSession(accounts.getAccount(alice.id)!);
	assert.equal(accounts.changePassword(alice.id, "wrong", "new-password-a").ok, false);
	must(accounts.changePassword(alice.id, "password-a", "new-password-a"));
	assert.equal(accounts.verifySession(before), null);
	assert.equal(accounts.login("alice", "password-a").ok, false);
	assert.ok(accounts.login("alice", "new-password-a").ok);
});

test("the owner can disable members but never the owner", () => {
	assert.equal(accounts.setDisabled(owner.id, true).ok, false);
	const t = accounts.issueSession(accounts.getAccount(bob.id)!);
	must(accounts.setDisabled(bob.id, true));
	assert.equal(accounts.verifySession(t), null);
	assert.equal((accounts.login("bob", "password-b") as { status: number }).status !== 200, true);
	must(accounts.setDisabled(bob.id, false));
});

// ─── data spaces ──────────────────────────────────────────────────────────

const as = <T,>(a: Account, fn: () => T) => scope.runAsUser({ id: a.id, role: a.role }, fn);

test("each member has a private data space; the owner keeps the original data", () => {
	const ownerChat = as(owner, () => chatStore.createChat("owner chat"));
	const aliceChat = as(alice, () => chatStore.createChat("alice chat"));
	const bobChat = as(bob, () => chatStore.createChat("bob chat"));
	assert.deepEqual(as(owner, () => chatStore.listChats().map((c) => c.title)), ["owner chat"]);
	assert.deepEqual(as(alice, () => chatStore.listChats().map((c) => c.title)), ["alice chat"]);
	assert.deepEqual(as(bob, () => chatStore.listChats().map((c) => c.title)), ["bob chat"]);
	assert.equal(as(alice, () => chatStore.getChat(bobChat.id)), null, "another user's chat reads as absent");
	assert.equal(as(bob, () => chatStore.getChat(aliceChat.id)), null);
	// owner = legacy data dir; members live in the sibling users dir
	assert.ok(fs.readdirSync(path.join(DATA, "chats")).some((f) => f.includes(ownerChat.id)));
	assert.ok(fs.readdirSync(path.join(`${DATA}-users`, alice.id, "chats")).some((f) => f.includes(aliceChat.id)));
	// code outside any request (boot work) sees the owner's space
	assert.ok(chatStore.listChats().some((c) => c.id === ownerChat.id));
});

test("members inherit the owner's settings until they save their own", async () => {
	const { settingsStore } = await import("../src/store/settings.ts");
	const { SETTINGS_FILE } = await import("../config.ts");
	as(owner, () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, agent: { marker: "owner" } })));
	const vfs = (await import("../src/store/vfs.ts")).default;
	assert.match(as(alice, () => vfs.readFileSync(SETTINGS_FILE, "utf-8")), /owner/, "inherited");
	as(alice, () => vfs.writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, agent: { marker: "alice" } })));
	assert.match(as(alice, () => vfs.readFileSync(SETTINGS_FILE, "utf-8")), /alice/, "own copy wins");
	assert.match(as(owner, () => vfs.readFileSync(SETTINGS_FILE, "utf-8")), /owner/, "the owner's copy is untouched");
	assert.match(as(bob, () => vfs.readFileSync(SETTINGS_FILE, "utf-8")), /owner/);
	assert.ok(settingsStore);
});

test("the scope follows async work started inside a request", async () => {
	const id = await as(alice, async () => {
		await new Promise((r) => setTimeout(r, 5));
		return chatStore.createChat("later").id;
	});
	assert.ok(as(alice, () => chatStore.getChat(id)));
	assert.equal(as(bob, () => chatStore.getChat(id)), null);
});

test("platform records never land in a user's space", () => {
	as(alice, () => accounts.createInvite(alice.id));
	assert.ok(fs.existsSync(path.join(`${DATA}-platform`, "invites.json")));
	assert.ok(!fs.existsSync(path.join(`${DATA}-users`, alice.id, "..", "invites.json")));
});

test("deleting a member removes the account and all of their data; the owner can't be deleted", () => {
	const victim = must(accounts.signup({ username: "victim", password: "password-v", inviteCode: accounts.createInvite(owner.id).code }));
	as(victim, () => chatStore.createChat("doomed"));
	assert.ok(fs.existsSync(path.join(`${DATA}-users`, victim.id)));
	must(accounts.deleteAccount(victim.id));
	assert.ok(!fs.existsSync(path.join(`${DATA}-users`, victim.id, "chats")));
	assert.equal(accounts.getAccount(victim.id), undefined);
	assert.equal(accounts.deleteAccount(owner.id).ok, false);
	assert.ok(as(owner, () => chatStore.listChats().length) > 0, "owner data untouched");
});

// ─── access policy + withStore gate ───────────────────────────────────────

test("route access policy", () => {
	const t: Array<[string, string, Access]> = [
		["POST", "/api/auth/login", "public"],
		["GET", "/api/auth/me", "public"],
		["GET", "/api/chats", "user"],
		["POST", "/api/chat", "user"],
		["GET", "/api/keys", "user"],
		["PUT", "/api/keys/nvidia", "owner"],
		["DELETE", "/api/keys/nvidia", "owner"],
		["GET", "/api/custom-provider", "user"],
		["POST", "/api/custom-provider", "owner"],
		["GET", "/api/subscriptions", "owner"],
		["GET", "/api/claude-code", "owner"],
		["GET", "/api/admin/users", "owner"],
		["PUT", "/api/settings/models", "user"],
	];
	for (const [m, p, want] of t) assert.equal(accounts.routeAccess(m, p), want, `${m} ${p}`);
});

const req = (method: string, url: string, who?: Account) =>
	new Request(`http://localhost${url}`, {
		method,
		headers: who ? { cookie: `lh_session=${encodeURIComponent(accounts.issueSession(accounts.getAccount(who.id)!))}` } : {},
	});

test("withStore: 401 signed out, 403 member on owner routes, handler runs as the caller", async () => {
	const handler = withStore(async (_r: Request) => Response.json(chatStore.listChats().map((c) => c.title)));
	assert.equal((await handler(req("GET", "/api/chats"))).status, 401);
	const mine = await (await handler(req("GET", "/api/chats", bob))).json();
	assert.deepEqual(mine, ["bob chat"]);
	const keys = withStore(async (_r: Request) => Response.json({ ok: true }));
	assert.equal((await keys(req("PUT", "/api/keys/nvidia", bob))).status, 403);
	assert.equal((await keys(req("PUT", "/api/keys/nvidia", owner))).status, 200);
	assert.equal((await keys(req("POST", "/api/auth/login"))).status, 200, "auth routes are public");
});

test("server pages: a valid cookie binds the user, anything else must sign in", () => {
	assert.equal(enterPageScope(undefined), false);
	assert.equal(enterPageScope("garbage.token"), false);
	scope.runAsUser({ id: "outer000", role: "member" }, () => {
		assert.equal(enterPageScope(accounts.issueSession(accounts.getAccount(alice.id)!)), true);
		assert.equal(scope.currentUser()?.id, alice.id);
	});
});

// ─── live notifications + activity ────────────────────────────────────────

test("events reach only the windows of the same data space", () => {
	const seen: Record<string, string[]> = { owner: [], alice: [], bob: [] };
	const offs = [
		as(owner, () => events.subscribe((e) => seen.owner!.push(e.type))),
		as(alice, () => events.subscribe((e) => seen.alice!.push(e.type))),
		as(bob, () => events.subscribe((e) => seen.bob!.push(e.type))),
	];
	as(alice, () => events.emit("chats-changed", {}));
	events.emit("jobs-changed", {}); // unscoped work = the owner's space
	offs.forEach((off) => off());
	assert.deepEqual(seen.alice, ["chats-changed"]);
	assert.deepEqual(seen.bob, []);
	assert.deepEqual(seen.owner, ["jobs-changed"]);
});

test("the extraction registry is filtered per data space", () => {
	const g = globalThis as { __lhExtractionRuns?: { running: Map<string, unknown> } };
	g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 } as never;
	const controller = new AbortController();
	g.__lhExtractionRuns!.running.set(`${alice.id}\u0000c1`, {
		chatId: "c1", kind: "chat", phase: "extracting", startedAt: 1, usage: {}, controller, scope: alice.id,
	});
	assert.equal(as(alice, () => extractionStatuses().length), 1);
	assert.equal(as(bob, () => extractionStatuses().length), 0);
	assert.equal(as(bob, () => abortExtraction("c1")), false, "can't cancel another user's run");
	assert.equal(controller.signal.aborted, false);
	assert.equal(as(alice, () => abortExtraction("c1")), true);
	g.__lhExtractionRuns!.running.clear();
});

test("a memorable shareable invite: owner-chosen code, several uses, any letter case", () => {
	assert.equal(accounts.createCustomInvite(owner.id, { code: "no spaces!" }).ok, false, "code rule");
	assert.equal(accounts.createCustomInvite(owner.id, { code: "EARLY-OK", maxUses: 0 }).ok, false, "uses 1..1000");
	const inv = must(accounts.createCustomInvite(owner.id, { code: "EARLY-ACCESS-TEST", maxUses: 2, days: 30, note: "early testers" }));
	assert.equal(inv.maxUses, 2);
	assert.ok(Date.parse(inv.expiresAt) - Date.now() > 29 * 24 * 3600 * 1000);
	const dupe = accounts.createCustomInvite(owner.id, { code: "early-access-test" });
	assert.equal(dupe.ok, false, "codes are unique ignoring case");
	if (!dupe.ok) assert.equal(dupe.status, 409);
	const e1 = must(accounts.signup({ username: "early1", password: "password-e1", inviteCode: " early-access-test " }));
	const e2 = must(accounts.signup({ username: "early2", password: "password-e2", inviteCode: "Early-Access-Test" }));
	assert.equal(accounts.signup({ username: "early3", password: "password-e3", inviteCode: "EARLY-ACCESS-TEST" }).ok, false, "only 2 uses");
	const stored = accounts.listInvites().find((i) => i.code === "EARLY-ACCESS-TEST")!;
	assert.equal(stored.useCount, 2);
	assert.equal(accounts.inviteOpen(stored), false);
	const single = must(accounts.createCustomInvite(owner.id, { code: "JUST-ONE" }));
	assert.equal(single.maxUses, undefined, "1 use = classic single-use invite");
	assert.ok(accounts.revokeInvite("EARLY-ACCESS-TEST") && accounts.revokeInvite("JUST-ONE"));
	for (const u of [e1, e2]) accounts.deleteAccount(u.id);
});
