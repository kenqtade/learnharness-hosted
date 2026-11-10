"use client";
/**
 * The platform owner's admin page (multi-user branch): accounts, invite
 * links, and whether strangers may sign up without an invite. Every call
 * here is owner-only on the server (routeAccess); this page is just the
 * controls.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sendJson, type MeUser } from "@/components/account/use-me";
import { Notice, PageFrame, Section } from "@/components/account/account-panel";

interface Invite { code: string; createdAt: string; expiresAt: string; note?: string; usedBy?: string; usedAt?: string }

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");

export function AdminPanel() {
	const [users, setUsers] = useState<MeUser[]>([]);
	const [invites, setInvites] = useState<Invite[]>([]);
	const [openSignups, setOpenSignups] = useState(false);
	const [note, setNote] = useState("");
	const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [u, i, c] = await Promise.all([
			sendJson<{ users: MeUser[] }>("/api/admin/users", "GET"),
			sendJson<{ invites: Invite[] }>("/api/admin/invites", "GET"),
			sendJson<{ openSignups: boolean }>("/api/admin/config", "GET"),
		]);
		if (!u.ok) { setMsg({ kind: "error", text: u.data.error ?? "Could not load accounts." }); return; }
		setUsers(u.data.users);
		setInvites(i.ok ? i.data.invites : []);
		setOpenSignups(c.ok && c.data.openSignups);
	}, []);
	useEffect(() => { void load(); }, [load]);

	const report = (ok: boolean, data: { error?: string }, success: string) =>
		setMsg(ok ? { kind: "ok", text: success } : { kind: "error", text: data.error ?? "Something went wrong." });

	async function toggleDisabled(u: MeUser) {
		const { ok, data } = await sendJson("/api/admin/users", "PATCH", { id: u.id, disabled: !u.disabled });
		report(ok, data, u.disabled ? `${u.name} can sign in again.` : `${u.name} is disabled and was signed out.`);
		await load();
	}
	async function remove(u: MeUser) {
		if (!window.confirm(`Delete ${u.name} (@${u.username}) and ALL of their sessions, notes and knowledge graph? This cannot be undone.`)) return;
		const { ok, data } = await sendJson(`/api/admin/users?id=${encodeURIComponent(u.id)}`, "DELETE");
		report(ok, data, `${u.name} was deleted.`);
		await load();
	}
	async function invite(e: FormEvent) {
		e.preventDefault();
		const { ok, data } = await sendJson<{ invite: Invite }>("/api/admin/invites", "POST", { note });
		report(ok, data, "Invite created. Copy the link and send it.");
		setNote("");
		await load();
	}
	async function revoke(code: string) {
		const { ok, data } = await sendJson(`/api/admin/invites?code=${encodeURIComponent(code)}`, "DELETE");
		report(ok, data, "Invite revoked.");
		await load();
	}
	async function setOpen(open: boolean) {
		const { ok, data } = await sendJson<{ openSignups: boolean }>("/api/admin/config", "PUT", { openSignups: open });
		report(ok, data, open ? "Anyone with the link can now create an account." : "New accounts now need an invite.");
		if (ok) setOpenSignups(data.openSignups);
	}
	const link = (code: string) => `${window.location.origin}/signup?invite=${code}`;
	async function copy(code: string) {
		await navigator.clipboard?.writeText(link(code)).catch(() => undefined);
		setCopied(code);
		setTimeout(() => setCopied(null), 1500);
	}

	const name = (id?: string) => users.find((u) => u.id === id)?.name ?? "a deleted account";
	const pending = invites.filter((i) => !i.usedBy && Date.parse(i.expiresAt) > Date.now());
	const used = invites.filter((i) => i.usedBy);

	return (
		<PageFrame title="Admin" subtitle="Manage who can use this platform. API keys and providers (Settings → Providers) are shared by every account.">
			{msg && <Notice {...msg} />}

			<Section title={`Accounts (${users.length})`}>
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm" data-testid="admin-users">
						<thead className="text-xs text-muted-foreground">
							<tr><th className="py-2 pr-3 font-normal">Name</th><th className="pr-3 font-normal">Username</th><th className="pr-3 font-normal">Role</th><th className="pr-3 font-normal">Last sign-in</th><th /></tr>
						</thead>
						<tbody>
							{users.map((u) => (
								<tr key={u.id} className="border-t border-border" data-testid={`admin-user-${u.username}`}>
									<td className="py-2 pr-3">{u.name}{u.disabled && <span className="ml-2 text-xs text-destructive">disabled</span>}</td>
									<td className="pr-3 text-muted-foreground">@{u.username}</td>
									<td className="pr-3">{u.role === "owner" ? "Owner" : "Member"}</td>
									<td className="pr-3 text-xs text-muted-foreground">{when(u.lastLoginAt)}</td>
									<td className="py-2 text-right">
										{u.role !== "owner" && (
											<div className="flex justify-end gap-2">
												<Button size="xs" variant="outline" className="cursor-pointer" onClick={() => void toggleDisabled(u)}>{u.disabled ? "Enable" : "Disable"}</Button>
												<Button size="xs" variant="destructive" className="cursor-pointer" onClick={() => void remove(u)}>Delete</Button>
											</div>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="Invites" description="Each invite link works once and expires after 14 days.">
				<form onSubmit={invite} className="flex gap-3">
					<Input placeholder="Who is it for? (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="admin-invite-note" />
					<Button type="submit" className="cursor-pointer" data-testid="admin-invite-create">Create invite</Button>
				</form>
				<ul className="mt-4 flex flex-col gap-2" data-testid="admin-invites">
					{pending.map((i) => (
						<li key={i.code} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
							<code className="font-mono" data-testid="admin-invite-code">{i.code}</code>
							{i.note && <span className="text-muted-foreground">· {i.note}</span>}
							<span className="text-muted-foreground">· expires {when(i.expiresAt)}</span>
							<span className="ml-auto flex gap-2">
								<Button size="xs" variant="outline" className="cursor-pointer" onClick={() => void copy(i.code)}>{copied === i.code ? "Copied" : "Copy link"}</Button>
								<Button size="xs" variant="ghost" className="cursor-pointer" onClick={() => void revoke(i.code)}>Revoke</Button>
							</span>
						</li>
					))}
					{!pending.length && <li className="text-xs text-muted-foreground">No open invites.</li>}
				</ul>
				{used.length > 0 && (
					<p className="mt-3 text-xs text-muted-foreground">Used: {used.map((i) => `${i.code} → ${name(i.usedBy)}`).join(", ")}</p>
				)}
			</Section>

			<Section title="Sign-ups">
				<label className="flex items-center gap-3 text-sm">
					<input type="checkbox" className="size-4 cursor-pointer accent-current" checked={openSignups} onChange={(e) => void setOpen(e.target.checked)} data-testid="admin-open-signups" />
					<span>Let anyone create an account without an invite</span>
				</label>
				<p className="mt-2 text-xs text-muted-foreground">Every account uses your API keys, so their usage counts against your provider limits.</p>
			</Section>
		</PageFrame>
	);
}
