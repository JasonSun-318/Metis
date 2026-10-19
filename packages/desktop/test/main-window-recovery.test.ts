import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
	type Handler = (...args: unknown[]) => void;

	const appHandlers = new Map<string, Handler>();
	const windows: FakeWindow[] = [];
	const notifications: FakeNotification[] = [];
	const diagnosticAppend = vi.fn<(source: string, chunk: string) => Promise<void>>(async () => undefined);
	const completionTracker = {
		update: vi.fn(),
		view: vi.fn(),
		forgetSession: vi.fn(),
		forgetProject: vi.fn(),
		setUserInterruptPending: vi.fn(),
	};
	let completionOptions: Record<string, unknown> | undefined;
	let brokerOptions: Record<string, unknown> | undefined;
	const windowState = {
		load: vi.fn<(window: FakeWindow) => Promise<void>>(async () => undefined),
	};

	class FakeWindow {
		destroyed = false;
		readonly listeners = new Map<string, Handler>();
		readonly webContents = { on: vi.fn(), send: vi.fn() };
		readonly on = vi.fn((event: string, listener: Handler) => {
			this.listeners.set(event, listener);
			return this;
		});
		readonly isDestroyed = () => this.destroyed;
		readonly isFullScreen = () => false;
		readonly isMinimized = () => false;
		readonly restore = vi.fn();
		readonly show = vi.fn();
		readonly focus = vi.fn();

		emit(event: string, ...args: unknown[]): void {
			this.listeners.get(event)?.(...args);
		}
	}

	class FakeNotification {
		static isSupported = () => true;
		readonly handlers = new Map<string, Handler>();
		readonly show = vi.fn();

		constructor() {
			notifications.push(this);
		}

		on(event: string, listener: Handler): this {
			this.handlers.set(event, listener);
			return this;
		}

		emit(event: string): void {
			this.handlers.get(event)?.();
		}
	}

	const app = {
		commandLine: { hasSwitch: () => false },
		setPath: vi.fn(),
		setAppUserModelId: vi.fn(),
		getPath: (name: string) => `/tmp/metis-desktop-test/${name}`,
		getAppPath: () => "/tmp/metis-desktop-test/app",
		isPackaged: false,
		whenReady: vi.fn(async () => undefined),
		quit: vi.fn(),
		on: vi.fn((event: string, listener: Handler) => {
			appHandlers.set(event, listener);
			return app;
		}),
		isActive: () => false,
		setBadgeCount: vi.fn(),
		getVersion: () => "0.0.8",
	};

	return {
		app,
		appHandlers,
		brokerOptions: {
			get value() {
				return brokerOptions;
			},
			set value(options: Record<string, unknown> | undefined) {
				brokerOptions = options;
			},
		},
		completionOptions: {
			get value() {
				return completionOptions;
			},
			set value(options: Record<string, unknown> | undefined) {
				completionOptions = options;
			},
		},
		completionTracker,
		diagnosticAppend,
		FakeNotification,
		FakeWindow,
		notifications,
		windowState,
		windows,
	};
});

vi.mock("electron", () => ({
	app: state.app,
	BrowserWindow: { getAllWindows: () => state.windows },
	clipboard: { writeText: vi.fn() },
	dialog: { showOpenDialog: vi.fn(), showMessageBoxSync: vi.fn() },
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	Menu: { setApplicationMenu: vi.fn() },
	Notification: state.FakeNotification,
	nativeImage: { createThumbnailFromPath: vi.fn() },
	powerSaveBlocker: {},
	session: { defaultSession: { flushStorageData: vi.fn() } },
	shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
	utilityProcess: { fork: vi.fn() },
}));

