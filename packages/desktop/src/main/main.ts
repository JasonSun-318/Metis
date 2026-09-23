import { basename, extname, join } from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	Notification,
	nativeImage,
	type OpenDialogOptions,
	powerSaveBlocker,
	session,
	shell,
	utilityProcess,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import {
	DESKTOP_FULLSCREEN_CHANNEL,
	DESKTOP_IS_FULLSCREEN_CHANNEL,
	DESKTOP_UPDATE_EVENT_CHANNEL,
	type DesktopAttachmentSelection,
	type DesktopWorkspaceEditState,
} from "../shared/desktop-api.ts";
import { installAppProtocol, registerAppScheme } from "./app-protocol-scheme.ts";
import { AppServerSupervisor, type UtilityChild } from "./app-server-supervisor.ts";
import { createBackgroundCompletionTracker } from "./background-completion.ts";
import { BrowserManager } from "./browser-manager.ts";
import { loadDesktopChangelog } from "./changelog.ts";
import { ClientBroker } from "./client-broker.ts";
import { DiagnosticLog } from "./diagnostic-log.ts";
import { createProjectFolder } from "./project-folder.ts";
import { createScheduleKeepAwake } from "./schedule-keep-awake.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { registerThemeHandlers } from "./theme-manager.ts";
import { DesktopUpdater } from "./updater.ts";
import { createMainWindow, loadMainWindow } from "./window.ts";
import { createWindowsSandboxSetup, repairWindowsSandboxAccess } from "./windows-sandbox-setup.ts";
import { resolveDesktopRipgrepPath, WorkspaceFileManager } from "./workspace-file-manager.ts";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const METIS_UPDATE_BASE_URL: string | null;

registerAppScheme();
const explicitUserData = app.commandLine.hasSwitch("user-data-dir");
if (!explicitUserData) app.setPath("userData", join(app.getPath("appData"), "Metis"));
if (process.platform === "win32") app.setAppUserModelId("com.squirrel.Metis.Metis");

let mainWindow: BrowserWindow | null = null;
let allowQuit = false;
let workspaceEditState: DesktopWorkspaceEditState = { dirty: false, language: "en", visibleSessionId: null };
const scheduleKeepAwake = createScheduleKeepAwake(powerSaveBlocker);

// app.isActive() is macOS-only; on other platforms treat a focused window as active.
function isAppActive(): boolean {
	if (process.platform === "darwin") return app.isActive();
	return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
}

const attachmentImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

async function attachmentSelection(path: string): Promise<DesktopAttachmentSelection> {
	const selection = { path, name: basename(path) };
	if (!attachmentImageExtensions.has(extname(path).toLowerCase())) return selection;
	try {
		const thumbnail = await nativeImage.createThumbnailFromPath(path, { width: 96, height: 96 });
		return thumbnail.isEmpty() ? selection : { ...selection, previewDataUrl: thumbnail.toDataURL() };
	} catch {
		return selection;
	}
}

function confirmDiscardWorkspaceEdits(window: BrowserWindow | null, action: "close" | "quit"): boolean {
	if (!workspaceEditState.dirty) return true;
	const zh = workspaceEditState.language === "zh";
	const options = {
		type: "warning" as const,
		buttons: [zh ? "放弃修改" : "Discard changes", zh ? "取消" : "Cancel"],
		defaultId: 1,
		cancelId: 1,
		title: zh ? "有未保存的文件" : "Unsaved files",
		message: zh ? "仍有文件修改尚未保存。" : "Some file changes have not been saved.",
		detail: zh
			? `继续${action === "close" ? "关闭窗口" : "退出"}会丢失这些修改。`
			: `Continuing to ${action === "close" ? "close the window" : "quit"} will discard them.`,
	};
	const response = window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
	if (response !== 0) return false;
	workspaceEditState = { ...workspaceEditState, dirty: false };
	return true;
}

function spawnAppServer(): UtilityChild {
	const entry = app.isPackaged
		? join(
				app.getAppPath(),
				".webpack",
				"app-server",
				"node_modules",
				"@metis",
				"app-server",
				"dist",
				"utility-entry.js",
			)
		: join(app.getAppPath(), "..", "app-server", "dist", "utility-entry.js");
	return utilityProcess.fork(entry, [], {
		serviceName: "Metis App Server",
		stdio: "pipe",
	}) as UtilityChild;
}

