/**
 * PLATFORM MODE page gate (multi-user branch). Server pages read data in
 * their own body, so they must know who is signed in BEFORE the first
 * store read:
 *
 *   const token = await pageSessionToken();      // cookie + store sync
 *   if (!enterPageScope(token)) redirect("/login"); // sync: binds the user
 *
 * The second line must stay in the page body (see enterPageScope).
 * Single-user mode: the gate always passes and binds nothing.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE, storeReady } from "@/src/server";

export async function pageSessionToken(): Promise<string | undefined> {
	const [jar] = await Promise.all([cookies(), storeReady()]);
	return jar.get(SESSION_COOKIE)?.value;
}
