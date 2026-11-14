/** Sign in (platform mode, multi-user branch). Renders bare, outside the app frame (components/account/shell-switch.tsx). */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { multiUser } from "@/src/server";
import type { Metadata } from "next";
import { AuthForm } from "@/components/account/auth-form";

export const metadata: Metadata = { title: "Sign in · Learning Harness" };

export default function Page() {
	// HOSTED FORK: without accounts (LH_MULTI_USER unset) there is nothing to sign into.
	if (!multiUser) redirect("/");
	return (
		<Suspense>
			<AuthForm mode="login" />
		</Suspense>
	);
}
