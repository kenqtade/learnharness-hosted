/** Sign in (platform mode, multi-user branch). Renders bare, outside the app frame (components/account/shell-switch.tsx). */
import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "@/components/account/auth-form";

export const metadata: Metadata = { title: "Sign in · Learning Harness" };

export default function Page() {
	return (
		<Suspense>
			<AuthForm mode="login" />
		</Suspense>
	);
}
