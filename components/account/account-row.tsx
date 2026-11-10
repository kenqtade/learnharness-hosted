"use client";
/**
 * The sidebar's account entries (platform mode, multi-user branch), under
 * Settings in the same quiet row language: who is signed in, Account,
 * Admin (owner only), Sign out. Single-user servers render nothing.
 */
import Link from "next/link";
import { LogOutIcon, ShieldIcon, UserIcon } from "lucide-react";
import { signOut, useMe } from "@/components/account/use-me";

const row = "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function AccountRow() {
	const me = useMe();
	if (!me?.multiUser || !me.user) return null;
	return (
		<div className="mt-1 flex flex-col" data-testid="account-row">
			<Link href="/account" className={row} data-testid="account-entry" title={me.user.email}>
				<UserIcon className="size-3" />
				<span className="truncate normal-case tracking-normal">{me.user.name}</span>
			</Link>
			{me.user.role === "owner" && (
				<Link href="/admin" className={row} data-testid="admin-entry">
					<ShieldIcon className="size-3" />
					Admin
				</Link>
			)}
			<button type="button" onClick={() => void signOut()} className={row} data-testid="sign-out-entry">
				<LogOutIcon className="size-3" />
				Sign out
			</button>
		</div>
	);
}
