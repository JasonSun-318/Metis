import type { DesktopThemePreference } from "../shared/desktop-api.ts";

export const APP_THEME_STORAGE_KEY = "metis.theme.v1";

export type AppTheme = DesktopThemePreference;

export const APP_THEMES: readonly { readonly value: AppTheme; readonly label: string }[] = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
	{ value: "system", label: "Follow system" },
];

export function isAppTheme(value: unknown): value is AppTheme {
	return value === "dark" || value === "light" || value === "system";
}

export function loadTheme(storage: Pick<Storage, "getItem">): AppTheme {
	const value = storage.getItem(APP_THEME_STORAGE_KEY);
	return isAppTheme(value) ? value : "dark";
}

export function saveTheme(storage: Pick<Storage, "setItem">, theme: AppTheme): void {
	storage.setItem(APP_THEME_STORAGE_KEY, theme);
}

/** Resolve a preference to the concrete scheme, following the OS for "system". */
export function resolveTheme(theme: AppTheme, media: Pick<MediaQueryList, "matches">): "dark" | "light" {
	if (theme === "system") return media.matches ? "light" : "dark";
	return theme;
}

const LIGHT_MEDIA = "(prefers-color-scheme: light)";

/** Apply the resolved scheme to the document root (CSS switch for tokens.css). */
export function applyThemeToDocument(theme: AppTheme): void {
	const resolved = resolveTheme(theme, globalThis.matchMedia?.(LIGHT_MEDIA) ?? { matches: false });
	document.documentElement.dataset.theme = resolved;
}

/**
 * Watch for OS scheme changes while the preference is "system" and re-apply.
 * Returns a disposer.
 */
export function watchSystemTheme(onChange: () => void): () => void {
	if (typeof globalThis.matchMedia !== "function") return () => undefined;
	const media = globalThis.matchMedia(LIGHT_MEDIA);
	const listener = () => onChange();
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}
