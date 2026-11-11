"use client";
/**
 * The root shell picker (multi-user branch). The sign-in pages render BARE:
 * no sidebar, no activity dock, no events channel (a signed-out visitor
 * would only collect 401s from them). Every other route gets the full app
 * frame exactly as before.
 */
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { PluginsProvider } from "@/components/plugins";
import type { AppearanceSettings, Theme } from "@/src/core";

export const BARE_ROUTES = new Set(["/login", "/signup"]);

export function ShellSwitch({ children, initialAppearance, initialTheme }: { children: ReactNode; initialAppearance: AppearanceSettings | undefined; initialTheme: Theme }) {
	const pathname = usePathname();
	if (BARE_ROUTES.has(pathname)) return <AppearanceProvider initialAppearance={initialAppearance} initialTheme={initialTheme}>{children}</AppearanceProvider>;
	return (
		// The notification channel rides OUTSIDE everything: sidebar, dock,
		// and pages all subscribe as the polls retire (push S3, 2026-10-02).
		<ServerEventsProvider>
			<PluginsProvider>
				<AppearanceProvider initialAppearance={initialAppearance} initialTheme={initialTheme}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</PluginsProvider>
		</ServerEventsProvider>
	);
}
