import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import { APP_ORIGIN } from "./app-protocol-scheme.ts";
import { isSafeExternalUrl } from "./external-url.ts";
import { readStoredTheme, windowBackgroundFor, windowsTitleBarOverlayFor } from "./theme-manager.ts";
import {
	constrainWindowSize,
	MAIN_WINDOW_MIN_HEIGHT,
	MAIN_WINDOW_MIN_WIDTH,
	readStoredWindowPreferences,
	storeWindowPreferences,
} from "./window-preferences.ts";

declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export function createMainWindow(): BrowserWindow {
	const theme = readStoredTheme();
	nativeTheme.themeSource = theme;
	const preferencesPath = join(app.getPath("userData"), "window-preferences.json");
	const preferences = readStoredWindowPreferences(preferencesPath);
	const window = new BrowserWindow({
		...constrainWindowSize(preferences, screen.getPrimaryDisplay().workAreaSize),
		minWidth: MAIN_WINDOW_MIN_WIDTH,
		minHeight: MAIN_WINDOW_MIN_HEIGHT,
		show: false,
		backgroundColor: windowBackgroundFor(theme),
		...(process.platform === "darwin"
			? {
					titleBarStyle: "hiddenInset" as const,
					trafficLightPosition: { x: 13, y: 16 },
				}
			: process.platform === "win32"
				? {
						titleBarStyle: "hidden" as const,
						titleBarOverlay: windowsTitleBarOverlayFor(theme),
					}
				: {}),
		webPreferences: {
			preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
		},
	});

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	const clearSaveTimer = () => {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = undefined;
	};
	const savePreferences = () => {
		clearSaveTimer();
		if (window.isDestroyed()) return;
		const { width, height } = window.getNormalBounds();
		storeWindowPreferences(preferencesPath, { width, height, maximized: window.isMaximized() });
	};
	const scheduleSave = () => {
		clearSaveTimer();
		saveTimer = setTimeout(savePreferences, 250);
	};
	window.on("resize", scheduleSave);
	window.on("maximize", scheduleSave);
	window.on("unmaximize", scheduleSave);
	window.on("close", savePreferences);
	window.on("closed", clearSaveTimer);
	window.once("ready-to-show", () => {
		if (preferences.maximized) window.maximize();
		window.show();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
		return { action: "deny" };
	});
	window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	window.webContents.session.setPermissionCheckHandler(() => false);
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== `${APP_ORIGIN}/index.html`) event.preventDefault();
	});
	window.webContents.on("will-redirect", (event, url) => {
		if (url !== `${APP_ORIGIN}/index.html`) event.preventDefault();
	});
	return window;
}

export async function loadMainWindow(window: BrowserWindow): Promise<void> {
	await window.loadURL(`${APP_ORIGIN}/index.html`);
}
