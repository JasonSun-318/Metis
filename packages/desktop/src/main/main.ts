import { basename, join } from "node:path";
import {
	app,
	autoUpdater,
	type BrowserWindow,
	dialog,
	ipcMain,
	type OpenDialogOptions,
	utilityProcess,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { installAppProtocol, registerAppScheme } from "./app-protocol-scheme.ts";
import { AppServerSupervisor, type UtilityChild } from "./app-server-supervisor.ts";
import { ClientBroker } from "./client-broker.ts";
import { DiagnosticLog } from "./diagnostic-log.ts";
import { createProjectFolder } from "./project-folder.ts";
import { DesktopUpdater } from "./updater.ts";
import { createMainWindow, loadMainWindow } from "./window.ts";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const ARCMIND_UPDATE_FEED_URL: string | null;

registerAppScheme();

let mainWindow: BrowserWindow | null = null;
let allowQuit = false;

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
	const broker = new ClientBroker({
		ipcMain,
		supervisor,
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
	});
	const openMainWindow = async (): Promise<void> => {
		const window = createMainWindow();
		broker.attach(window);
		mainWindow = window;
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
			const options = {
				type: "info" as const,
				buttons: ["Restart and install", "Later"],
				defaultId: 0,
				cancelId: 1,
				title: "ArcMind update ready",
				message: "Restart ArcMind to install the downloaded update?",
				detail: "ArcMind will stop accepting new actions and safely stop the App Server before restarting.",
			};
			const result = mainWindow
				? await dialog.showMessageBox(mainWindow, options)
				: await dialog.showMessageBox(options);
			return result.response === 0;
		},
		prepareToInstall: async () => {
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
