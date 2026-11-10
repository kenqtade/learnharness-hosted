/** Create account (platform mode, multi-user branch). Renders bare, outside the app frame (components/account/shell-switch.tsx). */
import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "@/components/account/auth-form";

export const metadata: Metadata = { title: "Create account · Learning Harness" };

export default function Page() {
	return (
		<Suspense>
			<AuthForm mode="signup" />
		</Suspense>
	);
}
