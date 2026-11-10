/** The signed-in user's account page (platform mode, multi-user branch). */
import { redirect } from "next/navigation";
import { enterPageScope, multiUser } from "@/src/server";
import { pageSessionToken } from "@/app/page-scope";
import { AccountPanel } from "@/components/account/account-panel";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
	const token = await pageSessionToken();
	if (!enterPageScope(token)) redirect("/login?next=/account");
	if (!multiUser) redirect("/");
	return <AccountPanel />;
}
