import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type BrowserHandoffDetails,
	type BrowserNavigateInput,
	type BrowserToolCall,
	type BrowserToolResult,
	MAX_BROWSER_TABS_PER_SESSION,
	type RpcErrorName,
} from "@metis/app-protocol";
import {
	app,
	BaseWindow,
	BrowserWindow,
	type BrowserWindowConstructorOptions,
	type DownloadItem,
	dialog,
	type Event,
	type FoundInPageResult,
	type Input,
	type NativeImage,
	type Session,
	session,
	shell,
	type View,
	type WebContents,
	WebContentsView,
	type WebContentsViewConstructorOptions,
	type WebContentsWillNavigateEventParams,
	type WebContentsWillRedirectEventParams,
} from "electron";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserBounds,
	type DesktopBrowserCommand,
	type DesktopBrowserControlInput,
	type DesktopBrowserEvent,
	type DesktopBrowserImportInput,
	type DesktopBrowserImportResult,
	type DesktopBrowserImportSource,
	type DesktopBrowserProfile,
	type DesktopBrowserState,
	type DesktopCreateBrowserInput,
	type DesktopDownloadControlInput,
	type DesktopDownloadItem,
	type DesktopDownloadState,
	type DesktopHistoryEntry,
	type DesktopListBrowserHistoryInput,
} from "../shared/desktop-api.ts";
import { BrowserController, type BrowserControllerDependencies } from "./browser-controller.ts";
import { BrowserProfileStore, mergeBrowserHistory } from "./browser-profile-store.ts";
import { ChromiumBrowserImporter } from "./chromium-browser-import.ts";

const BLANK_URL = "about:blank";
const DEFAULT_BROWSER_BOUNDS: DesktopBrowserBounds = { x: 0, y: 0, width: 1_024, height: 768 };
const MAX_HISTORY_ENTRIES = 500;
const HISTORY_SAVE_DELAY_MS = 500;
const ACTIVITY_IDLE_DELAY_MS = 50;
const ZOOM_PERCENTAGES = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const;

interface BrowserRecord {
	readonly browserId: string;
	readonly sessionId: string;
	readonly profileId: string;
	readonly contents: WebContents;
	readonly view?: WebContentsView;
	readonly popupWindow?: BrowserPopupWindow;
	readonly controller: BrowserControllerLike;
	readonly cleanup: (() => void)[];
	host?: BrowserViewHost;
	state: DesktopBrowserState;
	presentationKey: string;
	presentation?: {
		readonly visible: boolean;
		readonly bounds: { x: number; y: number; width: number; height: number };
	};
	findRequestId: number;
	controlState: "idle" | "agent" | "handoff";
	activityActive: boolean;
	activityIdleTimer?: NodeJS.Timeout;
	activeAbort?: AbortController;
	takeoverRequested: boolean;
	handoff?: HandoffRecord;
	commandTail: Promise<void>;
}

type BrowserViewHost = Pick<View, "addChildView" | "removeChildView">;
type BrowserBackgroundWindow = Pick<BaseWindow, "contentView" | "destroy" | "isDestroyed">;
type BrowserPopupWindow = Pick<
	BrowserWindow,
	| "webContents"
	| "destroy"
	| "focus"
	| "isDestroyed"
	| "setBounds"
	| "setFocusable"
	| "setIgnoreMouseEvents"
	| "setOpacity"
	| "show"
	| "showInactive"
>;

type BrowserControllerLike = Pick<BrowserController, "observe" | "act" | "invalidate" | "close">;

export class BrowserToolError extends Error {
	readonly rpcErrorName: RpcErrorName;

	constructor(rpcErrorName: RpcErrorName, message: string) {
		super(message);
		this.name = "BrowserToolError";
		this.rpcErrorName = rpcErrorName;
	}
}

interface HandoffRecord {
	readonly reason: Extract<BrowserToolCall, { tool: "browser_handoff" }>["input"]["reason"];
	readonly promise: Promise<HandoffOutcome>;
	readonly resolve: (outcome: HandoffOutcome) => void;
	readonly timer: NodeJS.Timeout;
}

type BrowserHandoffCancellationReason = Extract<BrowserHandoffDetails, { status: "cancelled" }>["reason"];
type HandoffOutcome =
	| { readonly status: "complete" }
	| { readonly status: "cancel"; readonly reason: BrowserHandoffCancellationReason };

