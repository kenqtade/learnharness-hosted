"use client";
/**
 * The signed-in user's own account page (platform mode, multi-user
 * branch): name, password, sign out of this device or of every device.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchMe, sendJson, signOut, type MeUser } from "@/components/account/use-me";

export function Section({ title, children, description }: { title: string; description?: string; children: ReactNode }) {
	return (
		<section className="rounded-xl border bg-card p-5">
			<h2 className="text-sm font-medium">{title}</h2>
			{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
			<div className="mt-4">{children}</div>
		</section>
	);
}

export function Notice({ kind, text }: { kind: "ok" | "error"; text: string }) {
	return <p role={kind === "error" ? "alert" : "status"} className={`text-xs ${kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>{text}</p>;
}

export function PageFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
	return (
		<main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-10">
			<header>
				<h1 className="font-serif text-2xl">{title}</h1>
				{subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
			</header>
			{children}
		</main>
	);
}

export function AccountPanel() {
	const [user, setUser] = useState<MeUser | null>(null);
	const [name, setName] = useState("");
	const [nameMsg, setNameMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [pwMsg, setPwMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void fetchMe(true).then((m) => {
			if (m.user) {
				setUser(m.user);
				setName(m.user.name);
			}
		});
	}, []);

	async function saveName(e: FormEvent) {
		e.preventDefault();
		const { ok, data } = await sendJson<{ user: MeUser }>("/api/account", "PATCH", { name });
		setNameMsg(ok ? { kind: "ok", text: "Saved." } : { kind: "error", text: data.error ?? "Could not save." });
		if (ok) setUser(data.user);
	}

	async function changePassword(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		const { ok, data } = await sendJson("/api/account", "POST", { action: "password", current, next });
		setBusy(false);
		setPwMsg(ok ? { kind: "ok", text: "Password changed. Your other devices were signed out." } : { kind: "error", text: data.error ?? "Could not change the password." });
		if (ok) { setCurrent(""); setNext(""); }
	}

	async function signOutAll() {
		await sendJson("/api/account", "POST", { action: "signout-all" });
		window.location.assign("/login");
	}

	if (!user) return <PageFrame title="Account"><p className="text-sm text-muted-foreground">Loading…</p></PageFrame>;

	return (
		<PageFrame title="Account" subtitle={`${user.email} · ${user.role === "owner" ? "Platform owner" : "Member"}`}>
			<Section title="Profile">
				<form onSubmit={saveName} className="flex items-end gap-3">
					<label className="flex flex-1 flex-col gap-1.5 text-sm">
						<span className="text-muted-foreground">Name</span>
						<Input value={name} onChange={(e) => setName(e.target.value)} data-testid="account-name" />
					</label>
					<Button type="submit" variant="outline" className="cursor-pointer" data-testid="account-save-name">Save</Button>
				</form>
				{nameMsg && <div className="mt-2"><Notice {...nameMsg} /></div>}
			</Section>

			<Section title="Password" description="Changing it signs you out everywhere else.">
				<form onSubmit={changePassword} className="flex flex-col gap-3">
					<Input type="password" placeholder="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required data-testid="account-current-password" />
					<Input type="password" placeholder="New password (8+ characters)" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required data-testid="account-new-password" />
					<div className="flex items-center gap-3">
						<Button type="submit" variant="outline" disabled={busy} className="cursor-pointer" data-testid="account-change-password">Change password</Button>
						{pwMsg && <Notice {...pwMsg} />}
					</div>
				</form>
			</Section>

			<Section title="Sessions">
				<div className="flex flex-wrap gap-3">
					<Button type="button" variant="outline" className="cursor-pointer" onClick={() => void signOut()} data-testid="account-sign-out">Sign out</Button>
					<Button type="button" variant="outline" className="cursor-pointer" onClick={() => void signOutAll()} data-testid="account-sign-out-all">Sign out of all devices</Button>
				</div>
			</Section>
		</PageFrame>
	);
}