async function launch(): Promise<void> {
	await app.whenReady();
	// Route kill signals through the normal quit path so shutdown flushes
	// renderer storage and winds down the app-server; a second signal hits the
	// Node default (immediate exit) once each listener is consumed.
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => app.quit());
	}
	// Windows and Linux show the stock File/Edit/View menu; remove it. macOS
	// keeps its system menu bar at the top of the screen.
	if (process.platform !== "darwin") Menu.setApplicationMenu(null);
	installAppProtocol(MAIN_WINDOW_WEBPACK_ENTRY);
	const diagnostics = new DiagnosticLog({
		path: join(app.getPath("logs"), "app-server.log"),
		maxBytes: 5 * 1024 * 1024,
		backups: 2,
	});
	try {
		await repairWindowsSandboxAccess({
			appPath: app.getAppPath(),
			architecture: process.arch,
			isPackaged: app.isPackaged,
			platform: process.platform,
		});
	} catch (cause) {
		await diagnostics.append("supervisor", `Windows sandbox access repair failed: ${String(cause)}`);
	}
	const supervisor = new AppServerSupervisor({ spawn: spawnAppServer, diagnostics });
	const terminalManager = new TerminalManager();
	const browserManager = new BrowserManager();
	const workspaceFiles = new WorkspaceFileManager({
		rgCommand: resolveDesktopRipgrepPath({ appPath: app.getAppPath(), isPackaged: app.isPackaged }),
		openPath: (path) => shell.openPath(path),
		showItemInFolder: (path) => shell.showItemInFolder(path),
		trashItem: (path) => shell.trashItem(path),
	});
	const updater = new DesktopUpdater({
		arch: process.arch,
		baseUrl: METIS_UPDATE_BASE_URL,
		currentVersion: app.getVersion(),
		downloadsDirectory: join(app.getPath("temp"), "Metis", "updates"),
		fetch: globalThis.fetch,
		isPackaged: app.isPackaged,
		onDiagnostic: (message) => void diagnostics.append("supervisor", `Updater: ${message}`),
		onState: (state) => {
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_UPDATE_EVENT_CHANNEL, state);
		},
		openPath: (path) => shell.openPath(path),
		platform: process.platform,
	});
	const installWorkspaceSandbox = createWindowsSandboxSetup({
		appPath: app.getAppPath(),
		architecture: process.arch,
		isPackaged: app.isPackaged,
		platform: process.platform,
	});
	const deliveredNotifications = new Set<Notification>();
	let suppressNextFocusAcknowledgement = false;
	const completionTracker = createBackgroundCompletionTracker({
		isActive: () => isAppActive(),
		setBadgeCount: (count) => {
			if (process.platform === "darwin") app.setBadgeCount(count);
		},
		notify: ({ sessionId, mode, name, outcome }) => {
			if (!Notification.isSupported()) return;
			const zh = workspaceEditState.language === "zh";
			const taskName = name || (zh ? "当前任务" : "Current task");
			const success = outcome === "completed";
			const notification = new Notification({
				title: zh
					? `Metis · ${success ? "任务已完成" : "任务执行失败"}`
					: `Metis · ${success ? "Task completed" : "Task failed"}`,
				body: zh
					? `“${taskName}”${success ? "已完成，点击查看结果。" : "未完成，点击查看详情。"}`
					: `“${taskName}” ${success ? "completed. Click to view the result." : "failed. Click to view details."}`,
			});
			const release = () => deliveredNotifications.delete(notification);
			notification.on("click", () => {
				release();
				suppressNextFocusAcknowledgement = true;
				broker.requestRendererOpenSession(sessionId, mode);
				void (async () => {
					if (!mainWindow || mainWindow.isDestroyed()) await openMainWindow();
					if (!mainWindow || mainWindow.isDestroyed()) return;
					if (mainWindow.isMinimized()) mainWindow.restore();
					mainWindow.show();
					mainWindow.focus();
				})().catch(() => {
					suppressNextFocusAcknowledgement = false;
				});
			});
			notification.on("close", release);
			notification.on("failed", release);
			deliveredNotifications.add(notification);
			notification.show();
		},
	});
	const broker = new ClientBroker({
		ipcMain,
		supervisor,
		terminalManager,
		browserManager,
		workspaceFiles,
		openPath: (path) => shell.openPath(path),
		writeClipboardText: (text) => clipboard.writeText(text),
		setWorkspaceEditState: (state) => {
			workspaceEditState = state;
		},
		selectProjectFolder: async () => {
			const options: OpenDialogOptions = {
				title: "Choose a project or folder",
				properties: ["openDirectory", "createDirectory"],
			};
			const result = mainWindow
				? await dialog.showOpenDialog(mainWindow, options)
				: await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		},
		selectAttachmentFiles: async () => {
			const options: OpenDialogOptions = {
				title: "Add files or photos",
				properties: ["openFile", "multiSelections"],
			};
			const result = mainWindow
				? await dialog.showOpenDialog(mainWindow, options)
				: await dialog.showOpenDialog(options);
			return result.canceled ? [] : await Promise.all(result.filePaths.map(attachmentSelection));
		},
		getDefaultProjectLocation: async () => join(app.getPath("home"), "Metis Projects"),
		createProjectFolder,
		setScheduleKeepAwake: (enabled) => scheduleKeepAwake.set(enabled),
		loadChangelog: () =>
			loadDesktopChangelog({ baseUrl: METIS_UPDATE_BASE_URL, platform: process.platform, fetch: globalThis.fetch }),
		updater,
		installWorkspaceSandbox,
		onDiagnostic: (message) => void diagnostics.append("supervisor", `Client broker: ${message}\n`),
		onSessionUpdated: (session) => completionTracker.update(session),
		onSessionDeleted: (sessionId) => completionTracker.forgetSession(sessionId),
		onProjectDeleted: (mode, cwd) => completionTracker.forgetProject(mode, cwd),
		onUserInterruptPending: (sessionId, pending) => completionTracker.setUserInterruptPending(sessionId, pending),
		onSessionOpened: (sessionId) => {
			suppressNextFocusAcknowledgement = false;
			if (isAppActive()) completionTracker.view(sessionId);
		},
	});
	registerThemeHandlers(ipcMain, () => mainWindow);
	ipcMain.handle(DESKTOP_IS_FULLSCREEN_CHANNEL, () => {
		return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isFullScreen() : false;
	});
	async function openMainWindow(): Promise<void> {
		const window = createMainWindow();
		broker.attach(window);
		mainWindow = window;
		window.on("enter-full-screen", () => {
			if (!window.isDestroyed()) window.webContents.send(DESKTOP_FULLSCREEN_CHANNEL, true);
		});
		window.on("leave-full-screen", () => {
			if (!window.isDestroyed()) window.webContents.send(DESKTOP_FULLSCREEN_CHANNEL, false);
		});
		window.on("focus", () => {
			if (suppressNextFocusAcknowledgement) {
				suppressNextFocusAcknowledgement = false;
				return;
			}
			if (workspaceEditState.visibleSessionId) completionTracker.view(workspaceEditState.visibleSessionId);
		});
		window.on("close", (event) => {
			if (!allowQuit && !confirmDiscardWorkspaceEdits(window, "close")) event.preventDefault();
		});
		window.on("closed", () => {
			if (mainWindow === window) mainWindow = null;
		});
		await loadMainWindow(window);
	}

	await supervisor.start().catch(() => supervisor.view());
	await openMainWindow();
	updater.start();

	app.on("activate", () => {
		if (mainWindow === null) {
			void openMainWindow().catch(() => undefined);
		}
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	app.on("before-quit", (event) => {
		if (allowQuit) return;
		event.preventDefault();
		if (!confirmDiscardWorkspaceEdits(mainWindow, "quit")) return;
		// Commit pending DOM-storage writes before teardown; the shutdown below
		// can take seconds and an abrupt exit would drop them.
		void session.defaultSession.flushStorageData();
		scheduleKeepAwake.set(false);
		broker.dispose();
		void supervisor.shutdown().finally(() => {
			allowQuit = true;
			app.quit();
		});
	});
}

if (squirrelStartup) app.quit();
else
	void launch().catch(() => {
		console.error("Metis desktop failed to start.");
		app.quit();
	});
