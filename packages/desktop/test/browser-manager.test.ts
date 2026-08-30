import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/main/browser-manager.ts";
import { BrowserProfileStore } from "../src/main/browser-profile-store.ts";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopDownloadItem,
	type DesktopHistoryEntry,
} from "../src/shared/desktop-api.ts";

const SESSION_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "20000000-0000-4000-8000-000000000002";

function downloadItemHarness(overrides: { filename?: string; url?: string } = {}) {
	const listeners = new Map<string, Set<(...args: any[]) => void>>();
	const item: Record<string, any> = {
		getURL: vi.fn(() => overrides.url ?? "https://example.com/files/report.pdf"),
		getFilename: vi.fn(() => overrides.filename ?? "report.pdf"),
		setSavePath: vi.fn(),
		getTotalBytes: vi.fn(() => 1_000),
		getReceivedBytes: vi.fn(() => 0),
		isPaused: vi.fn(() => false),
		pause: vi.fn(),
		resume: vi.fn(),
		cancel: vi.fn(),
		on: vi.fn((name: string, listener: (...args: any[]) => void) => {
			const eventListeners = listeners.get(name) ?? new Set();
			eventListeners.add(listener);
			listeners.set(name, eventListeners);
			return item;
		}),
	};
	item.once = item.on;
	return {
		emit: (name: string, ...args: any[]) => {
			for (const listener of listeners.get(name) ?? []) listener({}, ...args);
		},
		item,
	};
}

function latestDownloads(events: unknown[]): readonly DesktopDownloadItem[] {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index] as { type?: string; downloads?: readonly DesktopDownloadItem[] };
		if (event.type === "downloads") return event.downloads ?? [];
	}
	throw new Error("No downloads event emitted");
}

function latestHistory(events: unknown[]): readonly DesktopHistoryEntry[] {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index] as { type?: string; entries?: readonly DesktopHistoryEntry[] };
		if (event.type === "history") return event.entries ?? [];
	}
	throw new Error("No history event emitted");
}

