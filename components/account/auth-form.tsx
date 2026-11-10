"use client";
/**
 * Sign in / create account (platform mode, multi-user branch). One form,
 * two modes, kept as short as possible (owner request): a username and a
 * password — plus an invite code when signing up. Sign-up adapts to the
 * platform state:
 * - no owner yet → asks for the owner setup code (LH_OWNER_SETUP_CODE);
 * - invite-only → asks for an invite code (prefilled from ?invite=);
 * - open sign-ups → neither.
 * On success the session cookie is already set; we go to ?next= or home.
 */
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LhMark } from "@/components/lh-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchMe, sendJson, type Me } from "@/components/account/use-me";

function safeNext(next: string | null): string {
	return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
	return (
		<label className="flex flex-col gap-1.5 text-sm">
			<span className="text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="text-xs text-muted-foreground">{hint}</span>}
		</label>
	);
}

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
	const params = useSearchParams();
	const [me, setMe] = useState<Me | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState(params.get("invite") ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void fetchMe(true).then((m) => {
			setMe(m);
			if (m.user) window.location.replace(safeNext(params.get("next")));
		});
	}, [params]);

	const platform = me?.platform;
	const claimingOwner = mode === "signup" && platform && !platform.ownerExists;
	const needsInvite = mode === "signup" && platform?.ownerExists && !platform.openSignups;

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		const payload =
			mode === "login"
				? { username, password }
				: { username, password, ...(claimingOwner ? { setupCode: code } : needsInvite ? { inviteCode: code } : {}) };
		const { ok, data } = await sendJson(`/api/auth/${mode}`, "POST", payload);
		if (!ok) {
			setError(data.error ?? "Something went wrong. Try again.");
			setBusy(false);
			return;
		}
		window.location.assign(safeNext(params.get("next")));
	}

	const title = mode === "login" ? "Sign in" : claimingOwner ? "Set up your platform" : "Create your account";

	return (
		<main className="flex min-h-dvh items-center justify-center p-6">
			<div className="w-full max-w-sm rounded-xl border bg-card p-7 shadow-xl" data-testid={`${mode}-card`}>
				<div className="mb-6 flex items-center gap-3">
					<LhMark className="size-7" />
					<div>
						<h1 className="text-lg font-medium">{title}</h1>
						<p className="text-xs text-muted-foreground">Learning Harness</p>
					</div>
				</div>

				{me && !me.multiUser ? (
					<p className="text-sm text-muted-foreground">
						Accounts are not enabled on this server. <Link className="underline" href="/">Open the app</Link>.
					</p>
				) : (
					<form onSubmit={submit} className="flex flex-col gap-4">
						{claimingOwner && (
							<p className="rounded-md border border-border bg-accent/40 p-3 text-xs text-muted-foreground">
								No one has set up this platform yet. The first account becomes the owner: it manages the API keys,
								the invites and the other accounts. Enter the owner setup code from the server settings.
							</p>
						)}
						<Field label="Username" hint={mode === "signup" ? "Letters, numbers, dot, dash or underscore (3–32)." : undefined}>
							<Input
								required autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
								autoComplete="username" autoCapitalize="none" spellCheck={false} data-testid="auth-username"
							/>
						</Field>
						<Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
							<Input
								type="password" required minLength={mode === "signup" ? 8 : undefined} value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoComplete={mode === "signup" ? "new-password" : "current-password"} data-testid="auth-password"
							/>
						</Field>
						{(claimingOwner || needsInvite) && (
							<Field label={claimingOwner ? "Owner setup code" : "Invite code"} hint={needsInvite ? "Ask the platform owner for an invite." : undefined}>
								<Input required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" data-testid="auth-code" />
							</Field>
						)}
						{error && <p role="alert" className="text-sm text-destructive" data-testid="auth-error">{error}</p>}
						<Button type="submit" disabled={busy || !me} className="cursor-pointer" data-testid="auth-submit">
							{busy ? "Please wait…" : mode === "login" ? "Sign in" : claimingOwner ? "Create owner account" : "Create account"}
						</Button>
						<p className="text-center text-xs text-muted-foreground">
							{mode === "login" ? (
								<>Have an invite? <Link className="underline" href={`/signup${params.size ? `?${params}` : ""}`}>Create your account</Link></>
							) : (
								<>Already have an account? <Link className="underline" href={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}>Sign in</Link></>
							)}
						</p>
					</form>
				)}
			</div>
		</main>
	);
}