vi.mock("electron-squirrel-startup", () => ({ default: false }));
vi.mock("../src/main/app-protocol-scheme.ts", () => ({
	installAppProtocol: vi.fn(),
	registerAppScheme: vi.fn(),
}));
vi.mock("../src/main/app-server-supervisor.ts", () => ({
	AppServerSupervisor: class {
		readonly start = vi.fn(async () => ({ state: "ready", serverEpoch: null, restartAttempt: 0, failure: null }));
		readonly view = vi.fn(() => ({ state: "ready", serverEpoch: null, restartAttempt: 0, failure: null }));
		readonly shutdown = vi.fn(async () => undefined);
	},
}));
vi.mock("../src/main/background-completion.ts", () => ({
	createBackgroundCompletionTracker: (options: Record<string, unknown>) => {
		state.completionOptions.value = options;
		return state.completionTracker;
	},
}));
vi.mock("../src/main/browser-manager.ts", () => ({ BrowserManager: class {} }));
vi.mock("../src/main/changelog.ts", () => ({ loadDesktopChangelog: vi.fn(async () => ({ releases: [] })) }));
vi.mock("../src/main/client-broker.ts", () => ({
	ClientBroker: class {
		readonly attach = vi.fn();
		readonly requestRendererOpenSession = vi.fn();
		readonly requestRendererCloseTab = vi.fn();
		readonly assertTrustedSender = vi.fn();
		readonly dispose = vi.fn();

		constructor(options: Record<string, unknown>) {
			state.brokerOptions.value = options;
		}
	},
}));
vi.mock("../src/main/close-tab-shortcut.ts", () => ({ isCloseTabShortcut: () => false }));
vi.mock("../src/main/diagnostic-log.ts", () => ({
	DiagnosticLog: class {
		readonly append = state.diagnosticAppend;
		readonly flush = vi.fn(async () => undefined);
	},
}));
vi.mock("../src/main/project-folder.ts", () => ({ createProjectFolder: vi.fn(async () => "") }));
vi.mock("../src/main/schedule-keep-awake.ts", () => ({
	createScheduleKeepAwake: () => ({ set: vi.fn() }),
}));
vi.mock("../src/main/terminal-manager.ts", () => ({ TerminalManager: class {} }));
vi.mock("../src/main/theme-manager.ts", () => ({ registerThemeHandlers: vi.fn() }));
vi.mock("../src/main/updater.ts", () => ({
	DesktopUpdater: class {
		readonly start = vi.fn();
	},
}));
vi.mock("../src/main/window.ts", () => ({
	createMainWindow: () => {
		const window = new state.FakeWindow();
		state.windows.push(window);
		return window;
	},
	loadMainWindow: (window: InstanceType<typeof state.FakeWindow>) => state.windowState.load(window),
}));
vi.mock("../src/main/windows-sandbox-setup.ts", () => ({
	repairWindowsSandboxAccess: vi.fn(async () => true),
	createWindowsSandboxSetup: vi.fn(() => vi.fn()),
}));
vi.mock("../src/main/workspace-file-manager.ts", () => ({
	resolveDesktopRipgrepPath: () => "/tmp/rg",
	WorkspaceFileManager: class {},
}));

async function importLaunch(): Promise<void> {
	(globalThis as Record<string, unknown>).MAIN_WINDOW_WEBPACK_ENTRY = "http://localhost/index.html";
	(globalThis as Record<string, unknown>).METIS_UPDATE_BASE_URL = null;
	await import("../src/main/main.ts");
	await vi.waitFor(() => expect(state.appHandlers.has("activate")).toBe(true));
}

function setVisibleSession(sessionId: string): void {
	const brokerOptions = state.brokerOptions.value as {
		setWorkspaceEditState?: (state: unknown) => void;
	};
	brokerOptions.setWorkspaceEditState?.({
		dirty: false,
		language: "en",
		visibleSessionId: sessionId,
	});
}

function clickNotification(sessionId: string): void {
	const completionOptions = state.completionOptions.value as {
		notify?: (notification: unknown) => void;
	};
	completionOptions.notify?.({
		sessionId,
		mode: "chat",
		name: "Background task",
		outcome: "completed",
	});
	state.notifications.at(-1)?.emit("click");
}

async function captureUnhandledRejections(run: () => Promise<void>): Promise<void> {
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(unhandled).not.toHaveBeenCalled();
	} finally {
		process.off("unhandledRejection", unhandled);
	}
}

beforeEach(() => {
	vi.resetModules();
	state.appHandlers.clear();
	state.windows.length = 0;
	state.notifications.length = 0;
	state.completionOptions.value = undefined;
	state.brokerOptions.value = undefined;
	state.diagnosticAppend.mockReset().mockResolvedValue(undefined);
	state.windowState.load.mockReset().mockResolvedValue(undefined);
	for (const tracker of Object.values(state.completionTracker)) tracker.mockReset();
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).MAIN_WINDOW_WEBPACK_ENTRY;
	delete (globalThis as Record<string, unknown>).METIS_UPDATE_BASE_URL;
});