function browserHarness(
	options: {
		initialHistory?: unknown[];
		handoffTimeoutMs?: number;
		navigationTimeoutMs?: number;
		importedData?: {
			readonly cookies: readonly { readonly url: string; readonly name: string; readonly value: string }[];
			readonly cookieSkipped: number;
			readonly history: readonly DesktopHistoryEntry[];
		};
	} = {},
) {
	const listeners = new Map<string, Set<(...args: any[]) => void>>();
	let currentUrl = "about:blank";
	let windowOpenHandler:
		| ((details: { url: string }) => {
				action: "allow" | "deny";
				createWindow?: (options: Record<string, unknown>) => unknown;
		  })
		| undefined;
	const navigationHistory = {
		canGoBack: vi.fn(() => false),
		canGoForward: vi.fn(() => false),
		goBack: vi.fn(),
		goForward: vi.fn(),
	};
	const webContents = {
		navigationHistory,
		loadURL: vi.fn(async (url: string) => {
			currentUrl = url;
		}),
		getURL: vi.fn(() => currentUrl),
		isDestroyed: vi.fn(() => false),
		reload: vi.fn(),
		close: vi.fn(),
		findInPage: vi.fn(() => 41),
		stopFindInPage: vi.fn(),
		print: vi.fn(
			(_options: { printBackground: boolean }, callback: (success: boolean, failureReason: string) => void) =>
				callback(true, ""),
		),
		printToPDF: vi.fn(async () => Buffer.from("pdf")),
		setZoomFactor: vi.fn(),
		invalidate: vi.fn(),
		capturePage: vi.fn(async () => nativeImage),
		on: vi.fn((name: string, listener: (...args: any[]) => void) => {
			const eventListeners = listeners.get(name) ?? new Set();
			eventListeners.add(listener);
			listeners.set(name, eventListeners);
			return webContents;
		}),
		off: vi.fn((name: string, listener: (...args: any[]) => void) => {
			listeners.get(name)?.delete(listener);
			return webContents;
		}),
		setWindowOpenHandler: vi.fn((handler: typeof windowOpenHandler) => {
			windowOpenHandler = handler;
		}),
	};
	const view = {
		webContents,
		setBackgroundColor: vi.fn(),
		setBorderRadius: vi.fn(),
		setBounds: vi.fn(),
		setVisible: vi.fn(),
	};
	const contentView = {
		addChildView: vi.fn(),
		getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1_280, height: 840 })),
		removeChildView: vi.fn(),
	};
	const backgroundContentView = {
		addChildView: vi.fn(),
		removeChildView: vi.fn(),
	};
	const backgroundWindow = {
		contentView: backgroundContentView,
		destroy: vi.fn(),
		isDestroyed: vi.fn(() => false),
	};
	const willDownloadHandlers: ((...args: any[]) => void)[] = [];
	const browserSession = {
		cookies: {
			set: vi.fn(async () => undefined),
			flushStore: vi.fn(async () => undefined),
		},
		setPermissionCheckHandler: vi.fn(),
		setPermissionRequestHandler: vi.fn(),
		clearData: vi.fn(async () => undefined),
		on: vi.fn((name: string, listener: (...args: any[]) => void) => {
			if (name === "will-download") willDownloadHandlers.push(listener);
			return browserSession;
		}),
		downloadURL: vi.fn(),
	};
	const nativeImage = {
		toDataURL: vi.fn(() => "data:image/png;base64,cHJldmlldw=="),
		toPNG: vi.fn(() => Buffer.from("png")),
	};
	let createdPreferences: Record<string, unknown> | undefined;
	let createdViewOptions: Record<string, unknown> | undefined;
	const openExternal = vi.fn(async () => undefined);
	const savePdf = vi.fn(async () => undefined);
	const saveScreenshot = vi.fn(async () => undefined);
	const resolveDownloadDirectory = vi.fn(() => "/tmp/metis-downloads");
	const pathExists = vi.fn((_path: string) => false);
	const openPath = vi.fn(async () => undefined);
	const showItemInFolder = vi.fn();
	const profileStore = new BrowserProfileStore(mkdtempSync(join(tmpdir(), "metis-browser-manager-")));
	if (options.initialHistory)
		profileStore.saveHistory(DEFAULT_BROWSER_PROFILE_ID, options.initialHistory as DesktopHistoryEntry[]);
	const loadHistory = vi.spyOn(profileStore, "loadHistory");
	const saveHistory = vi.spyOn(profileStore, "saveHistory");
	const sessionForPartition = vi.fn(() => browserSession as never);
	const importer = {
		listSources: vi.fn(async () =>
			options.importedData
				? [
						{
							sourceId: "chrome" as const,
							name: "Google Chrome",
							running: false,
							profiles: [
								{ sourceProfileId: "Default", name: "Personal", email: null },
								{ sourceProfileId: "Profile 2", name: "Work", email: null },
							],
						},
					]
				: [],
		),
		readProfile: vi.fn(async () => options.importedData ?? { cookies: [], cookieSkipped: 0, history: [] }),
	};
	const controllers = new Map<
		string,
		{
			observe: ReturnType<typeof vi.fn>;
			act: ReturnType<typeof vi.fn>;
			invalidate: ReturnType<typeof vi.fn>;
			close: ReturnType<typeof vi.fn>;
			detach: () => void;
			leaseAbort: AbortController;
			leaseSignal: ReturnType<typeof vi.fn>;
		}
	>();
	const manager = new BrowserManager({
		profileStore,
		importer,
		sessionForPartition,
		createView: (options) => {
			createdViewOptions = options as Record<string, unknown>;
			createdPreferences = options.webPreferences as Record<string, unknown>;
			return view as never;
		},
		createBackgroundWindow: vi.fn(() => backgroundWindow as never),
		openExternal,
		pathExists,
		openPath,
		resolveDownloadDirectory,
		savePdf,
		saveScreenshot,
		showItemInFolder,
		createController: ({ browserId, profileId }) => {
			const observation = () => ({
				browserId,
				profileId,
				documentId: "30000000-0000-4000-8000-000000000001",
				revision: 1,
				change: "full" as const,
				url: currentUrl === "about:blank" ? "" : currentUrl,
				title: "Fixture",
				loading: false,
				state: "e1 button Continue",
			});
			const leaseAbort = new AbortController();
			const controller = {
				observe: vi.fn(async () => observation()),
				act: vi.fn(async () => ({ status: "completed" as const, observation: observation() })),
				invalidate: vi.fn(),
				close: vi.fn(),
				leaseAbort,
				leaseSignal: vi.fn(() => controller.leaseAbort.signal),
				detach: vi.fn(() => {
					controller.leaseAbort.abort(new Error("Browser debugger detached"));
					controller.leaseAbort = new AbortController();
				}),
			};
			controllers.set(browserId, controller);
			return controller;
		},
		handoffTimeoutMs: options.handoffTimeoutMs ?? 1_000,
		navigationTimeoutMs: options.navigationTimeoutMs ?? 1_000,
	});
	return {
		backgroundContentView,
		backgroundWindow,
		browserSession,
		contentView,
		controllers,
		createdPreferences: () => createdPreferences,
		createdViewOptions: () => createdViewOptions,
		emit: (name: string, ...args: any[]) => {
			for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
		},
		loadHistory,
		manager,
		nativeImage,
		navigationHistory,
		openExternal,
		openPath,
		pathExists,
		persisted: () => profileStore.loadHistory(DEFAULT_BROWSER_PROFILE_ID),
		profileStore,
		importer,
		resolveDownloadDirectory,
		saveHistory,
		savePdf,
		saveScreenshot,
		sessionForPartition,
		showItemInFolder,
		view,
		webContents,
		willDownload: (item: Record<string, any>) => {
			for (const handler of willDownloadHandlers) handler({}, item);
		},
		windowOpen: (url: string) => windowOpenHandler?.({ url }),
	};
}

