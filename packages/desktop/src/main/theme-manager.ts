import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, type BrowserWindow, type IpcMain, nativeTheme } from "electron";
import { DESKTOP_THEME_CHANNEL, type DesktopThemePreference } from "../shared/desktop-api.ts";

const THEME_FILE_NAME = "theme.json";

export const DARK_WINDOW_BACKGROUND = "#1f201e";
export const LIGHT_WINDOW_BACKGROUND = "#faf9f6";
export const WINDOWS_TITLE_BAR_HEIGHT = 32;
const WINDOWS_DARK_TITLE_BAR = "#121212";
const WINDOWS_LIGHT_TITLE_BAR = "#faf9f6";

export function isDesktopThemePreference(value: unknown): value is DesktopThemePreference {
	return value === "dark" || value === "light" || value === "system";
}

/** Resolve a preference to the concrete color scheme currently in effect. */
export function resolveTheme(theme: DesktopThemePreference): "dark" | "light" {
	if (theme === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
	return theme;
}

export function windowBackgroundFor(theme: DesktopThemePreference): string {
	return resolveTheme(theme) === "dark" ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
}

export function windowsTitleBarOverlayFor(theme: DesktopThemePreference): {
	readonly color: string;
	readonly symbolColor: string;
	readonly height: number;
} {
	return {
		color: resolveTheme(theme) === "dark" ? WINDOWS_DARK_TITLE_BAR : WINDOWS_LIGHT_TITLE_BAR,
		symbolColor: resolveTheme(theme) === "dark" ? "#e8e8e8" : "#202020",
		height: WINDOWS_TITLE_BAR_HEIGHT,
	};
}

function themeFilePath(): string {
	return join(app.getPath("userData"), THEME_FILE_NAME);
}

/** Read the persisted theme preference (defaults to "dark" for first runs). */
export function readStoredTheme(): DesktopThemePreference {
	try {
		const value: unknown = JSON.parse(readFileSync(themeFilePath(), "utf8"));
		if (isDesktopThemePreference(value)) return value;
	} catch {
		// missing or unreadable file: fall through to the default
	}
	return "dark";
}

/** Persist the theme preference so new windows start with the right background. */
export function storeTheme(theme: DesktopThemePreference): void {
	try {
		const path = themeFilePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(theme), "utf8");
	} catch {
		// persistence is best-effort; the renderer still applies the theme itself
	}
}

/** Apply the preference to native chrome (macOS titlebar, scrollbars) and the window background. */
export function applyThemeToWindow(window: BrowserWindow, theme: DesktopThemePreference): void {
	nativeTheme.themeSource = theme;
	if (window.isDestroyed()) return;
	window.setBackgroundColor(windowBackgroundFor(theme));
	if (process.platform === "win32") window.setTitleBarOverlay(windowsTitleBarOverlayFor(theme));
}

/**
 * Register the renderer -> main theme channel. The renderer owns the source of
 * truth (localStorage); this handler only mirrors it for window chrome.
 */
export function registerThemeHandlers(ipcMainHandle: IpcMain, getMainWindow: () => BrowserWindow | null): void {
	ipcMainHandle.handle(DESKTOP_THEME_CHANNEL, (_event, value: unknown) => {
		if (value === "get") return readStoredTheme();
		if (!isDesktopThemePreference(value)) throw new TypeError("Invalid theme preference");
		storeTheme(value);
		const window = getMainWindow();
		if (window) applyThemeToWindow(window, value);
	});
}
