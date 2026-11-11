import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import { headers } from "next/headers";
import "katex/dist/katex.min.css";
import "./globals.css";
import { ShellSwitch } from "@/components/account/shell-switch";
import UpdateBanner from "@/components/update-banner";
import DeployRefreshBanner from "@/components/deploy-refresh-banner";
import { readThemeBootFor } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBootFor((await headers()).get("cookie"));
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased">
			{/* Platform mode: /login and /signup render bare; everything else
			    gets the full app frame (components/account/shell-switch.tsx). */}
			<ShellSwitch initialAppearance={appearance} initialTheme={theme}>{children}</ShellSwitch>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			{/* Hosted refresh banner: a newer deployment is live (auto-update). */}
			<DeployRefreshBanner />
		</body>
		</html>
	);
}
