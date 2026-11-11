/**
 * THE FIRST-PAINT THEME (theme wave, 2026-11-04): what app/layout.tsx puts
 * on <html> before any client code runs — the record's appearance, the
 * active theme (a preset or an imported file; Default when the id is gone)
 * and its color variables with every override applied. Read the record
 * and only the selected custom file (the layout calls connection()
 * first, so this never bakes into a prerender).
 */

import { effectiveColors, isBuiltinThemeId, resolveTheme, themeVars, type AppearanceSettings, type Theme } from "../core";
import { themeStore } from "../store/themes.ts";
import { readSettings } from "../store/settings.ts";
import { multiUser, runAsUser } from "../store/user-scope.ts";
import { cookieValue, verifySession } from "./accounts.ts";

/** Everything the layout needs for a flash-free first paint. */
export interface ThemeBoot {
	appearance: AppearanceSettings | undefined;
	theme: Theme;
	/** The CSS variables for <html style>. */
	vars: Record<string, string>;
}

/** Read the record and selected custom file; resolve the active theme and its vars. */
export function readThemeBoot(): ThemeBoot {
	const appearance = readSettings()?.appearance;
	const id = appearance?.theme;
	const custom = id && !isBuiltinThemeId(id) ? themeStore.readTheme(id) : null;
	const theme = resolveTheme(id, custom ? [custom] : []);
	return { appearance, theme, vars: themeVars(effectiveColors(theme, appearance), theme.mode) };
}

/** MULTI-USER (merge of v0.6.0): the layout renders outside withStore, so in
 *  platform mode it resolves the session cookie itself and reads the SIGNED-IN
 *  member's appearance (a signed-out visitor gets the default theme, never
 *  the owner's record). Single-user mode is exactly readThemeBoot(). */
export function readThemeBootFor(cookieHeader: string | null | undefined): ThemeBoot {
	if (!multiUser) return readThemeBoot();
	const session = verifySession(cookieValue(cookieHeader));
	if (!session) {
		const theme = resolveTheme(undefined, []);
		return { appearance: undefined, theme, vars: themeVars(effectiveColors(theme, undefined), theme.mode) };
	}
	return runAsUser({ id: session.id, role: session.role }, readThemeBoot);
}