interface DownloadRecord {
	readonly profileId: string;
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
	readonly profileStore: BrowserProfileStore;
	readonly importer: Pick<ChromiumBrowserImporter, "listSources" | "readProfile">;
	readonly sessionForPartition: (partition: string) => Session;
	readonly createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
	readonly createBackgroundWindow: () => BrowserBackgroundWindow;
	readonly createPopupWindow: (options: BrowserWindowConstructorOptions) => BrowserPopupWindow;
	readonly openExternal: (url: string) => Promise<void>;
	readonly savePdf: (data: Buffer, defaultFilename: string) => Promise<void>;
	readonly saveScreenshot: (image: NativeImage, defaultFilename: string) => Promise<void>;
	readonly resolveDownloadDirectory: () => string;
	readonly pathExists: (path: string) => boolean;
	readonly openPath: (path: string) => Promise<void>;
	readonly showItemInFolder: (path: string) => void;
	readonly createController?: (input: {
		readonly browserId: string;
		readonly profileId: string;
		readonly contents: WebContents;
	}) => BrowserControllerLike;
	readonly handoffTimeoutMs?: number;
	readonly navigationTimeoutMs?: number;
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

function initialState(browserId: string, profileId: string): DesktopBrowserState {
	return {
		browserId,
		profileId,
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
	private readonly sessions = new Map<string, Session>();
	private readonly histories = new Map<string, DesktopHistoryEntry[]>();
	private readonly listeners = new Set<(event: DesktopBrowserEvent) => void>();
	private downloadEmitTimer?: NodeJS.Timeout;
	private readonly historySaveTimers = new Map<string, NodeJS.Timeout>();
	private owner?: Pick<BrowserWindow, "contentView" | "getBounds">;
	private automationWindow?: BrowserBackgroundWindow;

	constructor(
		dependencies: BrowserManagerDependencies = {
			profileStore: new BrowserProfileStore(app.getPath("userData")),
			importer: new ChromiumBrowserImporter(),
			sessionForPartition: (partition) => session.fromPartition(partition),
			createView: (options) => new WebContentsView(options),
			createBackgroundWindow: () =>
				new BaseWindow({
					show: false,
					frame: false,
					focusable: false,
					skipTaskbar: true,
					width: DEFAULT_BROWSER_BOUNDS.width,
					height: DEFAULT_BROWSER_BOUNDS.height,
				}),
			createPopupWindow: (options) => new BrowserWindow(options),
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
	}

	attach(window: Pick<BrowserWindow, "contentView" | "getBounds">): void {
		if (this.owner === window) return;
		this.owner = window;
		for (const record of this.records.values()) {
			record.presentationKey = "";
			this.placeSurface(record, record.controlState !== "agent" && Boolean(record.presentation?.visible));
		}
	}

	suspendRenderer(): void {
		for (const record of this.records.values()) {
			record.presentation = undefined;
			record.presentationKey = "";
			this.placeSurface(record, false);
		}
	}

	onEvent(listener: (event: DesktopBrowserEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	listProfiles(): readonly DesktopBrowserProfile[] {
		return this.dependencies.profileStore.listProfiles();
	}

	async listImportSources(): Promise<readonly DesktopBrowserImportSource[]> {
		return this.dependencies.importer.listSources();
	}

	async importData(input: DesktopBrowserImportInput): Promise<DesktopBrowserImportResult> {
		const source = (await this.dependencies.importer.listSources()).find(
			(candidate) => candidate.sourceId === input.sourceId,
		);
		const sourceProfile = source?.profiles.find((candidate) => candidate.sourceProfileId === input.sourceProfileId);
		if (!source || !sourceProfile) throw new Error("Browser profile is no longer available");
		if (source.running) throw new Error(`Close ${source.name} before importing`);
		const imported = await this.dependencies.importer.readProfile(input);
		if (imported.cookies.length === 0 && imported.history.length === 0) {
			throw new Error("No browser data could be imported");
		}
		const profile = this.dependencies.profileStore.ensureImportedProfile({
			sourceId: input.sourceId,
			sourceProfileId: input.sourceProfileId,
			name: sourceProfile.name,
		});
		let importedCount = 0;
		let skippedCount = imported.cookieSkipped;
		if (input.dataTypes.cookies) {
			const target = this.sessionForProfile(profile.profileId).cookies;
			for (let index = 0; index < imported.cookies.length; index += 32) {
				const results = await Promise.allSettled(
					imported.cookies.slice(index, index + 32).map((cookie) => target.set(cookie)),
				);
				for (const result of results) {
					if (result.status === "fulfilled") importedCount += 1;
					else skippedCount += 1;
				}
			}
			await target.flushStore();
		}
		const merged = input.dataTypes.history
			? mergeBrowserHistory(this.historyForProfile(profile.profileId), imported.history)
			: null;
		if (merged) {
			this.histories.set(profile.profileId, [...merged]);
			this.dependencies.profileStore.saveHistory(profile.profileId, merged);
			this.emit({ type: "history", profileId: profile.profileId, entries: merged });
		}
		return {
			profile,
			cookies: input.dataTypes.cookies ? { imported: importedCount, skipped: skippedCount } : null,
			history: input.dataTypes.history ? { accepted: imported.history.length, retained: merged!.length } : null,
		};
	}

	create(input: DesktopCreateBrowserInput): DesktopBrowserState {
		const existing = this.records.get(input.browserId);
		if (existing) {
			if (existing.sessionId === input.sessionId && existing.profileId === input.profileId) {
				return structuredClone(existing.state);
			}
			throw new Error("Browser already belongs to another task or profile");
		}
		if (
			[...this.records.values()].filter(({ sessionId }) => sessionId === input.sessionId).length >=
			MAX_BROWSER_TABS_PER_SESSION
		) {
			throw new BrowserToolError("OVERLOADED", "This task already has the maximum number of browser tabs");
		}
		const browserSession = this.sessionForProfile(input.profileId);
		const view = this.dependencies.createView({
			webPreferences: {
				backgroundThrottling: false,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				session: browserSession,
				webSecurity: true,
			},
		});
		return this.registerView(input, view);
	}

	private registerView(input: DesktopCreateBrowserInput, view: WebContentsView): DesktopBrowserState {
		view.setBackgroundColor("#191a19");
		view.setBorderRadius(7);
		return this.registerRecord(input, view.webContents, { view });
	}

	private registerPopup(input: DesktopCreateBrowserInput, popupWindow: BrowserPopupWindow): DesktopBrowserState {
		return this.registerRecord(input, popupWindow.webContents, { popupWindow });
	}

	private registerRecord(
		input: DesktopCreateBrowserInput,
		contents: WebContents,
		surface: { readonly view: WebContentsView } | { readonly popupWindow: BrowserPopupWindow },
	): DesktopBrowserState {
		const popupWindow = "popupWindow" in surface ? surface.popupWindow : undefined;
		const controller = this.createController(
			input.browserId,
			input.profileId,
			contents,
			popupWindow
				? ({ x, y, button }) => {
						if (popupWindow.isDestroyed()) return;
						popupWindow.setFocusable(true);
						popupWindow.show();
						popupWindow.focus();
						const point = { x: Math.round(x), y: Math.round(y), button, clickCount: 1 } as const;
						contents.sendInputEvent({ type: "mouseMove", ...point });
						contents.sendInputEvent({ type: "mouseDown", ...point });
						contents.sendInputEvent({ type: "mouseUp", ...point });
						if (!popupWindow.isDestroyed()) popupWindow.setFocusable(false);
					}
				: undefined,
		);
		const record: BrowserRecord = {
			browserId: input.browserId,
			sessionId: input.sessionId,
			profileId: input.profileId,
			contents,
			...surface,
			controller,
			cleanup: [],
			state: initialState(input.browserId, input.profileId),
			presentationKey: "",
			findRequestId: 0,
			controlState: "idle",
			activityActive: false,
			takeoverRequested: false,
			commandTail: Promise.resolve(),
		};
		this.records.set(input.browserId, record);
		if (record.view) this.placeSurface(record, false);
		this.bind(input.browserId, record);
		this.emit({ type: "opened", sessionId: input.sessionId, browserId: input.browserId, profileId: input.profileId });
		return structuredClone(record.state);
	}

	async capturePreview(sessionId: string, browserId: string): Promise<string> {
		return (await this.recordForSession(sessionId, browserId).contents.capturePage()).toDataURL();
	}

	listDownloads(): readonly DesktopDownloadItem[] {
		return [...this.downloads.values()]
			.sort((first, second) => second.startedAt - first.startedAt)
			.map(({ item: _item, profileId: _profileId, ...download }) => download);
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
				this.sessionForProfile(record.profileId).downloadURL(record.url);
				return;
		}
	}

	listHistory(input: DesktopListBrowserHistoryInput): readonly DesktopHistoryEntry[] {
		return [...this.historyForProfile(input.profileId)];
	}

	async clearHistory(input: DesktopListBrowserHistoryInput): Promise<void> {
		if (this.historyForProfile(input.profileId).length === 0) return;
		this.histories.set(input.profileId, []);
		this.emitHistory(input.profileId);
		this.persistHistory(input.profileId, true);
	}

	async control(input: DesktopBrowserControlInput): Promise<void> {
		if (input.type === "present") {
			const record = this.records.get(input.browserId);
			if (!record) return;
			if (record.sessionId !== input.sessionId) throw new Error("Browser does not belong to this task");
			if (record.controlState === "agent") return;
			record.presentation = { visible: input.visible, bounds: input.bounds };
			const key = `${input.visible}:${input.bounds.x}:${input.bounds.y}:${input.bounds.width}:${input.bounds.height}`;
			if (key === record.presentationKey) return;
			record.presentationKey = key;
			this.placeSurface(record, input.visible);
			return;
		}
		const record = this.recordForSession(input.sessionId, input.browserId);
		if (record.controlState !== "idle") throw new Error("Browser is currently controlled by the user or agent");
		if (input.type === "navigate") {
			await this.applyNavigation(record, { action: "goto", browserId: input.browserId, url: input.url });
			return;
		}
		if (input.type === "back") {
			await this.applyNavigation(record, { action: "back", browserId: input.browserId });
			return;
		}
		if (input.type === "forward") {
			await this.applyNavigation(record, { action: "forward", browserId: input.browserId });
			return;
		}
		if (input.type === "reload") {
			await this.applyNavigation(record, { action: "reload", browserId: input.browserId });
			return;
		}
		if (input.type === "find") {
			if (input.text === "") {
				record.findRequestId = 0;
				record.contents.stopFindInPage("clearSelection");
				this.emit({ type: "find-result", browserId: input.browserId, activeMatchOrdinal: 0, matches: 0 });
				return;
			}
			record.findRequestId = record.contents.findInPage(input.text, {
				forward: input.forward,
				findNext: input.findNext,
			});
			return;
		}
		if (input.type === "stop-find") {
			record.findRequestId = 0;
			record.contents.stopFindInPage("clearSelection");
			this.emit({ type: "find-result", browserId: input.browserId, activeMatchOrdinal: 0, matches: 0 });
			return;
		}
		if (input.type === "print") {
			if ((await printPage(record.contents)) === "no-printer") {
				const pdf = await record.contents.printToPDF({ printBackground: true });
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
			record.contents.setZoomFactor(zoomPercent / 100);
			record.state = { ...record.state, zoomPercent };
			this.emit({ type: "state", state: structuredClone(record.state) });
			return;
		}
		if (input.type === "capture-page") {
			const image = await record.contents.capturePage();
			await this.dependencies.saveScreenshot(image, screenshotFilename());
			return;
		}
		if (input.type === "clear-data") {
			await this.sessionForProfile(record.profileId).clearData({
				dataTypes: ["cache", "cookies", "indexedDB", "localStorage", "serviceWorkers"],
			});
			return;
		}
		if (input.type === "open-external" && record.state.url !== "") {
			await this.dependencies.openExternal(normalizeBrowserUrl(record.state.url));
		}
	}

	async executeTool(sessionId: string, call: BrowserToolCall, signal: AbortSignal): Promise<BrowserToolResult> {
		signal.throwIfAborted();
		switch (call.tool) {
			case "browser_tabs": {
				if (call.input.action === "open") {
					this.create({
						sessionId,
						browserId: randomUUID(),
						profileId: call.input.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
					});
				} else if (call.input.action === "close") {
					this.close(sessionId, call.input.browserId);
				}
				return { tool: call.tool, details: this.tabsDetails(sessionId) };
			}
			case "browser_navigate": {
				const record = this.recordForSession(sessionId, call.input.browserId);
				const details = await this.runAgentMutation(record, signal, async (operationSignal) => {
					operationSignal.throwIfAborted();
					await this.applyNavigation(record, call.input, operationSignal);
					return {
						status: "completed" as const,
						observation: await record.controller.observe({ browserId: record.browserId }, operationSignal),
					};
				});
				return { tool: call.tool, details };
			}
			case "browser_observe": {
				const record = this.recordForSession(sessionId, call.input.browserId);
				if (record.controlState !== "idle") throw new Error("Browser is currently controlled by the user or agent");
				return { tool: call.tool, observation: await record.controller.observe(call.input, signal) };
			}
			case "browser_act": {
				const record = this.recordForSession(sessionId, call.input.browserId);
				const details = await this.runAgentMutation(record, signal, (operationSignal) =>
					record.controller.act(call.input, operationSignal),
				);
				return { tool: call.tool, details };
			}
			case "browser_handoff": {
				const record = this.recordForSession(sessionId, call.input.browserId);
				return { tool: call.tool, details: await this.runDirectHandoff(record, call.input.reason, signal) };
			}
		}
	}

	private async applyNavigation(
		record: BrowserRecord,
		input: BrowserNavigateInput,
		signal?: AbortSignal,
	): Promise<void> {
		if (input.action === "goto") {
			await this.navigateRecord(record, input.url, signal);
			return;
		}
		record.controller.invalidate();
		if (input.action === "back") {
			if (record.contents.navigationHistory.canGoBack()) record.contents.navigationHistory.goBack();
			return;
		}
		if (input.action === "forward") {
			if (record.contents.navigationHistory.canGoForward()) record.contents.navigationHistory.goForward();
			return;
		}
		record.contents.reload();
	}

	takeControl(sessionId: string, browserId: string): void {
		const record = this.recordForSession(sessionId, browserId);
		if (record.controlState === "handoff") return;
		if (record.controlState !== "agent" || !record.activeAbort) throw new Error("Browser automation is not active");
		record.takeoverRequested = true;
		record.activeAbort.abort();
	}

	resolveHandoff(sessionId: string, browserId: string, decision: "complete" | "cancel"): void {
		const record = this.recordForSession(sessionId, browserId);
		if (!record.handoff) throw new Error("Browser handoff is not active");
		record.handoff.resolve(
			decision === "complete" ? { status: "complete" } : { status: "cancel", reason: "user_cancelled" },
		);
	}

	cancelSessionHandoffs(sessionId: string, reason: BrowserHandoffCancellationReason): void {
		for (const record of this.records.values()) {
			if (record.sessionId === sessionId) this.cancelHandoff(record, reason);
		}
	}

	replayEvents(sessionId?: string): readonly DesktopBrowserEvent[] {
		return [...this.records.values()].flatMap((record) => {
			if (sessionId && record.sessionId !== sessionId) return [];
			const events: DesktopBrowserEvent[] = [
				{
					type: "opened",
					sessionId: record.sessionId,
					browserId: record.browserId,
					profileId: record.profileId,
				},
			];
			if (record.controlState === "agent") {
				events.push({ type: "activity", sessionId: record.sessionId, browserId: record.browserId, active: true });
			} else if (record.handoff) {
				events.push({
					type: "handoff",
					sessionId: record.sessionId,
					browserId: record.browserId,
					status: "requested",
					reason: record.handoff.reason,
				});
			}
			return events;
		});
	}

	close(sessionId: string, browserId: string): void {
		const record = this.recordForSession(sessionId, browserId);
		this.closeRecord(record, "tab_closed");
	}

	private closeRecord(record: BrowserRecord, cancellationReason: BrowserHandoffCancellationReason): void {
		const { browserId } = record;
		if (this.records.get(browserId) !== record) return;
		this.records.delete(browserId);
		record.activeAbort?.abort();
		if (record.activityIdleTimer) clearTimeout(record.activityIdleTimer);
		record.activityIdleTimer = undefined;
		if (record.activityActive) {
			record.activityActive = false;
			this.emit({ type: "activity", sessionId: record.sessionId, browserId: record.browserId, active: false });
		}
		this.cancelHandoff(record, cancellationReason);
		record.controller.close();
		for (const cleanup of record.cleanup.splice(0)) cleanup();
		if (record.view) record.host?.removeChildView(record.view);
		record.host = undefined;
		if (record.popupWindow && !record.popupWindow.isDestroyed()) record.popupWindow.destroy();
		else if (!record.contents.isDestroyed()) record.contents.close();
		this.emit({ type: "closed", sessionId: record.sessionId, browserId });
	}

	closeAll(): void {
		for (const profileId of this.historySaveTimers.keys()) this.persistHistory(profileId, true);
		for (const record of [...this.records.values()]) this.closeRecord(record, "server_restarted");
		if (this.automationWindow && !this.automationWindow.isDestroyed()) this.automationWindow.destroy();
		this.automationWindow = undefined;
	}

	private record(browserId: string): BrowserRecord {
		const record = this.records.get(browserId);
		if (!record) throw new Error("Browser is not running");
		return record;
	}

	private recordForSession(sessionId: string, browserId: string): BrowserRecord {
		const record = this.record(browserId);
		if (record.sessionId !== sessionId) throw new Error("Browser does not belong to this task");
		return record;
	}

	private createController(
		browserId: string,
		profileId: string,
		contents: WebContents,
		dispatchMainFrameClick?: NonNullable<BrowserControllerDependencies["dispatchMainFrameClick"]>,
	): BrowserControllerLike {
		if (this.dependencies.createController)
			return this.dependencies.createController({ browserId, profileId, contents });
		const browserDebugger = contents.debugger;
		return new BrowserController({
			browserId,
			profileId,
			debugger: browserDebugger,
			pageState: () => ({ url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading() }),
			captureScreenshot: async (quality) => {
				let image = await contents.capturePage();
				const { width, height } = image.getSize();
				const scale = Math.min(1, 1_600 / width, 1_200 / height);
				if (scale < 1) {
					image = image.resize({
						width: Math.max(1, Math.floor(width * scale)),
						height: Math.max(1, Math.floor(height * scale)),
					});
				}
				return image.toJPEG(quality);
			},
			dispatchMainFrameClick,
			subscribeMessage: (listener) => {
				const onMessage = (_event: Event, method: string, params: Record<string, unknown>, sessionId?: string) =>
					listener(method, params, sessionId);
				browserDebugger.on("message", onMessage);
				return () => browserDebugger.off("message", onMessage);
			},
			subscribeDetach: (listener) => {
				const onDetach = () => listener();
				browserDebugger.on("detach", onDetach);
				return () => browserDebugger.off("detach", onDetach);
			},
		});
	}

	private tabsDetails(sessionId: string): Extract<BrowserToolResult, { tool: "browser_tabs" }>["details"] {
		const profiles = this.listProfiles();
		const names = new Map(profiles.map((profile) => [profile.profileId, profile.name]));
		return {
			profiles: profiles.slice(0, MAX_BROWSER_TABS_PER_SESSION * 4).map(({ profileId, name, sourceId }) => ({
				profileId,
				name,
				sourceId,
			})),
			tabs: [...this.records.values()]
				.filter((record) => record.sessionId === sessionId)
				.map((record) => ({
					browserId: record.browserId,
					profileId: record.profileId,
					profileName: names.get(record.profileId) ?? "Browser",
					title: record.state.title,
					url: record.state.url,
					loading: record.state.loading,
					controlState: record.controlState,
				})),
		};
	}

	private async navigateRecord(record: BrowserRecord, value: string, signal?: AbortSignal): Promise<void> {
		const url = normalizeBrowserUrl(value);
		record.controller.invalidate();
		record.state = { ...record.state, url, loading: true };
		this.emit({ type: "state", state: structuredClone(record.state) });
		const navigation = record.contents.loadURL(url).catch((cause) => {
			if (!isAbortedNavigation(cause)) throw cause;
		});
		if (!signal) {
			await navigation;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (next: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				next();
			};
			const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
			const timer = setTimeout(
				() => finish(() => reject(new Error("Browser navigation timed out"))),
				this.dependencies.navigationTimeoutMs ?? 15_000,
			);
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			void navigation.then(
				() => finish(resolve),
				(cause) => finish(() => reject(cause)),
			);
		});
	}

	private async runAgentMutation(
		record: BrowserRecord,
		signal: AbortSignal,
		operation: (signal: AbortSignal) => Promise<Extract<BrowserToolResult, { tool: "browser_act" }>["details"]>,
	): Promise<Extract<BrowserToolResult, { tool: "browser_act" }>["details"]> {
		if (record.controlState === "handoff") throw new Error("Browser handoff is active");
		return this.enqueueRecord(record, signal, async () => {
			if (record.controlState !== "idle") throw new Error("Browser control is unavailable");
			const activeAbort = new AbortController();
			const abortActive = () => activeAbort.abort(signal.reason);
			signal.addEventListener("abort", abortActive, { once: true });
			record.activeAbort = activeAbort;
			record.takeoverRequested = false;
			this.setControlState(record, "agent");
			try {
				let result: Extract<BrowserToolResult, { tool: "browser_act" }>["details"];
				try {
					result = await operation(activeAbort.signal);
				} catch (cause) {
					if (!record.takeoverRequested) throw cause;
					return this.takeoverHandoff(record, signal);
				}
				if (record.takeoverRequested) return this.takeoverHandoff(record, signal);
				return result;
			} finally {
				signal.removeEventListener("abort", abortActive);
				record.activeAbort = undefined;
				record.takeoverRequested = false;
				this.setControlState(record, "idle");
			}
		});
	}

	private async takeoverHandoff(
		record: BrowserRecord,
		signal: AbortSignal,
	): Promise<Extract<BrowserToolResult, { tool: "browser_act" }>["details"]> {
		const result = await this.awaitHandoff(record, "other", signal);
		if (result.status === "completed") return result;
		if (result.reason === "user_cancelled") return { status: "cancelled", reason: "user_cancelled" };
		throw new Error(`Browser handoff ended: ${result.reason}`);
	}

	private runDirectHandoff(
		record: BrowserRecord,
		reason: HandoffRecord["reason"],
		signal: AbortSignal,
	): Promise<BrowserHandoffDetails> {
		if (record.controlState === "handoff") throw new Error("Browser handoff is already active");
		return this.enqueueRecord(record, signal, async () => {
			if (record.controlState !== "idle") throw new Error("Browser control is unavailable");
			return this.awaitHandoff(record, reason, signal);
		});
	}

	private async awaitHandoff(
		record: BrowserRecord,
		reason: HandoffRecord["reason"],
		signal: AbortSignal,
	): Promise<BrowserHandoffDetails> {
		record.controller.invalidate();
		this.setControlState(record, "handoff");
		let settled = false;
		let resolvePromise!: (outcome: HandoffOutcome) => void;
		const promise = new Promise<HandoffOutcome>((resolve) => {
			resolvePromise = (outcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
		});
		const timer = setTimeout(
			() => resolvePromise({ status: "cancel", reason: "timed_out" }),
			this.dependencies.handoffTimeoutMs ?? 15 * 60 * 1_000,
		);
		timer.unref?.();
		record.handoff = { reason, promise, resolve: resolvePromise, timer };
		this.emit({
			type: "handoff",
			sessionId: record.sessionId,
			browserId: record.browserId,
			status: "requested",
			reason,
		});
		const onAbort = () => resolvePromise({ status: "cancel", reason: "turn_interrupted" });
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		const outcome = await promise;
		signal.removeEventListener("abort", onAbort);
		clearTimeout(timer);
		if (record.handoff?.promise === promise) record.handoff = undefined;
		const open = this.records.get(record.browserId) === record;
		if (open) this.setControlState(record, "idle");
		if (outcome.status === "cancel") {
			if (open) {
				this.emit({
					type: "handoff",
					sessionId: record.sessionId,
					browserId: record.browserId,
					status: "cancelled",
				});
			}
			return { status: "cancelled", reason: outcome.reason };
		}
		this.emit({ type: "handoff", sessionId: record.sessionId, browserId: record.browserId, status: "completed" });
		record.controller.invalidate();
		return {
			status: "completed",
			observation: await record.controller.observe({ browserId: record.browserId }, signal),
		};
	}

	private cancelHandoff(record: BrowserRecord, reason: BrowserHandoffCancellationReason): void {
		record.handoff?.resolve({ status: "cancel", reason });
	}

	private setControlState(record: BrowserRecord, state: BrowserRecord["controlState"]): void {
		const previous = record.controlState;
		if (previous === state) return;
		record.controlState = state;
		if (state === "agent") {
			if (record.activityIdleTimer) clearTimeout(record.activityIdleTimer);
			record.activityIdleTimer = undefined;
			this.placeSurface(record, false);
			if (!record.activityActive) {
				record.activityActive = true;
				this.emit({ type: "activity", sessionId: record.sessionId, browserId: record.browserId, active: true });
			}
			return;
		}
		if (previous === "agent") {
			if (record.activityIdleTimer) clearTimeout(record.activityIdleTimer);
			record.activityIdleTimer = setTimeout(() => {
				record.activityIdleTimer = undefined;
				if (
					!record.activityActive ||
					record.controlState === "agent" ||
					this.records.get(record.browserId) !== record
				)
					return;
				record.activityActive = false;
				this.emit({ type: "activity", sessionId: record.sessionId, browserId: record.browserId, active: false });
			}, ACTIVITY_IDLE_DELAY_MS);
			record.activityIdleTimer.unref?.();
		}
		this.placeSurface(record, Boolean(record.presentation?.visible));
	}

	private backgroundBounds(preferred: DesktopBrowserBounds = DEFAULT_BROWSER_BOUNDS): DesktopBrowserBounds {
		const desired = preferred.width >= 320 && preferred.height >= 240 ? preferred : DEFAULT_BROWSER_BOUNDS;
		return { x: 0, y: 0, width: desired.width, height: desired.height };
	}

	private backgroundHost(): BrowserViewHost {
		if (!this.automationWindow || this.automationWindow.isDestroyed()) {
			this.automationWindow = this.dependencies.createBackgroundWindow();
		}
		return this.automationWindow.contentView;
	}

	private placeSurface(record: BrowserRecord, foreground: boolean): void {
		if (record.popupWindow) {
			this.placePopupWindow(record, foreground);
			return;
		}
		if (!record.view) return;
		const host = foreground && this.owner ? this.owner.contentView : this.backgroundHost();
		if (record.host !== host) {
			record.host?.removeChildView(record.view);
			host.addChildView(record.view);
			record.host = host;
		}
		record.view.setBounds(
			foreground && record.presentation
				? record.presentation.bounds
				: this.backgroundBounds(record.presentation?.bounds),
		);
		record.view.setVisible(true);
	}

	private placePopupWindow(record: BrowserRecord, foreground: boolean): void {
		const popup = record.popupWindow;
		if (!popup || popup.isDestroyed()) return;
		if (!foreground || !record.presentation) {
			popup.setIgnoreMouseEvents(true);
			popup.setFocusable(false);
			popup.setOpacity(0);
			popup.setBounds({ ...this.backgroundBounds(record.presentation?.bounds), x: -10_000, y: 0 });
			popup.showInactive();
			return;
		}
		const ownerBounds = this.owner?.getBounds();
		popup.setBounds({
			x: (ownerBounds?.x ?? 0) + record.presentation.bounds.x,
			y: (ownerBounds?.y ?? 0) + record.presentation.bounds.y,
			width: record.presentation.bounds.width,
			height: record.presentation.bounds.height,
		});
		popup.setOpacity(1);
		popup.setFocusable(true);
		popup.setIgnoreMouseEvents(false);
		popup.show();
	}

	private async enqueueRecord<T>(record: BrowserRecord, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		const previous = record.commandTail.catch(() => undefined);
		let release!: () => void;
		record.commandTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			signal.throwIfAborted();
			if (this.records.get(record.browserId) !== record) throw new Error("Browser is not running");
			return await operation();
		} finally {
			release();
		}
	}

	private sessionForProfile(profileId: string): Session {
		if (!this.dependencies.profileStore.listProfiles().some((profile) => profile.profileId === profileId)) {
			throw new Error("Browser profile does not exist");
		}
		const existing = this.sessions.get(profileId);
		if (existing) return existing;
		const partition =
			profileId === DEFAULT_BROWSER_PROFILE_ID ? "persist:metis-browser" : `persist:metis-browser-${profileId}`;
		const created = this.dependencies.sessionForPartition(partition);
		created.setPermissionCheckHandler(() => false);
		created.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
		created.on("will-download", (event, item) => this.onWillDownload(profileId, event, item));
		this.sessions.set(profileId, created);
		return created;
	}

	private historyForProfile(profileId: string): DesktopHistoryEntry[] {
		if (!this.dependencies.profileStore.listProfiles().some((profile) => profile.profileId === profileId)) {
			throw new Error("Browser profile does not exist");
		}
		const existing = this.histories.get(profileId);
		if (existing) return existing;
		const loaded = [...this.dependencies.profileStore.loadHistory(profileId)];
		this.histories.set(profileId, loaded);
		return loaded;
	}

	private bind(browserId: string, record: BrowserRecord): void {
		const contents = record.contents;
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
			this.recordHistoryVisit(record.profileId, url === "" ? contents.getURL() : url);
			sync();
		};
		const onDidNavigateInPage = (_event: Event, url: string, isMainFrame: boolean) => {
			if (isMainFrame) this.recordHistoryVisit(record.profileId, url);
			sync();
		};
		const onPageTitleUpdated = (_event: Event, title: string) => {
			const trimmed = title.trim() || "New tab";
			record.state = { ...record.state, title: trimmed };
			this.updateHistoryEntry(record.profileId, contents.getURL(), { title: trimmed });
			sync();
		};
		const onPageFaviconUpdated = (_event: Event, favicons: string[]) => {
			record.state = { ...record.state, faviconUrl: favicons[0] ?? null };
			this.updateHistoryEntry(record.profileId, contents.getURL(), { faviconUrl: favicons[0] ?? null });
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
			this.closeRecord(record, "tab_closed");
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
			record.activeAbort?.abort();
			this.cancelHandoff(record, "tab_closed");
			record.controller.close();
			for (const cleanup of record.cleanup.splice(0)) cleanup();
			if (record.view) record.host?.removeChildView(record.view);
			record.host = undefined;
			this.emit({ type: "closed", sessionId: record.sessionId, browserId });
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
			try {
				normalizeBrowserUrl(url);
				if (
					[...this.records.values()].filter(({ sessionId }) => sessionId === record.sessionId).length >=
					MAX_BROWSER_TABS_PER_SESSION
				) {
					throw new Error("This task already has the maximum number of browser tabs");
				}
			} catch (cause) {
				this.emit({
					type: "error",
					browserId,
					message: cause instanceof Error ? cause.message : "Popup was blocked",
				});
				return { action: "deny" };
			}
			return {
				action: "allow",
				createWindow: (options) => {
					const popupId = randomUUID();
					const popup = this.dependencies.createPopupWindow({
						...options,
						show: true,
						frame: false,
						focusable: false,
						opacity: 0,
						skipTaskbar: true,
						x: -10_000,
						y: 0,
						webPreferences: {
							...options.webPreferences,
							backgroundThrottling: false,
							contextIsolation: true,
							nodeIntegration: false,
							sandbox: true,
							session: this.sessionForProfile(record.profileId),
							webSecurity: true,
						},
					});
					this.registerPopup(
						{ sessionId: record.sessionId, browserId: popupId, profileId: record.profileId },
						popup,
					);
					return popup.webContents;
				},
			};
		});
	}

	private readonly onWillDownload = (profileId: string, _event: Event, item: DownloadItem): void => {
		const downloadId = randomUUID();
		const directory = this.dependencies.resolveDownloadDirectory();
		const filename = uniqueFilename(directory, sanitizeFilename(item.getFilename()), this.dependencies.pathExists);
		const savePath = join(directory, filename);
		item.setSavePath(savePath);
		const record: DownloadRecord = {
			profileId,
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

	private recordHistoryVisit(profileId: string, url: string): void {
		if (url === "" || url === BLANK_URL) return;
		try {
			normalizeBrowserUrl(url);
		} catch {
			return;
		}
		const visitedAt = Date.now();
		const historyEntries = this.historyForProfile(profileId);
		const newest = historyEntries[0];
		if (newest && newest.url === url) {
			historyEntries[0] = { ...newest, visitedAt };
			this.emitHistory(profileId);
			return;
		}
		this.histories.set(
			profileId,
			[{ entryId: randomUUID(), url, title: "New tab", faviconUrl: null, visitedAt }, ...historyEntries].slice(
				0,
				MAX_HISTORY_ENTRIES,
			),
		);
		this.emitHistory(profileId);
	}

	private updateHistoryEntry(
		profileId: string,
		url: string,
		patch: { title?: string; faviconUrl?: string | null },
	): void {
		const historyEntries = this.historyForProfile(profileId);
		const index = historyEntries.findIndex((entry) => entry.url === url);
		if (index === -1) return;
		const entry = historyEntries[index]!;
		historyEntries[index] = {
			...entry,
			title: patch.title ?? entry.title,
			faviconUrl: patch.faviconUrl ?? entry.faviconUrl,
		};
		this.emitHistory(profileId);
	}

	private emitHistory(profileId: string): void {
		this.emit({ type: "history", profileId, entries: this.listHistory({ profileId }) });
		this.persistHistory(profileId);
	}

	private persistHistory(profileId: string, immediate = false): void {
		const timer = this.historySaveTimers.get(profileId);
		if (timer) {
			clearTimeout(timer);
			this.historySaveTimers.delete(profileId);
		}
		if (immediate) {
			this.dependencies.profileStore.saveHistory(profileId, this.historyForProfile(profileId));
			return;
		}
		const next = setTimeout(() => {
			this.historySaveTimers.delete(profileId);
			this.dependencies.profileStore.saveHistory(profileId, this.historyForProfile(profileId));
		}, HISTORY_SAVE_DELAY_MS);
		next.unref?.();
		this.historySaveTimers.set(profileId, next);
	}

	private emit(event: DesktopBrowserEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
