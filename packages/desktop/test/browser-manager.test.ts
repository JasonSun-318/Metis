import { describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/main/browser-manager.ts";
import type { DesktopDownloadItem, DesktopHistoryEntry } from "../src/shared/desktop-api.ts";

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

function browserHarness(options: { initialHistory?: unknown[] } = {}) {
	const listeners = new Map<string, Set<(...args: any[]) => void>>();
	let currentUrl = "about:blank";
	let windowOpenHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
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
	const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
	const willDownloadHandlers: ((...args: any[]) => void)[] = [];
	const browserSession = {
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
	const openExternal = vi.fn(async () => undefined);
	const savePdf = vi.fn(async () => undefined);
	const saveScreenshot = vi.fn(async () => undefined);
	const resolveDownloadDirectory = vi.fn(() => "/tmp/metis-downloads");
	const pathExists = vi.fn((_path: string) => false);
	const openPath = vi.fn(async () => undefined);
	const showItemInFolder = vi.fn();
	let persisted: unknown = [...(options.initialHistory ?? [])];
	const loadHistory = vi.fn((): readonly DesktopHistoryEntry[] => structuredClone(persisted) as DesktopHistoryEntry[]);
	const saveHistory = vi.fn((entries: readonly DesktopHistoryEntry[]) => {
		persisted = [...entries];
	});
	const manager = new BrowserManager({
		browserSession: browserSession as never,
		createView: (options) => {
			createdPreferences = options.webPreferences as Record<string, unknown>;
			return view as never;
		},
		openExternal,
		pathExists,
		openPath,
		resolveDownloadDirectory,
		savePdf,
		saveScreenshot,
		showItemInFolder,
		loadHistory,
		saveHistory,
	});
	return {
		browserSession,
		contentView,
		createdPreferences: () => createdPreferences,
		emit: (name: string, ...args: any[]) => {
			for (const listener of listeners.get(name) ?? []) listener(...args);
		},
		loadHistory,
		manager,
		nativeImage,
		navigationHistory,
		openExternal,
		openPath,
		pathExists,
		persisted: () => persisted,
		resolveDownloadDirectory,
		saveHistory,
		savePdf,
		saveScreenshot,
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
	it("owns safe Chromium views through navigation, presentation, events, and cleanup", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000078";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.attach({ contentView: harness.contentView } as never);

		expect(harness.manager.create({ browserId })).toMatchObject({
			browserId,
			url: "",
			title: "New tab",
			zoomPercent: 100,
		});
		expect(harness.createdPreferences()).toMatchObject({
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		});
		expect(harness.createdPreferences()).not.toHaveProperty("preload");
		expect(harness.view.setBorderRadius).toHaveBeenCalledWith(7);
		expect(harness.view.setVisible).toHaveBeenCalledWith(false);
		expect(harness.contentView.addChildView).toHaveBeenCalledWith(harness.view);
		expect(harness.browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
		expect(harness.browserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();

		await harness.manager.control({ type: "navigate", browserId, url: "openai" });
		expect(harness.webContents.loadURL).toHaveBeenCalledWith("https://www.google.com/search?q=openai");
		await harness.manager.control({ type: "navigate", browserId, url: "example.com" });
		expect(harness.webContents.loadURL).toHaveBeenCalledWith("https://example.com/");
		await harness.manager.control({ type: "navigate", browserId, url: "example.com:8080" });
		expect(harness.webContents.loadURL).toHaveBeenLastCalledWith("https://example.com:8080/");
		await expect(
			harness.manager.control({ type: "navigate", browserId, url: "javascript:alert(1)" }),
		).rejects.toThrow("Unsupported browser URL");
		await expect(
			harness.manager.control({ type: "navigate", browserId, url: "https://user:secret@example.com" }),
		).rejects.toThrow("cannot contain credentials");

		await harness.manager.control({
			type: "present",
			browserId,
			visible: true,
			bounds: { x: 800, y: 86, width: 393, height: 747 },
		});
		expect(harness.view.setBounds).toHaveBeenCalledWith({ x: 800, y: 86, width: 393, height: 747 });
		expect(harness.view.setVisible).toHaveBeenLastCalledWith(true);
		await harness.manager.control({
			type: "present",
			browserId,
			visible: true,
			bounds: { x: 800, y: 86, width: 393, height: 747 },
		});
		expect(harness.view.setBounds).toHaveBeenCalledTimes(1);

		harness.navigationHistory.canGoBack.mockReturnValue(true);
		harness.navigationHistory.canGoForward.mockReturnValue(true);
		await harness.manager.control({ type: "back", browserId });
		await harness.manager.control({ type: "forward", browserId });
		expect(harness.navigationHistory.goBack).toHaveBeenCalledOnce();
		expect(harness.navigationHistory.goForward).toHaveBeenCalledOnce();

		harness.emit("did-start-loading");
		harness.emit("page-title-updated", {}, "Example Domain", true);
		harness.emit("page-favicon-updated", {}, ["https://example.com/favicon.ico"]);
		harness.emit("did-stop-loading");
		expect(events).toContainEqual({
			type: "state",
			state: {
				browserId,
				url: "https://example.com:8080/",
				title: "Example Domain",
				faviconUrl: "https://example.com/favicon.ico",
				loading: false,
				canGoBack: true,
				canGoForward: true,
				zoomPercent: 100,
			},
		});

		expect(harness.windowOpen("https://openai.com")).toEqual({ action: "deny" });
		await Promise.resolve();
		expect(harness.webContents.loadURL).toHaveBeenLastCalledWith("https://openai.com/");
		const preventDefault = vi.fn();
		harness.emit("will-navigate", { url: "file:///etc/passwd", preventDefault });
		expect(preventDefault).toHaveBeenCalledOnce();
		harness.emit("will-redirect", { url: "file:///etc/passwd", preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(2);

		harness.emit("render-process-gone");
		expect(events).toContainEqual({ type: "error", browserId, message: "Browser page crashed" });
		await harness.manager.control({ type: "open-external", browserId });
		expect(harness.openExternal).toHaveBeenCalledWith("https://openai.com/");

		const beforeClose = events.length;
		harness.manager.close(browserId);
		expect(harness.contentView.removeChildView).toHaveBeenCalledWith(harness.view);
		expect(harness.webContents.close).toHaveBeenCalledOnce();
		harness.emit("did-stop-loading");
		expect(events).toHaveLength(beforeClose);
	});

	it("lets a newer navigation supersede an aborted in-flight load", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000079";
		harness.manager.create({ browserId });
		let rejectFirst: ((cause: unknown) => void) | undefined;
		harness.webContents.loadURL
			.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectFirst = reject;
					}),
			)
			.mockResolvedValueOnce(undefined);

		const first = harness.manager.control({ type: "navigate", browserId, url: "https://first.example" });
		const second = harness.manager.control({ type: "navigate", browserId, url: "https://second.example" });
		rejectFirst?.(Object.assign(new Error("navigation aborted"), { code: "ERR_ABORTED" }));

		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		expect(harness.webContents.loadURL).toHaveBeenNthCalledWith(2, "https://second.example/");
	});

	it("does not report Electron's redirect abort as a failed navigation", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000080";
		harness.manager.create({ browserId });
		harness.webContents.loadURL.mockRejectedValueOnce(
			Object.assign(new Error("(-3) loading redirected page"), { code: "", errno: -3 }),
		);

		await expect(
			harness.manager.control({ type: "navigate", browserId, url: "https://www.google.com/search?q=openai" }),
		).resolves.toBeUndefined();
	});

	it("uses native page actions and resets tab-local state when a browser closes", async () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000081";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		expect(harness.manager.create({ browserId })).toMatchObject({ zoomPercent: 100 });

		await harness.manager.control({
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

		await harness.manager.control({ type: "stop-find", browserId });
		expect(harness.webContents.stopFindInPage).toHaveBeenCalledWith("clearSelection");

		await harness.manager.control({ type: "print", browserId });
		expect(harness.webContents.print).toHaveBeenCalledWith({ printBackground: true }, expect.any(Function));
		harness.webContents.print.mockImplementationOnce((_options, callback) => callback(false, "Print job canceled"));
		await expect(harness.manager.control({ type: "print", browserId })).resolves.toBeUndefined();
		harness.webContents.print.mockImplementationOnce((_options, callback) =>
			callback(false, "No printers available on the network"),
		);
		await expect(harness.manager.control({ type: "print", browserId })).resolves.toBeUndefined();
		expect(harness.webContents.printToPDF).toHaveBeenCalledWith({ printBackground: true });
		expect(harness.savePdf).toHaveBeenCalledWith(
			Buffer.from("pdf"),
			expect.stringMatching(/^Metis-Print-\d{4}-\d{2}-\d{2}-\d{6}\.pdf$/u),
		);
		harness.webContents.print.mockImplementationOnce((_options, callback) => callback(false, "Printer unavailable"));
		await expect(harness.manager.control({ type: "print", browserId })).rejects.toThrow("Printer unavailable");

		await harness.manager.control({ type: "zoom-out", browserId });
		await harness.manager.control({ type: "zoom-in", browserId });
		await harness.manager.control({ type: "zoom-reset", browserId });
		expect(harness.webContents.setZoomFactor.mock.calls.map(([factor]) => factor)).toEqual([0.9, 1]);
		for (let index = 0; index < 30; index += 1) {
			await harness.manager.control({ type: "zoom-in", browserId });
		}
		expect(harness.webContents.setZoomFactor).toHaveBeenLastCalledWith(5);
		expect(harness.webContents.setZoomFactor).toHaveBeenCalledTimes(11);
		await harness.manager.control({ type: "set-zoom", browserId, zoomPercent: 137 });
		await harness.manager.control({ type: "zoom-in", browserId });
		await harness.manager.control({ type: "zoom-out", browserId });
		expect(harness.webContents.setZoomFactor.mock.calls.slice(-3).map(([factor]) => factor)).toEqual([
			1.37, 1.5, 1.25,
		]);

		await harness.manager.control({ type: "capture-page", browserId });
		expect(harness.webContents.capturePage).toHaveBeenCalledWith();
		expect(harness.saveScreenshot).toHaveBeenCalledWith(
			harness.nativeImage,
			expect.stringMatching(/^Metis-Screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/u),
		);
		await expect(harness.manager.capturePreview(browserId)).resolves.toBe("data:image/png;base64,cHJldmlldw==");
		expect(harness.nativeImage.toDataURL).toHaveBeenCalledOnce();

		await harness.manager.control({ type: "clear-data", browserId });
		expect(harness.browserSession.clearData).toHaveBeenCalledWith({
			dataTypes: ["cache", "cookies", "indexedDB", "localStorage", "serviceWorkers"],
		});

		harness.manager.close(browserId);
		expect(harness.manager.create({ browserId })).toMatchObject({ zoomPercent: 100 });
	});

	it("routes native-page shortcuts and removes their listeners on close", () => {
		const harness = browserHarness();
		const browserId = "10000000-0000-4000-8000-000000000082";
		const events: unknown[] = [];
		harness.manager.onEvent((event) => events.push(event));
		harness.manager.create({ browserId });

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

		harness.manager.close(browserId);
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

	it("tracks download lifecycle with pause, resume, cancel, retry, and file actions", async () => {
		vi.useFakeTimers();
		try {
			const harness = browserHarness();
			const events: unknown[] = [];
			harness.manager.onEvent((event) => events.push(event));

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
		harness.manager.create({ browserId });

		await harness.manager.control({ type: "navigate", browserId, url: "https://example.com/" });
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

		expect(harness.manager.listHistory()[0]!.url).toBe("https://example.com/docs");

		await harness.manager.clearHistory();
		expect(latestHistory(events)).toHaveLength(0);
		expect(harness.manager.listHistory()).toHaveLength(0);
	});

	it("caps history at 500 entries with newest first", () => {
		const harness = browserHarness();
		harness.manager.create({ browserId: "10000000-0000-4000-8000-000000000091" });
		for (let index = 0; index <= 501; index += 1) {
			harness.emit("did-navigate", {}, `https://example.com/${index}`);
		}
		const entries = harness.manager.listHistory();
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
			harness.manager.create({ browserId });
			expect(harness.manager.listHistory()).toEqual(restored);
			expect(harness.saveHistory).not.toHaveBeenCalled();

			harness.emit("did-navigate", {}, "https://example.com/first");
			expect(harness.manager.listHistory()[0]!.url).toBe("https://example.com/first");
			expect(harness.manager.listHistory()[1]!.url).toBe("https://previous.example/");
			await vi.advanceTimersByTimeAsync(500);
			expect(harness.saveHistory).toHaveBeenLastCalledWith(harness.manager.listHistory());
			expect(harness.persisted()).toHaveLength(2);

			await harness.manager.clearHistory();
			expect(harness.persisted()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
