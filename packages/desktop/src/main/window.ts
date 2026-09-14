import { BrowserWindow, nativeTheme, shell } from "electron";
import { APP_ORIGIN } from "./app-protocol-scheme.ts";
import { isSafeExternalUrl } from "./external-url.ts";
import { readStoredTheme, windowBackgroundFor, windowsTitleBarOverlayFor } from "./theme-manager.ts";

declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export function createMainWindow(): BrowserWindow {
	const theme = readStoredTheme();
	nativeTheme.themeSource = theme;
	const window = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 900,
		minHeight: 640,
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

	window.once("ready-to-show", () => window.show());
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
