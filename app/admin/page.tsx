/** The platform owner's admin page (platform mode, multi-user branch). */
import { redirect } from "next/navigation";
import { currentUser, enterPageScope, multiUser } from "@/src/server";
import { pageSessionToken } from "@/app/page-scope";
import { AdminPanel } from "@/components/account/admin-panel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
	const token = await pageSessionToken();
	if (!enterPageScope(token)) redirect("/login?next=/admin");
	if (!multiUser || currentUser()?.role !== "owner") redirect("/");
	return <AdminPanel />;
}
