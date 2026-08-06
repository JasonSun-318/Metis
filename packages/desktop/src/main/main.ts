import { basename, join } from "node:path";
import {
	app,
	autoUpdater,
	type BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	type OpenDialogOptions,
	powerSaveBlocker,
	shell,
	utilityProcess,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import type { DesktopWorkspaceEditState } from "../shared/desktop-api.ts";
import { installAppProtocol, registerAppScheme } from "./app-protocol-scheme.ts";
import { AppServerSupervisor, type UtilityChild } from "./app-server-supervisor.ts";
import { BrowserManager } from "./browser-manager.ts";
import { ClientBroker } from "./client-broker.ts";
import { DiagnosticLog } from "./diagnostic-log.ts";
import { createProjectFolder } from "./project-folder.ts";
import { createScheduleKeepAwake } from "./schedule-keep-awake.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { DesktopUpdater } from "./updater.ts";
import { createMainWindow, loadMainWindow } from "./window.ts";
import { resolveDesktopRipgrepPath, WorkspaceFileManager } from "./workspace-file-manager.ts";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const ARCMIND_UPDATE_FEED_URL: string | null;

registerAppScheme();

let mainWindow: BrowserWindow | null = null;
let allowQuit = false;
let workspaceEditState: DesktopWorkspaceEditState = { dirty: false, language: "en" };
const scheduleKeepAwake = createScheduleKeepAwake(powerSaveBlocker);

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
				"@arcmind",
				"app-server",
				"dist",
				"utility-entry.js",
			)
		: join(app.getAppPath(), "..", "app-server", "dist", "utility-entry.js");
	return utilityProcess.fork(entry, [], {
		serviceName: "ArcMind App Server",
		stdio: "pipe",
	}) as UtilityChild;
}

async function launch(): Promise<void> {
	await app.whenReady();
	installAppProtocol(MAIN_WINDOW_WEBPACK_ENTRY);
	const diagnostics = new DiagnosticLog({
		path: join(app.getPath("logs"), "app-server.log"),
		maxBytes: 5 * 1024 * 1024,
		backups: 2,
	});
	const supervisor = new AppServerSupervisor({ spawn: spawnAppServer, diagnostics });
	const terminalManager = new TerminalManager();
	const browserManager = new BrowserManager();
	const workspaceFiles = new WorkspaceFileManager({
		rgCommand: resolveDesktopRipgrepPath({ appPath: app.getAppPath(), isPackaged: app.isPackaged }),
		openPath: (path) => shell.openPath(path),
		showItemInFolder: (path) => shell.showItemInFolder(path),
		trashItem: (path) => shell.trashItem(path),
	});
	const broker = new ClientBroker({
		ipcMain,
		supervisor,
		terminalManager,
		browserManager,
		workspaceFiles,
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
			return result.canceled ? [] : result.filePaths.map((path) => ({ path, name: basename(path) }));
		},
		getDefaultProjectLocation: async () => join(app.getPath("home"), "ArcMind Projects"),
		createProjectFolder,
		setScheduleKeepAwake: (enabled) => scheduleKeepAwake.set(enabled),
	});
	const openMainWindow = async (): Promise<void> => {
		const window = createMainWindow();
		broker.attach(window);
		mainWindow = window;
		window.on("close", (event) => {
			if (!allowQuit && !confirmDiscardWorkspaceEdits(window, "close")) event.preventDefault();
		});
		window.on("closed", () => {
			if (mainWindow === window) mainWindow = null;
		});
		await loadMainWindow(window);
	};

	await supervisor.start().catch(() => supervisor.view());
	await openMainWindow();
	const updater = new DesktopUpdater({
		autoUpdater,
		feedUrl: ARCMIND_UPDATE_FEED_URL,
		isPackaged: app.isPackaged,
		platform: process.platform,
		confirmInstall: async () => {
			const zh = workspaceEditState.language === "zh";
			const options = {
				type: "info" as const,
				buttons: [zh ? "重新启动并安装" : "Restart and install", zh ? "稍后" : "Later"],
				defaultId: 0,
				cancelId: 1,
				title: zh ? "ArcMind 更新已就绪" : "ArcMind update ready",
				message: zh ? "重新启动 ArcMind 以安装更新？" : "Restart ArcMind to install the downloaded update?",
				detail: workspaceEditState.dirty
					? zh
						? "重新启动会放弃未保存的文件修改，并安全停止 App Server。"
						: "Restarting will discard unsaved file changes and safely stop the App Server."
					: zh
						? "ArcMind 将停止接受新操作，并安全停止 App Server 后重新启动。"
						: "ArcMind will stop accepting new actions and safely stop the App Server before restarting.",
			};
			const result = mainWindow
				? await dialog.showMessageBox(mainWindow, options)
				: await dialog.showMessageBox(options);
			if (result.response !== 0) return false;
			workspaceEditState = { ...workspaceEditState, dirty: false };
			return true;
		},
		prepareToInstall: async () => {
			scheduleKeepAwake.set(false);
			broker.dispose();
			await supervisor.shutdown();
			allowQuit = true;
		},
		onDiagnostic: (message) => void diagnostics.append("supervisor", `Updater: ${message}`),
	});
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
		console.error("ArcMind desktop failed to start.");
		app.quit();
	});