describe("main window recovery", () => {
	it("reports a Dock activate reopen failure and leaves no unhandled rejection", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		state.diagnosticAppend.mockRejectedValueOnce(new Error("diagnostic log unavailable"));
		state.windowState.load.mockRejectedValueOnce(new Error("renderer load failed"));

		state.appHandlers.get("activate")?.();

		await vi.waitFor(() =>
			expect(state.diagnosticAppend).toHaveBeenCalledWith(
				"supervisor",
				expect.stringMatching(/activate.*renderer load failed/i),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("reports a Dock activate reopen when the window closes during load", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		state.windowState.load.mockImplementationOnce(async (window) => {
			window.emit("closed");
		});

		state.appHandlers.get("activate")?.();

		await vi.waitFor(() =>
			expect(state.diagnosticAppend).toHaveBeenCalledWith(
				"supervisor",
				expect.stringMatching(/activate.*closed or destroyed during reopen/i),
			),
		);
	});

	it("reports a Dock activate reopen when the window is destroyed during load", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		state.windowState.load.mockImplementationOnce(async (window) => {
			window.destroyed = true;
		});

		state.appHandlers.get("activate")?.();

		await vi.waitFor(() =>
			expect(state.diagnosticAppend).toHaveBeenCalledWith(
				"supervisor",
				expect.stringMatching(/activate.*closed or destroyed during reopen/i),
			),
		);
	});

	it("reports a notification reopen failure and clears pending focus suppression", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		const brokerOptions = state.brokerOptions.value as {
			setWorkspaceEditState?: (state: unknown) => void;
		};
		brokerOptions.setWorkspaceEditState?.({
			dirty: false,
			language: "en",
			visibleSessionId: "session-1",
		});
		state.windowState.load.mockRejectedValueOnce(new Error("renderer load failed"));

		const completionOptions = state.completionOptions.value as {
			notify?: (notification: unknown) => void;
		};
		completionOptions.notify?.({
			sessionId: "session-1",
			mode: "chat",
			name: "Background task",
			outcome: "completed",
		});
		state.notifications.at(-1)?.emit("click");

		await vi.waitFor(() =>
			expect(state.diagnosticAppend).toHaveBeenCalledWith(
				"supervisor",
				expect.stringMatching(/notification.*renderer load failed/i),
			),
		);
		expect(state.completionTracker.view).not.toHaveBeenCalled();

		state.windows.at(-1)?.emit("focus");
		expect(state.completionTracker.view).toHaveBeenCalledWith("session-1");
	});

	it("keeps normal focus acknowledgement behaviour without a reopen failure", async () => {
		await importLaunch();
		setVisibleSession("session-2");

		state.windows[0].emit("focus");

		expect(state.completionTracker.view).toHaveBeenCalledWith("session-2");
	});

	it("clears notification focus suppression when the reopened window closes during load", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		setVisibleSession("session-closed");
		state.windowState.load.mockImplementationOnce(async (window) => {
			window.emit("closed");
		});

		clickNotification("session-closed");

		await vi.waitFor(() =>
			expect(state.diagnosticAppend).toHaveBeenCalledWith(
				"supervisor",
				expect.stringMatching(/notification.*closed or destroyed during reopen/i),
			),
		);
		expect(state.completionTracker.view).not.toHaveBeenCalled();

		state.appHandlers.get("activate")?.();
		await vi.waitFor(() => expect(state.windows).toHaveLength(3));
		state.windows.at(-1)?.emit("focus");
		expect(state.completionTracker.view).toHaveBeenCalledWith("session-closed");
	});

	it("clears notification focus suppression when the reopened window is destroyed during load", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		setVisibleSession("session-destroyed");
		state.windowState.load.mockImplementationOnce(async (window) => {
			window.destroyed = true;
		});

		clickNotification("session-destroyed");

		await vi.waitFor(() =>
			expect(state.diagnosticAppend).toHaveBeenCalledWith(
				"supervisor",
				expect.stringMatching(/notification.*closed or destroyed during reopen/i),
			),
		);
		expect(state.completionTracker.view).not.toHaveBeenCalled();

		state.windows.at(-1)?.emit("closed");
		state.appHandlers.get("activate")?.();
		await vi.waitFor(() => expect(state.windows).toHaveLength(3));
		state.windows.at(-1)?.emit("focus");
		expect(state.completionTracker.view).toHaveBeenCalledWith("session-destroyed");
	});

	it("consumes a successful notification focus acknowledgement exactly once", async () => {
		await importLaunch();
		setVisibleSession("session-ack");

		clickNotification("session-ack");
		await vi.waitFor(() => expect(state.windows[0].focus).toHaveBeenCalledTimes(1));

		state.windows[0].emit("focus");
		expect(state.completionTracker.view).not.toHaveBeenCalled();

		state.windows[0].emit("focus");
		expect(state.completionTracker.view).toHaveBeenCalledTimes(1);
		expect(state.completionTracker.view).toHaveBeenCalledWith("session-ack");
	});

	it("does not surface an unhandled rejection when the diagnostic throws synchronously", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		state.windowState.load.mockRejectedValueOnce(new Error("renderer load failed"));
		state.diagnosticAppend.mockImplementationOnce(() => {
			throw new Error("diagnostic threw");
		});

		await captureUnhandledRejections(async () => {
			state.appHandlers.get("activate")?.();
			await vi.waitFor(() => expect(state.diagnosticAppend).toHaveBeenCalledTimes(1));
		});
	});

	it("does not surface an unhandled rejection when the diagnostic rejects", async () => {
		await importLaunch();
		state.windows[0].emit("closed");
		state.windowState.load.mockRejectedValueOnce(new Error("renderer load failed"));
		state.diagnosticAppend.mockRejectedValueOnce(new Error("diagnostic rejected"));

		await captureUnhandledRejections(async () => {
			state.appHandlers.get("activate")?.();
			await vi.waitFor(() => expect(state.diagnosticAppend).toHaveBeenCalledTimes(1));
		});
	});
});
