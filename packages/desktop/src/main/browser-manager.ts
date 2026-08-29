import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	app,
	type BrowserWindow,
	type DownloadItem,
	dialog,
	type Event,
	type FoundInPageResult,
	type Input,
	type NativeImage,
	type Session,
	session,
	shell,
	type WebContents,
	WebContentsView,
	type WebContentsViewConstructorOptions,
	type WebContentsWillNavigateEventParams,
	type WebContentsWillRedirectEventParams,
} from "electron";
import type {
	DesktopBrowserCommand,
	DesktopBrowserControlInput,
	DesktopBrowserEvent,
	DesktopBrowserState,
	DesktopCreateBrowserInput,
	DesktopDownloadControlInput,
	DesktopDownloadItem,
	DesktopDownloadState,
	DesktopHistoryEntry,
} from "../shared/desktop-api.ts";

const BLANK_URL = "about:blank";
const BROWSER_PARTITION = "persist:metis-browser";
const MAX_HISTORY_ENTRIES = 500;
const ZOOM_PERCENTAGES = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const;

interface BrowserRecord {
	readonly view: WebContentsView;
	readonly cleanup: (() => void)[];
	state: DesktopBrowserState;
	presentationKey: string;
	findRequestId: number;
}

interface DownloadRecord {
	readonly downloadId: string;
	readonly url: string;
	readonly filename: string;
	readonly savePath: string;
	readonly startedAt: number;
	item?: DownloadItem;
	state: DesktopDownloadState;
	receivedBytes: number;
	totalBytes: number;
}

interface BrowserManagerDependencies {
	readonly browserSession: Session;
	readonly createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
	readonly openExternal: (url: string) => Promise<void>;
	readonly savePdf: (data: Buffer, defaultFilename: string) => Promise<void>;
	readonly saveScreenshot: (image: NativeImage, defaultFilename: string) => Promise<void>;
	readonly resolveDownloadDirectory: () => string;
	readonly pathExists: (path: string) => boolean;
	readonly openPath: (path: string) => Promise<void>;
	readonly showItemInFolder: (path: string) => void;
}

