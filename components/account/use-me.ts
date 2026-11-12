"use client";
/**
 * WHO AM I (platform mode, multi-user branch): one GET /api/auth/me per
 * page load, shared by every component that asks (sidebar account row,
 * keys section, account/admin pages). Single-user servers answer
 * {multiUser:false} and every account affordance stays hidden.
 */
import { useEffect, useState } from "react";

export interface MeUser {
	id: string;
	username: string;
	email?: string;
	name: string;
	role: "owner" | "member";
	createdAt: string;
	lastLoginAt?: string;
	disabled?: boolean;
}
export interface Me {
	multiUser: boolean;
	/** HOSTED FORK: browser uploads are offered (the paperclip is active). */
	uploads: boolean;
	user?: MeUser | null;
	platform?: { ownerExists: boolean; openSignups: boolean; setupConfigured: boolean };
}

let cached: Promise<Me> | null = null;

export function fetchMe(fresh = false): Promise<Me> {
	if (!cached || fresh) {
		cached = fetch("/api/auth/me", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<Me>) : { multiUser: false, uploads: false }))
			.catch(() => ({ multiUser: false, uploads: false }));
	}
	return cached;
}

/** null while loading. */
export function useMe(): Me | null {
	const [me, setMe] = useState<Me | null>(null);
	useEffect(() => {
		let live = true;
		void fetchMe().then((m) => live && setMe(m));
		return () => { live = false; };
	}, []);
	return me;
}

export async function signOut(): Promise<void> {
	await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
	cached = null;
	window.location.assign("/login");
}

/** Shared JSON helper for the account/admin screens. */
export async function sendJson<T = unknown>(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
	const res = await fetch(url, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	return { ok: res.ok, data };
}