describe("BrowserManager", () => {
	it("coalesces rapid agent activity and releases the tab after 100 completed actions", async () => {
		vi.useFakeTimers();
		try {
			const harness = browserHarness();
			const browserId = "10000000-0000-4000-8000-000000000069";
			const activity: Array<{ readonly active: boolean }> = [];
			const states: Array<{ readonly title: string }> = [];
			harness.manager.onEvent((event) => {
				if (event.type === "activity") activity.push(event);
				if (event.type === "state") states.push(event.state);
			});
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
			for (let index = 0; index < 100; index += 1) {
				harness.emit("page-title-updated", {}, `Burst ${index}`, true);
			}
			expect(states).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(50);
			expect(states).toHaveLength(2);
			expect(states.at(-1)?.title).toBe("Burst 99");
			for (let index = 0; index < 100; index += 1) {
				await harness.manager.executeTool(
					SESSION_ID,
					{
						tool: "browser_act",
						input: {
							browserId,
							documentId: "30000000-0000-4000-8000-000000000001",
							snapshotRevision: 1,
							origin: "https://example.test",
							intent: "Exercise bounded activity",
							risk: "ordinary",
							action: { type: "click", target: { elementId: "e1" } },
						},
					},
					new AbortController().signal,
				);
			}
			await vi.advanceTimersByTimeAsync(50);
			expect(activity).toEqual([{ type: "activity", sessionId: SESSION_ID, browserId, active: true }]);
			await vi.advanceTimersByTimeAsync(50);
			expect(activity).toEqual([
				{ type: "activity", sessionId: SESSION_ID, browserId, active: true },
				{ type: "activity", sessionId: SESSION_ID, browserId, active: false },
			]);
			harness.manager.closeAll();
			expect(harness.controllers.get(browserId)?.close).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares one fair 20-per-second budget across state and activity events", async () => {
		vi.useFakeTimers();
		try {
			const harness = browserHarness();
			const browserId = "10000000-0000-4000-8000-000000000068";
			const progress: Array<{ readonly at: number; readonly type: "activity" | "state" }> = [];
			harness.manager.onEvent((event) => {
				if (event.type === "activity" || event.type === "state")
					progress.push({ at: Date.now(), type: event.type });
			});
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
			for (let index = 0; index < 20; index += 1) {
				harness.emit("page-title-updated", {}, `Sustained ${index}`, true);
				await harness.manager.executeTool(
					SESSION_ID,
					{
						tool: "browser_act",
						input: {
							browserId,
							documentId: "30000000-0000-4000-8000-000000000001",
							snapshotRevision: 1,
							origin: "https://example.test",
							intent: "Exercise the shared progress budget",
							risk: "ordinary",
							action: { type: "click", target: { elementId: "e1" } },
						},
					},
					new AbortController().signal,
				);
				await vi.advanceTimersByTimeAsync(100);
			}
			expect(new Set(progress.map(({ type }) => type))).toEqual(new Set(["activity", "state"]));
			const peak = progress.reduce(
				(maximum, event) =>
					Math.max(maximum, progress.filter(({ at }) => at >= event.at && at < event.at + 1_000).length),
				0,
			);
			expect(peak).toBeLessThanOrEqual(20);
			harness.manager.closeAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps tabs task-owned and makes duplicate renderer creation idempotent", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000070";
		const otherBrowserId = "10000000-0000-4000-8000-000000000071";
		const first = harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		expect(
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID }),
		).toEqual(first);
		expect(harness.contentView.addChildView).not.toHaveBeenCalled();
		expect(() =>
			harness.manager.create({ sessionId: OTHER_SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID }),
		).toThrow("another task");
		harness.manager.create({
			sessionId: OTHER_SESSION_ID,
			browserId: otherBrowserId,
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		});

		const own = await harness.manager.executeTool(
			SESSION_ID,
			{ tool: "browser_tabs", input: { action: "list" } },
			new AbortController().signal,
		);
		expect(own.tool === "browser_tabs" && own.details.tabs.map(({ browserId: id }) => id)).toEqual([browserId]);
		await expect(
			harness.manager.executeTool(
				SESSION_ID,
				{ tool: "browser_observe", input: { browserId: otherBrowserId } },
				new AbortController().signal,
			),
		).rejects.toThrow("does not belong");
		expect(() => harness.manager.close(SESSION_ID, otherBrowserId)).toThrow("does not belong");
	});

	it("keeps non-presented browser tabs out of the renderer view tree", () => {
		const harness = browserHarness();
		harness.manager.attach({ contentView: harness.contentView } as never);
		harness.manager.create({
			sessionId: SESSION_ID,
			browserId: "10000000-0000-4000-8000-000000000069",
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		});

		expect(harness.contentView.addChildView).not.toHaveBeenCalled();
	});

	it("adopts safe popups as owned tabs and enforces the per-task tab cap", async () => {
		const harness = browserHarness();
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		const openerId = "10000000-0000-4000-8000-000000000072";
		harness.manager.create({ sessionId: SESSION_ID, browserId: openerId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		expect(harness.windowOpen("file:///tmp/unsafe")).toEqual({ action: "deny" });
		const popup = harness.windowOpen("https://accounts.example.test/oauth");
		expect(popup).toMatchObject({
			action: "allow",
			createWindow: expect.any(Function),
		});
		expect(popup?.createWindow?.({ webContents: harness.webContents, webPreferences: {} })).toBe(harness.webContents);
		expect(harness.createdViewOptions()?.webContents).toBe(harness.webContents);
		const listed = await harness.manager.executeTool(
			SESSION_ID,
			{ tool: "browser_tabs", input: { action: "list" } },
			new AbortController().signal,
		);
		expect(listed.tool === "browser_tabs" && listed.details.tabs).toHaveLength(2);
		expect(events.filter((event) => (event as { type?: string }).type === "opened")).toHaveLength(2);

		for (let index = 2; index < 16; index++) {
			harness.manager.create({
				sessionId: SESSION_ID,
				browserId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				profileId: DEFAULT_BROWSER_PROFILE_ID,
			});
		}
		expect(() =>
			harness.manager.create({
				sessionId: SESSION_ID,
				browserId: "10000000-0000-4000-8000-000000000099",
				profileId: DEFAULT_BROWSER_PROFILE_ID,
			}),
		).toThrow("maximum");
		expect(harness.windowOpen("https://example.test/popup")).toEqual({ action: "deny" });
	});

	it("holds direct handoff until validated completion and rejects automation meanwhile", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000073";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.attach({ contentView: harness.contentView } as never);
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		await harness.manager.control({
			type: "present",
			sessionId: SESSION_ID,
			browserId,
			visible: true,
			bounds: { x: 1, y: 2, width: 300, height: 400 },
		});
		const pending = harness.manager.executeTool(
			SESSION_ID,
			{ tool: "browser_handoff", input: { browserId, reason: "login" } },
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(events).toContainEqual({
				type: "handoff",
				sessionId: SESSION_ID,
				browserId,
				status: "requested",
				reason: "login",
			}),
		);
		await expect(
			harness.manager.executeTool(
				SESSION_ID,
				{ tool: "browser_observe", input: { browserId } },
				new AbortController().signal,
			),
		).rejects.toThrow("controlled");
		await expect(harness.manager.control({ type: "reload", sessionId: SESSION_ID, browserId })).rejects.toThrow(
			"controlled",
		);
		await harness.manager.control({
			type: "present",
			sessionId: SESSION_ID,
			browserId,
			visible: true,
			bounds: { x: 1, y: 2, width: 300, height: 400 },
		});
		expect(harness.view.setVisible).toHaveBeenLastCalledWith(true);
		harness.manager.resolveHandoff(SESSION_ID, browserId, "complete");
		await expect(pending).resolves.toMatchObject({ tool: "browser_handoff", details: { status: "completed" } });
		expect(harness.controllers.get(browserId)?.invalidate).toHaveBeenCalledTimes(2);
	});

	it("turns Take control during an action into the same pending handoff RPC", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000074";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.attach({ contentView: harness.contentView } as never);
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		await harness.manager.control({
			type: "present",
			sessionId: SESSION_ID,
			browserId,
			visible: true,
			bounds: { x: 1, y: 2, width: 300, height: 400 },
		});
		expect(harness.contentView.addChildView).toHaveBeenLastCalledWith(harness.view);
		const controller = harness.controllers.get(browserId)!;
		controller.act.mockImplementation(
			(_input: unknown, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
						{
							once: true,
						},
					);
				}),
		);
		const pending = harness.manager.executeTool(
			SESSION_ID,
			{
				tool: "browser_act",
				input: {
					browserId,
					documentId: "30000000-0000-4000-8000-000000000001",
					snapshotRevision: 1,
					origin: "https://example.test",
					intent: "Click",
					risk: "ordinary",
					action: { type: "click", target: { elementId: "e1" } },
				},
			},
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(events).toContainEqual({ type: "activity", sessionId: SESSION_ID, browserId, active: true }),
		);
		expect(harness.view.setVisible).toHaveBeenLastCalledWith(true);
		expect(harness.backgroundContentView.addChildView).toHaveBeenLastCalledWith(harness.view);
		await harness.manager.control({
			type: "present",
			sessionId: SESSION_ID,
			browserId,
			visible: false,
			bounds: { x: 1, y: 2, width: 300, height: 400 },
		});
		expect(harness.view.setVisible).toHaveBeenLastCalledWith(true);
		harness.manager.takeControl(SESSION_ID, browserId);
		await vi.waitFor(() =>
			expect(events).toContainEqual({
				type: "handoff",
				sessionId: SESSION_ID,
				browserId,
				status: "requested",
				reason: "other",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(events).not.toContainEqual({ type: "activity", sessionId: SESSION_ID, browserId, active: false });
		harness.manager.resolveHandoff(SESSION_ID, browserId, "cancel");
		await expect(pending).resolves.toEqual({
			tool: "browser_act",
			details: { status: "cancelled", reason: "user_cancelled" },
		});
		expect(harness.backgroundContentView.addChildView).toHaveBeenLastCalledWith(harness.view);
		expect(events).not.toContainEqual({ type: "activity", sessionId: SESSION_ID, browserId, active: false });
	});

	it("interrupts a hanging navigation immediately when the user takes control", async () => {
		const harness = browserHarness({ navigationTimeoutMs: 10_000 });
		const browserId = "10000000-0000-4000-8000-000000000075";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		harness.webContents.loadURL.mockReturnValueOnce(new Promise(() => undefined));
		const pending = harness.manager.executeTool(
			SESSION_ID,
			{
				tool: "browser_navigate",
				input: { action: "goto", browserId, url: "https://login.example.test" },
			},
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(events).toContainEqual({ type: "activity", sessionId: SESSION_ID, browserId, active: true }),
		);
		harness.manager.takeControl(SESSION_ID, browserId);
		await vi.waitFor(() =>
			expect(events).toContainEqual({
				type: "handoff",
				sessionId: SESSION_ID,
				browserId,
				status: "requested",
				reason: "other",
			}),
		);
		harness.manager.resolveHandoff(SESSION_ID, browserId, "cancel");
		await expect(pending).resolves.toEqual({
			tool: "browser_navigate",
			details: { status: "cancelled", reason: "user_cancelled" },
		});
	});

	it("suspends native presentation while retaining replayable task tabs", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000085";
		harness.manager.attach({ contentView: harness.contentView } as never);
		const first = harness.manager.create({
			sessionId: SESSION_ID,
			browserId,
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		});
		await harness.manager.control({
			type: "present",
			sessionId: SESSION_ID,
			browserId,
			visible: true,
			bounds: { x: 4, y: 5, width: 300, height: 400 },
		});
		harness.manager.suspendRenderer();
		expect(harness.view.setVisible).toHaveBeenLastCalledWith(true);
		expect(harness.contentView.removeChildView).toHaveBeenCalledWith(harness.view);
		expect(harness.backgroundContentView.addChildView).toHaveBeenLastCalledWith(harness.view);
		expect(harness.manager.replayEvents(SESSION_ID)).toEqual([
			{ type: "opened", sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID },
		]);
		expect(
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID }),
		).toEqual(first);
		expect(harness.controllers).toHaveLength(1);
	});

	it("owns safe Chromium views through navigation, presentation, events, and cleanup", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000078";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.attach({ contentView: harness.contentView } as never);

		expect(
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID }),
		).toMatchObject({
			browserId,
			profileId: DEFAULT_BROWSER_PROFILE_ID,
			url: "",
			title: "New tab",
			zoomPercent: 100,
		});
		expect(harness.createdPreferences()).toMatchObject({
			backgroundThrottling: false,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		});
		expect(harness.createdPreferences()).not.toHaveProperty("preload");
		expect(harness.view.setBorderRadius).toHaveBeenCalledWith(7);
		expect(harness.view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1_024, height: 768 });
		expect(harness.view.setVisible).toHaveBeenCalledWith(true);
		expect(harness.backgroundContentView.addChildView).toHaveBeenCalledWith(harness.view);
		expect(harness.contentView.addChildView).not.toHaveBeenCalled();
		expect(harness.browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
		expect(harness.browserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();

		await harness.manager.control({ sessionId: SESSION_ID, type: "navigate", browserId, url: "openai" });
		expect(harness.webContents.loadURL).toHaveBeenCalledWith("https://www.google.com/search?q=openai");
		await harness.manager.control({ sessionId: SESSION_ID, type: "navigate", browserId, url: "example.com" });
		expect(harness.webContents.loadURL).toHaveBeenCalledWith("https://example.com/");
		await harness.manager.control({ sessionId: SESSION_ID, type: "navigate", browserId, url: "example.com:8080" });
		expect(harness.webContents.loadURL).toHaveBeenLastCalledWith("https://example.com:8080/");
		await expect(
			harness.manager.control({ sessionId: SESSION_ID, type: "navigate", browserId, url: "javascript:alert(1)" }),
		).rejects.toThrow("Unsupported browser URL");
		await expect(
			harness.manager.control({
				sessionId: SESSION_ID,
				type: "navigate",
				browserId,
				url: "https://user:secret@example.com",
			}),
		).rejects.toThrow("cannot contain credentials");

		await harness.manager.control({
			sessionId: SESSION_ID,
			type: "present",
			browserId,
			visible: true,
			bounds: { x: 800, y: 86, width: 393, height: 747 },
		});
		expect(harness.view.setBounds).toHaveBeenCalledWith({ x: 800, y: 86, width: 393, height: 747 });
		expect(harness.view.setVisible).toHaveBeenLastCalledWith(true);
		await harness.manager.control({
			sessionId: SESSION_ID,
			type: "present",
			browserId,
			visible: true,
			bounds: { x: 800, y: 86, width: 393, height: 747 },
		});
		expect(harness.view.setBounds).toHaveBeenCalledTimes(2);

		harness.navigationHistory.canGoBack.mockReturnValue(true);
		harness.navigationHistory.canGoForward.mockReturnValue(true);
		await harness.manager.control({ sessionId: SESSION_ID, type: "back", browserId });
		await harness.manager.control({ sessionId: SESSION_ID, type: "forward", browserId });
		expect(harness.navigationHistory.goBack).toHaveBeenCalledOnce();
		expect(harness.navigationHistory.goForward).toHaveBeenCalledOnce();

		harness.emit("did-start-loading");
		harness.emit("page-title-updated", {}, "Example Domain", true);
		harness.emit("page-favicon-updated", {}, ["https://example.com/favicon.ico"]);
		harness.emit("did-stop-loading");
		await vi.waitFor(() =>
			expect(events).toContainEqual({
				type: "state",
				state: {
					browserId,
					profileId: DEFAULT_BROWSER_PROFILE_ID,
					url: "https://example.com:8080/",
					title: "Example Domain",
					faviconUrl: "https://example.com/favicon.ico",
					loading: false,
					canGoBack: true,
					canGoForward: true,
					zoomPercent: 100,
				},
			}),
		);

		expect(harness.windowOpen("https://openai.com")).toMatchObject({
			action: "allow",
			createWindow: expect.any(Function),
		});
		const preventDefault = vi.fn();
		harness.emit("will-navigate", { url: "file:///etc/passwd", preventDefault });
		expect(preventDefault).toHaveBeenCalledOnce();
		harness.emit("will-redirect", { url: "file:///etc/passwd", preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(2);

		await harness.manager.control({ sessionId: SESSION_ID, type: "open-external", browserId });
		expect(harness.openExternal).toHaveBeenCalledWith("https://example.com:8080/");

		const beforeClose = events.length;
		harness.emit("render-process-gone");
		expect(events).toContainEqual({ type: "error", browserId, message: "Browser page crashed" });
		expect(events).toContainEqual({ type: "closed", sessionId: SESSION_ID, browserId });
		expect(harness.contentView.removeChildView).toHaveBeenCalledWith(harness.view);
		expect(harness.webContents.close).toHaveBeenCalledOnce();
		expect(harness.controllers.get(browserId)?.close).toHaveBeenCalledOnce();
		expect(() => harness.manager.close(SESSION_ID, browserId)).toThrow("Browser is not running");
		harness.emit("did-stop-loading");
		expect(events).toHaveLength(beforeClose + 2);
	});

	it("lets a newer navigation supersede an aborted in-flight load", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000079";
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		let rejectFirst: ((cause: unknown) => void) | undefined;
		harness.webContents.loadURL
			.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectFirst = reject;
					}),
			)
			.mockResolvedValueOnce(undefined);

		const first = harness.manager.control({
			sessionId: SESSION_ID,
			type: "navigate",
			browserId,
			url: "https://first.example",
		});
		const second = harness.manager.control({
			sessionId: SESSION_ID,
			type: "navigate",
			browserId,
			url: "https://second.example",
		});
		rejectFirst?.(Object.assign(new Error("navigation aborted"), { code: "ERR_ABORTED" }));

		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		expect(harness.webContents.loadURL).toHaveBeenNthCalledWith(2, "https://second.example/");
	});

	it("does not report Electron's redirect abort as a failed navigation", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000080";
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		harness.webContents.loadURL.mockRejectedValueOnce(
			Object.assign(new Error("(-3) loading redirected page"), { code: "", errno: -3 }),
		);

		await expect(
			harness.manager.control({
				sessionId: SESSION_ID,
				type: "navigate",
				browserId,
				url: "https://www.google.com/search?q=openai",
			}),
		).resolves.toBeUndefined();
	});

	it("returns a bounded error when an action closes its own popup", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000067";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		const controller = harness.controllers.get(browserId)!;
		controller.act.mockImplementationOnce(
			(_input: unknown, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				}),
		);
		const result = harness.manager.executeTool(
			SESSION_ID,
			{
				tool: "browser_act",
				input: {
					browserId,
					documentId: "30000000-0000-4000-8000-000000000001",
					snapshotRevision: 1,
					origin: "https://example.test",
					intent: "Authorize and close the popup",
					risk: "ordinary",
					action: { type: "click", target: { elementId: "e1" } },
				},
			},
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(controller.act).toHaveBeenCalledOnce());
		harness.emit("destroyed");
		await expect(result).rejects.toThrow();
		expect(events).toContainEqual({ type: "closed", sessionId: SESSION_ID, browserId });
		expect(events).not.toContainEqual({ type: "error", browserId, message: "Browser page crashed" });
	});

	it("waits for the final redirected and history pages before model observation", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000086";
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
		const controller = harness.controllers.get(browserId)!;
		harness.webContents.loadURL.mockRejectedValueOnce(
			Object.assign(new Error("(-3) loading redirected page"), { code: "", errno: -3 }),
		);
		const redirected = harness.manager.executeTool(
			SESSION_ID,
			{ tool: "browser_navigate", input: { browserId, action: "goto", url: "https://redirect.example" } },
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(harness.webContents.loadURL).toHaveBeenCalledOnce());
		expect(controller.observe).not.toHaveBeenCalled();
		harness.emit("did-stop-loading");
		await expect(redirected).resolves.toMatchObject({ tool: "browser_navigate", details: { status: "completed" } });
		expect(controller.observe).toHaveBeenCalledOnce();

		harness.navigationHistory.canGoBack.mockReturnValue(true);
		const back = harness.manager.executeTool(
			SESSION_ID,
			{ tool: "browser_navigate", input: { browserId, action: "back" } },
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(harness.navigationHistory.goBack).toHaveBeenCalledOnce());
		expect(controller.observe).toHaveBeenCalledOnce();
		harness.emit("did-start-loading");
		harness.emit("did-stop-loading");
		await expect(back).resolves.toMatchObject({ tool: "browser_navigate", details: { status: "completed" } });
		expect(controller.observe).toHaveBeenCalledTimes(2);
	});

	it("uses native page actions and resets tab-local state when a browser closes", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000081";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		expect(
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID }),
		).toMatchObject({
			zoomPercent: 100,
		});

		await harness.manager.control({
			sessionId: SESSION_ID,
			type: "find",
			browserId,
			text: "openai",
			forward: true,
			findNext: true,
		});
		expect(harness.webContents.findInPage).toHaveBeenCalledWith("openai", {
			forward: true,
			findNext: true,
		});
		harness.emit(
			"found-in-page",
			{},
			{
				requestId: 40,
				activeMatchOrdinal: 1,
				matches: 1,
				finalUpdate: true,
			},
		);
		expect(events).not.toContainEqual(expect.objectContaining({ type: "find-result", matches: 1 }));
		harness.emit(
			"found-in-page",
			{},
			{
				requestId: 41,
				activeMatchOrdinal: 2,
				matches: 52,
				finalUpdate: true,
			},
		);
		expect(events).toContainEqual({
			type: "find-result",
			browserId,
			activeMatchOrdinal: 2,
			matches: 52,
		});

		await harness.manager.control({ sessionId: SESSION_ID, type: "stop-find", browserId });
		expect(harness.webContents.stopFindInPage).toHaveBeenCalledWith("clearSelection");

		await harness.manager.control({ sessionId: SESSION_ID, type: "print", browserId });
		expect(harness.webContents.print).toHaveBeenCalledWith({ printBackground: true }, expect.any(Function));
		harness.webContents.print.mockImplementationOnce((_options, callback) => callback(false, "Print job canceled"));
		await expect(
			harness.manager.control({ sessionId: SESSION_ID, type: "print", browserId }),
		).resolves.toBeUndefined();
		harness.webContents.print.mockImplementationOnce((_options, callback) =>
			callback(false, "No printers available on the network"),
		);
		await expect(
			harness.manager.control({ sessionId: SESSION_ID, type: "print", browserId }),
		).resolves.toBeUndefined();
		expect(harness.webContents.printToPDF).toHaveBeenCalledWith({ printBackground: true });
		expect(harness.savePdf).toHaveBeenCalledWith(
			Buffer.from("pdf"),
			expect.stringMatching(/^Metis-Print-\d{4}-\d{2}-\d{2}-\d{6}\.pdf$/u),
		);
		harness.webContents.print.mockImplementationOnce((_options, callback) => callback(false, "Printer unavailable"));
		await expect(harness.manager.control({ sessionId: SESSION_ID, type: "print", browserId })).rejects.toThrow(
			"Printer unavailable",
		);

		await harness.manager.control({ sessionId: SESSION_ID, type: "zoom-out", browserId });
		await harness.manager.control({ sessionId: SESSION_ID, type: "zoom-in", browserId });
		await harness.manager.control({ sessionId: SESSION_ID, type: "zoom-reset", browserId });
		expect(harness.webContents.setZoomFactor.mock.calls.map(([factor]) => factor)).toEqual([0.9, 1]);
		for (let index = 0; index < 30; index += 1) {
			await harness.manager.control({ sessionId: SESSION_ID, type: "zoom-in", browserId });
		}
		expect(harness.webContents.setZoomFactor).toHaveBeenLastCalledWith(5);
		expect(harness.webContents.setZoomFactor).toHaveBeenCalledTimes(11);
		await harness.manager.control({ sessionId: SESSION_ID, type: "set-zoom", browserId, zoomPercent: 137 });
		await harness.manager.control({ sessionId: SESSION_ID, type: "zoom-in", browserId });
		await harness.manager.control({ sessionId: SESSION_ID, type: "zoom-out", browserId });
		expect(harness.webContents.setZoomFactor.mock.calls.slice(-3).map(([factor]) => factor)).toEqual([
			1.37, 1.5, 1.25,
		]);

		await harness.manager.control({ sessionId: SESSION_ID, type: "capture-page", browserId });
		expect(harness.webContents.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true });
		expect(harness.saveScreenshot).toHaveBeenCalledWith(
			harness.nativeImage,
			expect.stringMatching(/^Metis-Screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/u),
		);
		await expect(harness.manager.capturePreview(SESSION_ID, browserId)).resolves.toBe(
			"data:image/png;base64,cHJldmlldw==",
		);
		expect(harness.webContents.invalidate).toHaveBeenCalledTimes(2);
		expect(harness.nativeImage.toDataURL).toHaveBeenCalledOnce();

		await harness.manager.control({ sessionId: SESSION_ID, type: "clear-data", browserId });
		expect(harness.browserSession.clearData).toHaveBeenCalledWith({
			dataTypes: ["cache", "cookies", "indexedDB", "localStorage", "serviceWorkers"],
		});

		harness.manager.close(SESSION_ID, browserId);
		expect(
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID }),
		).toMatchObject({
			zoomPercent: 100,
		});
	});

	it("routes native-page shortcuts and removes their listeners on close", () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000082";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });

		for (const [key, command] of [
			["f", "find"],
			["p", "print"],
			["-", "zoom-out"],
			["=", "zoom-in"],
			["0", "zoom-reset"],
		] as const) {
			const preventDefault = vi.fn();
			harness.emit(
				"before-input-event",
				{ preventDefault },
				{
					type: "keyDown",
					key,
					meta: true,
					control: false,
					alt: false,
					shift: false,
					isComposing: false,
				},
			);
			expect(preventDefault).toHaveBeenCalledOnce();
			expect(events).toContainEqual({ type: "command", browserId, command });
		}

		harness.manager.close(SESSION_ID, browserId);
		const before = events.length;
		harness.emit(
			"before-input-event",
			{ preventDefault: vi.fn() },
			{
				type: "keyDown",
				key: "f",
				meta: true,
				control: false,
				alt: false,
				shift: false,
				isComposing: false,
			},
		);
		expect(events).toHaveLength(before);
	});

	it("returns and opens the fixed system download directory", async () => {
		const harness = browserHarness();

		expect(harness.manager.getDownloadDirectory()).toBe("/tmp/metis-downloads");
		expect(harness.resolveDownloadDirectory).toHaveBeenCalledOnce();
		await harness.manager.openDownloadDirectory();
		expect(harness.openPath).toHaveBeenCalledWith("/tmp/metis-downloads");
	});

	it("tracks download lifecycle with pause, resume, cancel, retry, and file actions", async () => {
		vi.useFakeTimers();
		try {
			const harness = browserHarness();
			const events: unknown[] = [];
			harness.manager.onEvent((event) => events.push(event));
			harness.manager.create({
				sessionId: SESSION_ID,
				browserId: "10000000-0000-4000-8000-000000000083",
				profileId: DEFAULT_BROWSER_PROFILE_ID,
			});

			const first = downloadItemHarness();
			harness.willDownload(first.item);
			expect(first.item.setSavePath).toHaveBeenCalledWith("/tmp/metis-downloads/report.pdf");
			expect(latestDownloads(events)).toHaveLength(1);
			const downloadId = latestDownloads(events)[0]!.downloadId;
			expect(latestDownloads(events)[0]).toMatchObject({
				filename: "report.pdf",
				savePath: "/tmp/metis-downloads/report.pdf",
				state: "progressing",
				totalBytes: 1_000,
				url: "https://example.com/files/report.pdf",
			});

			first.item.getReceivedBytes.mockReturnValue(500);
			first.emit("updated", "progressing");
			expect(latestDownloads(events)[0]!.receivedBytes).toBe(0);
			await vi.advanceTimersByTimeAsync(200);
			expect(latestDownloads(events)[0]!.receivedBytes).toBe(500);

			await harness.manager.controlDownload({ type: "pause", downloadId });
			expect(first.item.pause).toHaveBeenCalledOnce();
			expect(latestDownloads(events)[0]!.state).toBe("paused");

			first.item.isPaused.mockReturnValue(true);
			await harness.manager.controlDownload({ type: "resume", downloadId });
			expect(first.item.resume).toHaveBeenCalledOnce();
			expect(latestDownloads(events)[0]!.state).toBe("progressing");

			await harness.manager.controlDownload({ type: "cancel", downloadId });
			expect(first.item.cancel).toHaveBeenCalledOnce();
			first.emit("done", "cancelled");
			expect(latestDownloads(events)[0]!.state).toBe("cancelled");

			harness.pathExists.mockImplementation((path: string) => path === "/tmp/metis-downloads/report.pdf");
			const second = downloadItemHarness();
			harness.willDownload(second.item);
			expect(second.item.setSavePath).toHaveBeenCalledWith("/tmp/metis-downloads/report (1).pdf");
			const secondId = latestDownloads(events)[0]!.downloadId;
			expect(latestDownloads(events)).toHaveLength(2);

			second.item.getReceivedBytes.mockReturnValue(1_000);
			second.emit("done", "completed");
			expect(latestDownloads(events)[0]!).toMatchObject({
				downloadId: secondId,
				state: "completed",
				receivedBytes: 1_000,
			});

			await expect(harness.manager.controlDownload({ type: "open", downloadId })).rejects.toThrow("not complete");
			await harness.manager.controlDownload({ type: "open", downloadId: secondId });
			expect(harness.openPath).toHaveBeenCalledWith("/tmp/metis-downloads/report (1).pdf");
			await harness.manager.controlDownload({ type: "reveal", downloadId: secondId });
			expect(harness.showItemInFolder).toHaveBeenCalledWith("/tmp/metis-downloads/report (1).pdf");

			await harness.manager.controlDownload({ type: "retry", downloadId: secondId });
			expect(harness.browserSession.downloadURL).toHaveBeenCalledWith("https://example.com/files/report.pdf");

			await harness.manager.controlDownload({ type: "remove", downloadId: secondId });
			expect(latestDownloads(events)).toHaveLength(1);
			await expect(harness.manager.controlDownload({ type: "remove", downloadId: secondId })).rejects.toThrow(
				"Download is not running",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("records main-frame history with metadata, consecutive dedupe, and clear", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000090";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });

		await harness.manager.control({
			sessionId: SESSION_ID,
			type: "navigate",
			browserId,
			url: "https://example.com/",
		});
		harness.emit("did-navigate", {}, "https://example.com/");
		expect(latestHistory(events)).toHaveLength(1);
		expect(latestHistory(events)[0]).toMatchObject({
			url: "https://example.com/",
			title: "New tab",
			faviconUrl: null,
		});

		harness.emit("page-title-updated", {}, "Example Domain");
		expect(latestHistory(events)[0]).toMatchObject({ url: "https://example.com/", title: "Example Domain" });
		harness.emit("page-favicon-updated", {}, ["https://example.com/favicon.ico"]);
		expect(latestHistory(events)[0]!.faviconUrl).toBe("https://example.com/favicon.ico");

		harness.emit("did-navigate", {}, "https://example.com/");
		expect(latestHistory(events)).toHaveLength(1);

		harness.emit("did-navigate-in-page", {}, "https://example.com/docs", true);
		expect(latestHistory(events)).toHaveLength(2);
		harness.emit("did-navigate-in-page", {}, "https://example.com/frame", false);
		expect(latestHistory(events)).toHaveLength(2);

		harness.emit("did-navigate", {}, "about:blank");
		expect(latestHistory(events)).toHaveLength(2);

		expect(harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID })[0]!.url).toBe(
			"https://example.com/docs",
		);

		await harness.manager.clearHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID });
		expect(latestHistory(events)).toHaveLength(0);
		expect(harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID })).toHaveLength(0);
	});

	it("caps history at 500 entries with newest first", () => {
		const harness = browserHarness();
		harness.manager.create({
			sessionId: SESSION_ID,
			browserId: "10000000-0000-4000-8000-000000000091",
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		});
		for (let index = 0; index <= 501; index += 1) {
			harness.emit("did-navigate", {}, `https://example.com/${index}`);
		}
		const entries = harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID });
		expect(entries).toHaveLength(500);
		expect(entries[0]!.url).toBe("https://example.com/501");
		expect(entries.at(-1)!.url).toBe("https://example.com/2");
	});

	it("restores history from storage on startup and persists changes", async () => {
		vi.useFakeTimers();
		try {
			const restored = [
				{
					entryId: "20000000-0000-4000-8000-000000000001",
					url: "https://previous.example/",
					title: "Previous session",
					faviconUrl: null,
					visitedAt: 1_756_000_000_000,
				},
			];
			const harness = browserHarness({ initialHistory: restored });
			const browserId = "10000000-0000-4000-8000-000000000092";
			harness.manager.create({ sessionId: SESSION_ID, browserId, profileId: DEFAULT_BROWSER_PROFILE_ID });
			expect(harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID })).toEqual(restored);
			expect(harness.saveHistory).not.toHaveBeenCalled();

			harness.emit("did-navigate", {}, "https://example.com/first");
			expect(harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID })[0]!.url).toBe(
				"https://example.com/first",
			);
			expect(harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID })[1]!.url).toBe(
				"https://previous.example/",
			);
			await vi.advanceTimersByTimeAsync(500);
			expect(harness.saveHistory).toHaveBeenLastCalledWith(
				DEFAULT_BROWSER_PROFILE_ID,
				harness.manager.listHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID }),
			);
			expect(harness.persisted()).toHaveLength(2);

			await harness.manager.clearHistory({ profileId: DEFAULT_BROWSER_PROFILE_ID });
			expect(harness.persisted()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("imports source profiles into stable isolated partitions and caps merged history", async () => {
		const history = Array.from(
			{ length: 520 },
			(_, index): DesktopHistoryEntry => ({
				entryId: crypto.randomUUID(),
				url: `https://imported.example/${index}`,
				title: `Imported ${index}`,
				faviconUrl: null,
				visitedAt: 2_000 + index,
			}),
		);
		const harness = browserHarness({
			importedData: {
				cookies: [{ url: "https://example.com/", name: "session", value: "secret" }],
				cookieSkipped: 2,
				history,
			},
		});
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		const input = {
			sourceId: "chrome" as const,
			sourceProfileId: "Default",
			dataTypes: { cookies: true, history: true },
		};
		const personal = await harness.manager.importData(input);
		const work = await harness.manager.importData({ ...input, sourceProfileId: "Profile 2" });
		const personalAgain = await harness.manager.importData({
			...input,
			dataTypes: { cookies: true, history: false },
		});

		expect(personal.profile.profileId).not.toBe(work.profile.profileId);
		expect(personalAgain.profile.profileId).toBe(personal.profile.profileId);
		expect(personal.cookies).toEqual({ imported: 1, skipped: 2 });
		expect(personal.history).toEqual({ accepted: 520, retained: 500 });
		expect(harness.manager.listHistory({ profileId: personal.profile.profileId })).toHaveLength(500);
		expect(harness.sessionForPartition).toHaveBeenCalledWith(`persist:metis-browser-${personal.profile.profileId}`);
		expect(harness.sessionForPartition).toHaveBeenCalledWith(`persist:metis-browser-${work.profile.profileId}`);
		expect(harness.browserSession.cookies.flushStore).toHaveBeenCalledTimes(3);
		expect(events).toContainEqual({ type: "profiles", profiles: harness.manager.listProfiles() });
	});
});