function normalizeBrowserUrl(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error("Invalid browser URL");
	const hasScheme = /^[a-z][a-z\d+.-]*:/iu.test(trimmed);
	const hasPort = /^[^/?#\s]+:\d+(?:[/?#]|$)/u.test(trimmed);
	const authority = trimmed.split(/[/?#]/u, 1)[0] ?? "";
	const looksLikeHost =
		!/[\s@]/u.test(trimmed) &&
		(hasPort ||
			authority.toLowerCase() === "localhost" ||
			authority.includes(".") ||
			/^\[[^\]]+\]$/u.test(authority));
	if (!hasScheme && !looksLikeHost) {
		const searchUrl = new URL("https://www.google.com/search");
		searchUrl.searchParams.set("q", trimmed);
		return searchUrl.toString();
	}
	const candidate = hasScheme && !hasPort ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error("Invalid browser URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported browser URL");
	if (url.username !== "" || url.password !== "") throw new Error("Browser URLs cannot contain credentials");
	return url.toString();
}

function initialState(browserId: string): DesktopBrowserState {
	return {
		browserId,
		url: "",
		title: "New tab",
		faviconUrl: null,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		zoomPercent: 100,
	};
}

function screenshotFilename(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `Metis-Screenshot-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}

function printFilename(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `Metis-Print-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.pdf`;
}

async function saveBuffer(data: Buffer, defaultFilename: string, name: string, extension: string): Promise<void> {
	const result = await dialog.showSaveDialog({
		defaultPath: defaultFilename,
		filters: [{ name, extensions: [extension] }],
	});
	if (!result.canceled && result.filePath) await writeFile(result.filePath, data);
}

function printPage(contents: WebContents): Promise<"done" | "no-printer"> {
	return new Promise((resolve, reject) => {
		contents.print({ printBackground: true }, (success, failureReason) => {
			if (success || /cancel/iu.test(failureReason)) resolve("done");
			else if (/no printers? available/iu.test(failureReason)) resolve("no-printer");
			else reject(new Error(failureReason || "Print failed"));
		});
	});
}

function isAbortedNavigation(cause: unknown): boolean {
	return (
		typeof cause === "object" &&
		cause !== null &&
		(("code" in cause && cause.code === "ERR_ABORTED") ||
			("errno" in cause && cause.errno === -3) ||
			String(cause).includes("ERR_ABORTED"))
	);
}

function sanitizeFilename(value: string): string {
	const name = (value || "download").split(/[\\/]/u).pop()?.trim() ?? "";
	const bounded = (name.length > 0 ? name : "download").slice(0, 180);
	return bounded;
}

function uniqueFilename(directory: string, filename: string, pathExists: (path: string) => boolean): string {
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const extension = dot > 0 ? filename.slice(dot) : "";
	let candidate = filename;
	for (let index = 1; index < 1000; index += 1) {
		if (!pathExists(join(directory, candidate))) return candidate;
		candidate = `${stem} (${index})${extension}`;
	}
	return `${stem}-${Date.now()}${extension}`;
}

export class BrowserManager {
	private readonly dependencies: BrowserManagerDependencies;
	private readonly records = new Map<string, BrowserRecord>();
	private readonly downloads = new Map<string, DownloadRecord>();
	private historyEntries: DesktopHistoryEntry[] = [];
	private readonly listeners = new Set<(event: DesktopBrowserEvent) => void>();
	private downloadEmitTimer?: NodeJS.Timeout;
	private owner?: Pick<BrowserWindow, "contentView">;

	constructor(
		dependencies: BrowserManagerDependencies = {
			browserSession: session.fromPartition(BROWSER_PARTITION),
			createView: (options) => new WebContentsView(options),
			openExternal: (url) => shell.openExternal(url),
			savePdf: (data, defaultFilename) => saveBuffer(data, defaultFilename, "PDF document", "pdf"),
			saveScreenshot: (image, defaultFilename) => saveBuffer(image.toPNG(), defaultFilename, "PNG image", "png"),
			resolveDownloadDirectory: () => app.getPath("downloads"),
			pathExists: (path) => existsSync(path),
			openPath: (path) => shell.openPath(path).then(() => undefined),
			showItemInFolder: (path) => shell.showItemInFolder(path),
		},
	) {
		this.dependencies = dependencies;
		dependencies.browserSession.setPermissionCheckHandler(() => false);
		dependencies.browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
		dependencies.browserSession.on("will-download", this.onWillDownload);
	}

	attach(window: Pick<BrowserWindow, "contentView">): void {
		if (this.owner === window) return;
		for (const record of this.records.values()) {
			record.view.setVisible(false);
			record.presentationKey = "";
			this.owner?.contentView.removeChildView(record.view);
		}
		this.owner = window;
		for (const record of this.records.values()) window.contentView.addChildView(record.view);
	}

	onEvent(listener: (event: DesktopBrowserEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	create(input: DesktopCreateBrowserInput): DesktopBrowserState {
		if (this.records.has(input.browserId)) throw new Error("Browser already exists");
		const view = this.dependencies.createView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				session: this.dependencies.browserSession,
				webSecurity: true,
			},
		});
		view.setBackgroundColor("#191a19");
		view.setBorderRadius(7);
		view.setVisible(false);
		const record: BrowserRecord = {
			view,
			cleanup: [],
			state: initialState(input.browserId),
			presentationKey: "",
			findRequestId: 0,
		};
		this.records.set(input.browserId, record);
		this.owner?.contentView.addChildView(view);
		this.bind(input.browserId, record);
		return structuredClone(record.state);
	}

	async capturePreview(browserId: string): Promise<string> {
		return (await this.record(browserId).view.webContents.capturePage()).toDataURL();
	}

	listDownloads(): readonly DesktopDownloadItem[] {
		return [...this.downloads.values()]
			.sort((first, second) => second.startedAt - first.startedAt)
			.map(({ item: _item, ...download }) => download);
	}

	async controlDownload(input: DesktopDownloadControlInput): Promise<void> {
		const record = this.downloads.get(input.downloadId);
		if (!record) throw new Error("Download is not running");
		const item = record.item;
		switch (input.type) {
			case "pause":
				if (item && !item.isPaused()) {
					item.pause();
					record.state = "paused";
					this.emitDownloads();
				}
				return;
			case "resume":
				if (item?.isPaused()) {
					item.resume();
					record.state = "progressing";
					this.emitDownloads();
				}
				return;
			case "cancel":
				item?.cancel();
				return;
			case "remove": {
				this.downloads.delete(input.downloadId);
				item?.cancel();
				if (record.state !== "completed") await rm(record.savePath, { force: true }).catch(() => undefined);
				this.emitDownloads();
				return;
			}
			case "open":
				if (record.state !== "completed") throw new Error("Download is not complete");
				await this.dependencies.openPath(record.savePath);
				return;
			case "reveal":
				this.dependencies.showItemInFolder(record.savePath);
				return;
			case "retry":
				if (item) return;
				this.dependencies.browserSession.downloadURL(record.url);
				return;
		}
	}

	listHistory(): readonly DesktopHistoryEntry[] {
		return [...this.historyEntries];
	}

	async clearHistory(): Promise<void> {
		if (this.historyEntries.length === 0) return;
		this.historyEntries = [];
		this.emitHistory();
	}

	async control(input: DesktopBrowserControlInput): Promise<void> {
		const record = this.record(input.browserId);
		if (input.type === "present") {
			const key = `${input.visible}:${input.bounds.x}:${input.bounds.y}:${input.bounds.width}:${input.bounds.height}`;
			if (key === record.presentationKey) return;
			record.presentationKey = key;
			record.view.setBounds(input.bounds);
			record.view.setVisible(input.visible);
			return;
		}
		if (input.type === "navigate") {
			const url = normalizeBrowserUrl(input.url);
			record.state = { ...record.state, url, loading: true };
			this.emit({ type: "state", state: structuredClone(record.state) });
			try {
				await record.view.webContents.loadURL(url);
			} catch (cause) {
				if (isAbortedNavigation(cause)) return;
				throw cause;
			}
			return;
		}
		if (input.type === "back") {
			if (record.view.webContents.navigationHistory.canGoBack()) record.view.webContents.navigationHistory.goBack();
			return;
		}
		if (input.type === "forward") {
			if (record.view.webContents.navigationHistory.canGoForward()) {
				record.view.webContents.navigationHistory.goForward();
			}
			return;
		}
		if (input.type === "reload") {
			record.view.webContents.reload();
			return;
		}
		if (input.type === "find") {
			if (input.text === "") {
				record.findRequestId = 0;
				record.view.webContents.stopFindInPage("clearSelection");
				this.emit({ type: "find-result", browserId: input.browserId, activeMatchOrdinal: 0, matches: 0 });
				return;
			}
			record.findRequestId = record.view.webContents.findInPage(input.text, {
				forward: input.forward,
				findNext: input.findNext,
			});
			return;
		}
		if (input.type === "stop-find") {
			record.findRequestId = 0;
			record.view.webContents.stopFindInPage("clearSelection");
			this.emit({ type: "find-result", browserId: input.browserId, activeMatchOrdinal: 0, matches: 0 });
			return;
		}
		if (input.type === "print") {
			if ((await printPage(record.view.webContents)) === "no-printer") {
				const pdf = await record.view.webContents.printToPDF({ printBackground: true });
				await this.dependencies.savePdf(pdf, printFilename());
			}
			return;
		}
		if (
			input.type === "zoom-in" ||
			input.type === "zoom-out" ||
			input.type === "zoom-reset" ||
			input.type === "set-zoom"
		) {
			const current = record.state.zoomPercent;
			const zoomPercent =
				input.type === "set-zoom"
					? input.zoomPercent
					: input.type === "zoom-reset"
						? 100
						: input.type === "zoom-in"
							? (ZOOM_PERCENTAGES.find((value) => value > current) ?? ZOOM_PERCENTAGES.at(-1)!)
							: ([...ZOOM_PERCENTAGES].reverse().find((value) => value < current) ?? ZOOM_PERCENTAGES[0]);
			if (zoomPercent === current) return;
			record.view.webContents.setZoomFactor(zoomPercent / 100);
			record.state = { ...record.state, zoomPercent };
			this.emit({ type: "state", state: structuredClone(record.state) });
			return;
		}
		if (input.type === "capture-page") {
			const image = await record.view.webContents.capturePage();
			await this.dependencies.saveScreenshot(image, screenshotFilename());
			return;
		}
		if (input.type === "clear-data") {
			await this.dependencies.browserSession.clearData({
				dataTypes: ["cache", "cookies", "indexedDB", "localStorage", "serviceWorkers"],
			});
			return;
		}
		if (input.type === "open-external" && record.state.url !== "") {
			await this.dependencies.openExternal(normalizeBrowserUrl(record.state.url));
		}
	}

	close(browserId: string): void {
		const record = this.records.get(browserId);
		if (!record) return;
		this.records.delete(browserId);
		for (const cleanup of record.cleanup.splice(0)) cleanup();
		this.owner?.contentView.removeChildView(record.view);
		if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
	}

	closeAll(): void {
		for (const browserId of [...this.records.keys()]) this.close(browserId);
	}

	private record(browserId: string): BrowserRecord {
		const record = this.records.get(browserId);
		if (!record) throw new Error("Browser is not running");
		return record;
	}

	private bind(browserId: string, record: BrowserRecord): void {
		const contents = record.view.webContents;
		const sync = () => {
			if (this.records.get(browserId) !== record) return;
			const url = contents.getURL();
			record.state = {
				...record.state,
				url: url === BLANK_URL ? record.state.url : url,
				canGoBack: contents.navigationHistory.canGoBack(),
				canGoForward: contents.navigationHistory.canGoForward(),
			};
			this.emit({ type: "state", state: structuredClone(record.state) });
		};
		const onDidStartLoading = () => {
			record.state = { ...record.state, loading: true };
			sync();
		};
		const onDidStopLoading = () => {
			record.state = { ...record.state, loading: false };
			sync();
		};
		const onDidNavigate = (_event: Event, url: string) => {
			contents.setZoomFactor(record.state.zoomPercent / 100);
			this.recordHistoryVisit(url === "" ? contents.getURL() : url);
			sync();
		};
		const onDidNavigateInPage = (_event: Event, url: string, isMainFrame: boolean) => {
			if (isMainFrame) this.recordHistoryVisit(url);
			sync();
		};
		const onPageTitleUpdated = (_event: Event, title: string) => {
			const trimmed = title.trim() || "New tab";
			record.state = { ...record.state, title: trimmed };
			this.updateHistoryEntry(contents.getURL(), { title: trimmed });
			sync();
		};
		const onPageFaviconUpdated = (_event: Event, favicons: string[]) => {
			record.state = { ...record.state, faviconUrl: favicons[0] ?? null };
			this.updateHistoryEntry(contents.getURL(), { faviconUrl: favicons[0] ?? null });
			sync();
		};
		const onDidFailLoad = (
			_event: Event,
			errorCode: number,
			errorDescription: string,
			_url: string,
			isMainFrame: boolean,
		) => {
			if (isMainFrame && errorCode !== -3) this.emit({ type: "error", browserId, message: errorDescription });
		};
		const onRenderProcessGone = () => {
			this.emit({ type: "error", browserId, message: "Browser page crashed" });
		};
		const onWillNavigate = (
			event: Event<WebContentsWillNavigateEventParams | WebContentsWillRedirectEventParams>,
		) => {
			try {
				normalizeBrowserUrl(event.url);
			} catch {
				event.preventDefault();
			}
		};
		const onFoundInPage = (_event: Event, result: FoundInPageResult) => {
			if (result.requestId !== record.findRequestId) return;
			this.emit({
				type: "find-result",
				browserId,
				activeMatchOrdinal: result.activeMatchOrdinal,
				matches: result.matches,
			});
		};
		const onBeforeInput = (event: Event, input: Input) => {
			if (input.type !== "keyDown" || input.isComposing || input.alt || !(input.meta || input.control)) return;
			let command: DesktopBrowserCommand | null = null;
			if (input.key.toLowerCase() === "f") command = "find";
			else if (input.key.toLowerCase() === "p") command = "print";
			else if (input.key === "-") command = "zoom-out";
			else if (input.key === "+" || input.key === "=") command = "zoom-in";
			else if (input.key === "0") command = "zoom-reset";
			if (!command) return;
			event.preventDefault();
			this.emit({ type: "command", browserId, command });
		};
		const onDestroyed = () => {
			if (this.records.get(browserId) !== record) return;
			this.records.delete(browserId);
			for (const cleanup of record.cleanup.splice(0)) cleanup();
			this.owner?.contentView.removeChildView(record.view);
			this.emit({ type: "error", browserId, message: "Browser page crashed" });
		};

		contents.on("did-start-loading", onDidStartLoading);
		contents.on("did-stop-loading", onDidStopLoading);
		contents.on("did-navigate", onDidNavigate);
		contents.on("did-navigate-in-page", onDidNavigateInPage);
		contents.on("page-title-updated", onPageTitleUpdated);
		contents.on("page-favicon-updated", onPageFaviconUpdated);
		contents.on("did-fail-load", onDidFailLoad);
		contents.on("render-process-gone", onRenderProcessGone);
		contents.on("will-navigate", onWillNavigate);
		contents.on("will-redirect", onWillNavigate);
		contents.on("found-in-page", onFoundInPage);
		contents.on("before-input-event", onBeforeInput);
		contents.on("destroyed", onDestroyed);
		record.cleanup.push(
			() => contents.off("did-start-loading", onDidStartLoading),
			() => contents.off("did-stop-loading", onDidStopLoading),
			() => contents.off("did-navigate", onDidNavigate),
			() => contents.off("did-navigate-in-page", onDidNavigateInPage),
			() => contents.off("page-title-updated", onPageTitleUpdated),
			() => contents.off("page-favicon-updated", onPageFaviconUpdated),
			() => contents.off("did-fail-load", onDidFailLoad),
			() => contents.off("render-process-gone", onRenderProcessGone),
			() => contents.off("will-navigate", onWillNavigate),
			() => contents.off("will-redirect", onWillNavigate),
			() => contents.off("found-in-page", onFoundInPage),
			() => contents.off("before-input-event", onBeforeInput),
			() => contents.off("destroyed", onDestroyed),
		);
		contents.setWindowOpenHandler(({ url }) => {
			void this.control({ type: "navigate", browserId, url }).catch((cause) => {
				this.emit({
					type: "error",
					browserId,
					message: cause instanceof Error ? cause.message : "Navigation failed",
				});
			});
			return { action: "deny" };
		});
	}

	private readonly onWillDownload = (_event: Event, item: DownloadItem): void => {
		const downloadId = randomUUID();
		const directory = this.dependencies.resolveDownloadDirectory();
		const filename = uniqueFilename(directory, sanitizeFilename(item.getFilename()), this.dependencies.pathExists);
		const savePath = join(directory, filename);
		item.setSavePath(savePath);
		const record: DownloadRecord = {
			downloadId,
			url: item.getURL(),
			filename,
			savePath,
			startedAt: Date.now(),
			item,
			state: "progressing",
			receivedBytes: item.getReceivedBytes(),
			totalBytes: item.getTotalBytes(),
		};
		this.downloads.set(downloadId, record);
		item.on("updated", (_updateEvent, state) => {
			record.receivedBytes = item.getReceivedBytes();
			record.totalBytes = item.getTotalBytes();
			record.state = state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing";
			this.scheduleDownloadEmit();
		});
		item.once("done", (_doneEvent, state) => {
			record.item = undefined;
			record.receivedBytes = item.getReceivedBytes();
			record.totalBytes = item.getTotalBytes();
			record.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
			if (record.state !== "completed") void rm(record.savePath, { force: true }).catch(() => undefined);
			this.emitDownloads();
		});
		this.emitDownloads();
	};

	private scheduleDownloadEmit(): void {
		if (this.downloadEmitTimer) return;
		this.downloadEmitTimer = setTimeout(() => {
			this.downloadEmitTimer = undefined;
			this.emitDownloads();
		}, 200);
		this.downloadEmitTimer.unref?.();
	}

	private emitDownloads(): void {
		if (this.downloadEmitTimer) {
			clearTimeout(this.downloadEmitTimer);
			this.downloadEmitTimer = undefined;
		}
		this.emit({ type: "downloads", downloads: this.listDownloads() });
	}

	private recordHistoryVisit(url: string): void {
		if (url === "" || url === BLANK_URL) return;
		try {
			normalizeBrowserUrl(url);
		} catch {
			return;
		}
		const visitedAt = Date.now();
		const newest = this.historyEntries[0];
		if (newest && newest.url === url) {
			this.historyEntries[0] = { ...newest, visitedAt };
			this.emitHistory();
			return;
		}
		this.historyEntries = [
			{ entryId: randomUUID(), url, title: "New tab", faviconUrl: null, visitedAt },
			...this.historyEntries,
		].slice(0, MAX_HISTORY_ENTRIES);
		this.emitHistory();
	}

	private updateHistoryEntry(url: string, patch: { title?: string; faviconUrl?: string | null }): void {
		const index = this.historyEntries.findIndex((entry) => entry.url === url);
		if (index === -1) return;
		const entry = this.historyEntries[index]!;
		this.historyEntries[index] = {
			...entry,
			title: patch.title ?? entry.title,
			faviconUrl: patch.faviconUrl ?? entry.faviconUrl,
		};
		this.emitHistory();
	}

	private emitHistory(): void {
		this.emit({ type: "history", entries: this.listHistory() });
	}

	private emit(event: DesktopBrowserEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
