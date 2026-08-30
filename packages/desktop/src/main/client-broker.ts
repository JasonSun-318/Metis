import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	type ClientParams,
	type ClientResult,
	type ClientRpcRequest,
	type ClientRpcSuccessResponse,
	createRpcError,
	type InteractionResponseInput,
	type RpcErrorResponse,
	type ServerRpcRequest,
	type ServerRpcSuccessResponse,
	type SessionSummary,
	validateClientRequest,
	validateServerNotification,
	validateServerRequest,
} from "@metis/app-protocol";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { DESKTOP_RPC_FORWARDING } from "../shared/app-server-rpc-forwarding.ts";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	DESKTOP_BROWSER_EVENT_CHANNEL,
	DESKTOP_EVENT_CHANNEL,
	DESKTOP_IPC_CHANNELS,
	DESKTOP_TERMINAL_EVENT_CHANNEL,
	type DesktopApiEvent,
	type DesktopAttachmentSelection,
	type DesktopBrowserEvent,
	type DesktopCreateProjectFolderInput,
	type DesktopRpcOutcome,
	type DesktopTerminalEvent,
	type DesktopUpdateState,
	type DesktopWorkspaceEditState,
	type SupervisorView,
	validateBrowserControlInput,
	validateBrowserDownloadControlInput,
	validateBrowserImportInput,
	validateCloseBrowserInput,
	validateCloseTerminalInput,
	validateCreateBrowserInput,
	validateCreateTerminalInput,
	validateInteractionResponseInput,
	validateListBrowserHistoryInput,
	validateListWorkspaceDirectoryInput,
	validateOpenWorkspaceFileInput,
	validateReadPreviewFileInput,
	validateReadWorkspaceFileInput,
	validateResizeTerminalInput,
	validateResolveBrowserHandoffInput,
	validateSearchWorkspaceFilesInput,
	validateWorkspaceEditState,
	validateWorkspaceMutationInput,
	validateWorkspaceReviewFileInput,
	validateWorkspaceReviewInput,
	validateWriteClipboardTextInput,
	validateWriteTerminalInput,
	validateWriteWorkspaceFileInput,
} from "../shared/desktop-api.ts";
import { type BrowserManager, BrowserToolError } from "./browser-manager.ts";
import { deliveredPreviewDirectories, readDeliveredPreviewBytes } from "./preview-file-reader.ts";
import type { TerminalManager } from "./terminal-manager.ts";
import type { WorkspaceFileManager } from "./workspace-file-manager.ts";

interface BrokerSupervisor {
	view(): SupervisorView;
	onState(listener: (view: SupervisorView) => void): () => void;
	onMessage(listener: (message: unknown) => void): () => void;
	request(request: ClientRpcRequest): Promise<ClientRpcSuccessResponse | RpcErrorResponse>;
	retry(): Promise<SupervisorView>;
	respondToServerRequest(request: ServerRpcRequest, response: ServerRpcSuccessResponse | RpcErrorResponse): void;
}

interface BrokerUpdater {
	view(): DesktopUpdateState;
	downloadAndOpen(): Promise<void>;
}

interface ClientBrokerOptions {
	readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	readonly supervisor: BrokerSupervisor;
	readonly selectProjectFolder?: () => Promise<string | null>;
	readonly selectAttachmentFiles?: () => Promise<DesktopAttachmentSelection[]>;
	readonly getDefaultProjectLocation?: () => Promise<string>;
	readonly createProjectFolder?: (input: DesktopCreateProjectFolderInput) => Promise<string>;
	readonly setScheduleKeepAwake?: (enabled: boolean) => Promise<void> | void;
	readonly openPath?: (path: string) => Promise<string>;
	readonly updater?: BrokerUpdater;
	readonly terminalManager?: Pick<TerminalManager, "create" | "write" | "resize" | "close" | "closeAll" | "onEvent">;
	readonly browserManager?: Pick<
		BrowserManager,
		| "attach"
		| "suspendRenderer"
		| "create"
		| "capturePreview"
		| "control"
		| "close"
		| "closeAll"
		| "getDownloadDirectory"
		| "openDownloadDirectory"
		| "listDownloads"
		| "controlDownload"
		| "listProfiles"
		| "listImportSources"
		| "importData"
		| "listHistory"
		| "clearHistory"
		| "onEvent"
		| "executeTool"
		| "takeControl"
		| "resolveHandoff"
		| "cancelSessionHandoffs"
		| "replayEvents"
	>;
	readonly workspaceFiles?: Pick<
		WorkspaceFileManager,
		| "authorize"
		| "revoke"
		| "clear"
		| "listDirectory"
		| "search"
		| "readFile"
		| "readPreviewBytes"
		| "writeFile"
		| "openFile"
		| "mutateEntry"
		| "getReview"
		| "getReviewFileDiff"
		| "getReviewFileContext"
	>;
	readonly writeClipboardText?: (text: string) => void;
	readonly setWorkspaceEditState?: (state: DesktopWorkspaceEditState) => void;
	readonly onSessionUpdated?: (session: SessionSummary) => void;
	readonly onSessionDeleted?: (sessionId: string) => void;
	readonly onProjectDeleted?: (mode: SessionSummary["mode"], cwd: string) => void;
	readonly onUserInterruptPending?: (sessionId: string, pending: boolean) => void;
	readonly onSessionOpened?: (sessionId: string) => void;
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

interface PendingInteraction {
	readonly request: ServerRpcRequest<"interaction/request">;
	readonly timer?: ReturnType<typeof setTimeout>;
}

interface PendingBrowserCall {
	readonly request: ServerRpcRequest<"browser/tool">;
	readonly abort: AbortController;
}

export function isTrustedRendererUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "app:" &&
			url.hostname === "renderer" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/index.html" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

function rpcFailure(response: RpcErrorResponse): Error {
	const error = new Error(response.error.message);
	error.name = "MetisRpcError";
	Object.defineProperty(error, "code", { value: response.error.code, enumerable: true });
	return error;
}

const DELIVERED_FILE_ID_PATTERN = /^[a-f0-9]{16}$/iu;

const DELIVERED_MIME_MAP: Record<string, string> = {
	pdf: "application/pdf",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	csv: "text/csv",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	ppt: "application/vnd.ms-powerpoint",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
};

async function readDeliveredFileDirect(sessionId: string, fileId: string) {
	if (!DELIVERED_FILE_ID_PATTERN.test(fileId)) return null;
	const candidateDirs = [
		process.env.METIS_AGENT_DIR ? join(process.env.METIS_AGENT_DIR, "attachments", sessionId, "delivered") : null,
		join(homedir(), ".metis", "agent", "attachments", sessionId, "delivered"),
		join(homedir(), ".metis", "attachments", sessionId, "delivered"),
		join(homedir(), ".metis", "agent", "attachments", sessionId),
		join(homedir(), ".metis", "attachments", sessionId),
	].filter((d): d is string => d !== null);

	for (const dir of candidateDirs) {
		try {
			const names = await readdir(dir);
			const match = names.find((name) => name.startsWith(fileId));
			if (!match) continue;
			const fullPath = join(dir, match);
			const metadata = await stat(fullPath);
			if (!metadata.isFile()) continue;
			const contents = await readFile(fullPath);
			const ext = extname(fullPath).replace(/^\./u, "").toLowerCase();
			const mediaType = DELIVERED_MIME_MAP[ext] || "application/octet-stream";
			return {
				fileId,
				name: basename(fullPath),
				byteLength: metadata.size,
				data: contents.toString("base64"),
				mediaType,
				absolutePath: fullPath,
			};
		} catch {
			// Continue to next candidate directory
		}
	}
	return null;
}

/** Owns the single narrow, validated renderer-to-app-server capability surface. */
export class ClientBroker {
	private readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	private readonly supervisor: BrokerSupervisor;
	private readonly selectProjectFolder: () => Promise<string | null>;
	private readonly selectAttachmentFiles: () => Promise<DesktopAttachmentSelection[]>;
	private readonly getDefaultProjectLocation: () => Promise<string>;
	private readonly createProjectFolder: (input: DesktopCreateProjectFolderInput) => Promise<string>;
	private readonly setScheduleKeepAwake: (enabled: boolean) => Promise<void> | void;
	private readonly openPath: (path: string) => Promise<string>;
	private readonly updater: BrokerUpdater;
	private readonly terminalManager: Pick<
		TerminalManager,
		"create" | "write" | "resize" | "close" | "closeAll" | "onEvent"
	>;
	private readonly browserManager: Pick<
		BrowserManager,
		| "attach"
		| "suspendRenderer"
		| "create"
		| "capturePreview"
		| "control"
		| "close"
		| "closeAll"
		| "getDownloadDirectory"
		| "openDownloadDirectory"
		| "listDownloads"
		| "controlDownload"
		| "listProfiles"
		| "listImportSources"
		| "importData"
		| "listHistory"
		| "clearHistory"
		| "onEvent"
		| "executeTool"
		| "takeControl"
		| "resolveHandoff"
		| "cancelSessionHandoffs"
		| "replayEvents"
	>;
	private readonly workspaceFiles: Pick<
		WorkspaceFileManager,
		| "authorize"
		| "revoke"
		| "clear"
		| "listDirectory"
		| "search"
		| "readFile"
		| "readPreviewBytes"
		| "writeFile"
		| "openFile"
		| "mutateEntry"
		| "getReview"
		| "getReviewFileDiff"
		| "getReviewFileContext"
	>;
	private readonly writeClipboardText: (text: string) => void;
	private readonly setWorkspaceEditState: (state: DesktopWorkspaceEditState) => void;
	private readonly onSessionUpdated?: (session: SessionSummary) => void;
	private readonly onSessionDeleted?: (sessionId: string) => void;
	private readonly onProjectDeleted?: (mode: SessionSummary["mode"], cwd: string) => void;
	private readonly onUserInterruptPending?: (sessionId: string, pending: boolean) => void;
	private readonly onSessionOpened?: (sessionId: string) => void;
	private pendingRendererOpenSession?: Extract<DesktopApiEvent, { type: "open-session" }>;
	private readonly pendingInteractions = new Map<string, PendingInteraction>();
	private readonly pendingBrowserCalls = new Map<string, PendingBrowserCall>();
	private readonly subscribedSessions = new Set<string>();
	private readonly subscribedSessionScopes = new Map<string, { readonly mode: string; readonly cwd?: string }>();
	private scheduleSubscribed = false;
	private subscriptionMutation = Promise.resolve();
	private readonly removeSupervisorListeners: readonly (() => void)[];
	private readonly removeTerminalListener: () => void;
	private readonly removeBrowserListener: () => void;
	private owner?: WebContents;
	private ownerSubscribed = false;
	private ownerCleanup: readonly (() => void)[] = [];
	private disposed = false;

	constructor(options: ClientBrokerOptions) {
		this.ipcMain = options.ipcMain;
		this.supervisor = options.supervisor;
		this.selectProjectFolder = options.selectProjectFolder ?? (async () => null);
		this.selectAttachmentFiles = options.selectAttachmentFiles ?? (async () => []);
		this.getDefaultProjectLocation = options.getDefaultProjectLocation ?? (async () => "");
		this.createProjectFolder =
			options.createProjectFolder ??
			(async () => {
				throw new Error("Project folder creation is unavailable");
			});
		this.setScheduleKeepAwake = options.setScheduleKeepAwake ?? (() => undefined);
		this.openPath = options.openPath ?? (async () => "Skill folder opening is unavailable");
		this.updater = options.updater ?? {
			view: () => ({ status: "unavailable" }),
			downloadAndOpen: async () => {
				throw new Error("Desktop updates are unavailable");
			},
		};
		this.terminalManager = options.terminalManager ?? {
			create: async () => {
				throw new Error("Terminal is unavailable");
			},
			write: () => {
				throw new Error("Terminal is unavailable");
			},
			resize: () => {
				throw new Error("Terminal is unavailable");
			},
			close: () => undefined,
			closeAll: () => undefined,
			onEvent: () => () => undefined,
		};
		this.browserManager = options.browserManager ?? {
			attach: () => undefined,
			suspendRenderer: () => undefined,
			create: () => {
				throw new Error("Browser is unavailable");
			},
			capturePreview: async () => {
				throw new Error("Browser is unavailable");
			},
			control: async () => {
				throw new Error("Browser is unavailable");
			},
			close: () => undefined,
			closeAll: () => undefined,
			getDownloadDirectory: () => {
				throw new Error("Browser is unavailable");
			},
			openDownloadDirectory: async () => {
				throw new Error("Browser is unavailable");
			},
			listDownloads: () => [],
			controlDownload: async () => {
				throw new Error("Browser is unavailable");
			},
			listProfiles: () => [
				{
					profileId: DEFAULT_BROWSER_PROFILE_ID,
					name: "Default",
					sourceId: null,
					sourceProfileId: null,
				},
			],
			listImportSources: async () => [],
			importData: async () => {
				throw new Error("Browser import is unavailable");
			},
			listHistory: () => [],
			clearHistory: async () => undefined,
			onEvent: () => () => undefined,
			executeTool: async () => {
				throw new Error("Browser is unavailable");
			},
			takeControl: () => {
				throw new Error("Browser is unavailable");
			},
			resolveHandoff: () => {
				throw new Error("Browser is unavailable");
			},
			cancelSessionHandoffs: () => undefined,
			replayEvents: () => [],
		};
		this.workspaceFiles = options.workspaceFiles ?? {
			authorize: () => undefined,
			revoke: () => undefined,
			clear: () => undefined,
			listDirectory: async () => {
				throw new Error("Workspace files are unavailable");
			},
			search: async () => {
				throw new Error("Workspace files are unavailable");
			},
			readFile: async () => {
				throw new Error("Workspace files are unavailable");
			},
			readPreviewBytes: async () => {
				throw new Error("Workspace files are unavailable");
			},
			writeFile: async () => {
				throw new Error("Workspace files are unavailable");
			},
			openFile: async () => {
				throw new Error("Workspace files are unavailable");
			},
			mutateEntry: async () => {
				throw new Error("Workspace files are unavailable");
			},
			getReview: async () => {
				throw new Error("Workspace files are unavailable");
			},
			getReviewFileDiff: async () => {
				throw new Error("Workspace files are unavailable");
			},
			getReviewFileContext: async () => {
				throw new Error("Workspace files are unavailable");
			},
		};
		this.writeClipboardText = options.writeClipboardText ?? (() => undefined);
		this.setWorkspaceEditState = options.setWorkspaceEditState ?? (() => undefined);
		this.onSessionUpdated = options.onSessionUpdated;
		this.onSessionDeleted = options.onSessionDeleted;
		this.onProjectDeleted = options.onProjectDeleted;
		this.onUserInterruptPending = options.onUserInterruptPending;
		this.onSessionOpened = options.onSessionOpened;
		this.registerHandlers();
		this.removeTerminalListener = this.terminalManager.onEvent((event) => this.sendTerminalEvent(event));
		this.removeBrowserListener = this.browserManager.onEvent((event) => this.sendBrowserEvent(event));
		this.removeSupervisorListeners = [
			this.supervisor.onState((view) => {
				if (view.state !== "ready") {
					this.cancelPendingBrowserCalls();
					this.dropPendingInteractions();
					this.subscribedSessions.clear();
					this.subscribedSessionScopes.clear();
					this.scheduleSubscribed = false;
					this.workspaceFiles.clear();
				}
				this.sendEvent({ type: "supervisor", view });
			}),
			this.supervisor.onMessage((message) => this.handleServerMessage(message)),
		];
	}

	attach(
		window: Pick<BrowserWindow, "webContents"> & Partial<Pick<BrowserWindow, "contentView" | "getBounds">>,
	): void {
		if (this.disposed) throw new Error("Desktop client broker is disposed");
		this.detachOwner();
		const owner = window.webContents;
		this.owner = owner;
		this.ownerSubscribed = false;
		if (window.contentView && window.getBounds) {
			this.browserManager.attach(window as Pick<BrowserWindow, "contentView" | "getBounds">);
		}

		const onDestroyed = () => {
			if (this.owner === owner) this.detachOwner();
		};
		const onRenderProcessGone = () => {
			if (this.owner === owner) this.detachOwner();
		};
		const onDidStartNavigation = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
			if (this.owner !== owner || !isMainFrame) return;
			this.ownerSubscribed = false;
			this.terminalManager.closeAll();
			this.cancelPendingBrowserCalls("tab_closed");
			this.browserManager.suspendRenderer();
			this.workspaceFiles.clear();
			this.cancelPendingInteractions();
			this.releaseSessionSubscriptions();
		};

		owner.on("destroyed", onDestroyed);
		owner.on("render-process-gone", onRenderProcessGone);
		owner.on("did-start-navigation", onDidStartNavigation);
		this.ownerCleanup = [
			() => owner.off("destroyed", onDestroyed),
			() => owner.off("render-process-gone", onRenderProcessGone),
			() => owner.off("did-start-navigation", onDidStartNavigation),
		];
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachOwner();
		this.removeTerminalListener();
		this.removeBrowserListener();
		for (const remove of this.removeSupervisorListeners) remove();
		for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) this.ipcMain.removeHandler(channel);
	}

	requestRendererOpenSession(sessionId: string, mode: "chat" | "code"): boolean {
		const event = { type: "open-session", sessionId, mode } as const;
		this.pendingRendererOpenSession = undefined;
		if (this.sendEvent(event)) return true;
		this.pendingRendererOpenSession = event;
		return false;
	}

	private registerHandlers(): void {
		this.registerAppServerForwarders();
		this.register(DESKTOP_IPC_CHANNELS.openSkillFolder, 1, async (_event, [input]) => {
			const detail = await this.clientCall("skill/get", input);
			const error = await this.openPath(detail.directoryPath);
			if (error) throw new Error(error);
		});
		this.register(DESKTOP_IPC_CHANNELS.subscribeSchedule, 1, async (_event, [input]) =>
			this.enqueueSubscriptionMutation(async () => {
				const result = await this.clientCall("schedule/subscribe", input);
				this.scheduleSubscribed = true;
				return result;
			}),
		);
		this.register(DESKTOP_IPC_CHANNELS.unsubscribeSchedule, 1, async (_event, [input]) =>
			this.enqueueSubscriptionMutation(async () => {
				const result = await this.clientCall("schedule/unsubscribe", input);
				this.scheduleSubscribed = false;
				return result;
			}),
		);
		this.register(DESKTOP_IPC_CHANNELS.setScheduleKeepAwake, 1, async (_event, [enabled]) => {
			if (typeof enabled !== "boolean") throw new TypeError("Keep Awake state must be a boolean");
			await this.setScheduleKeepAwake(enabled);
		});
		this.register(DESKTOP_IPC_CHANNELS.previewProjectDelete, 1, async (_event, [input]) =>
			this.projectCall("project/deletePreview", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.deleteProject, 1, async (_event, [input]) => {
			const params = this.validatedParams("project/delete", input);
			return this.enqueueSubscriptionMutation(async () => {
				const outcome = await this.projectCall("project/delete", params);
				if (!outcome.ok) return outcome;
				const deletedSessionIds = [...this.subscribedSessionScopes]
					.filter(([, scope]) => scope.mode === params.mode && scope.cwd === params.cwd)
					.map(([sessionId]) => sessionId);
				this.forgetSessions(deletedSessionIds);
				return outcome;
			});
		});
		this.register(DESKTOP_IPC_CHANNELS.deleteSession, 1, async (_event, [input]) => {
			const params = this.validatedParams("session/delete", input);
			return this.enqueueSubscriptionMutation(async () => {
				const result = await this.clientCall("session/delete", params);
				this.forgetSessions([params.sessionId]);
				return result;
			});
		});
		this.register(DESKTOP_IPC_CHANNELS.openSession, 1, async (_event, [input]) => {
			const params = this.validatedParams("session/open", input);
			return this.enqueueSubscriptionMutation(async () => {
				const previousSessionIds = [...this.subscribedSessions].filter(
					(sessionId) => sessionId !== params.sessionId,
				);
				await this.clientCall("session/open", params);
				const subscribed = await this.clientCall("session/subscribe", { sessionId: params.sessionId });
				this.subscribedSessions.add(params.sessionId);
				const session = subscribed.snapshot.session;
				this.subscribedSessionScopes.set(session.sessionId, {
					mode: session.mode,
					...(session.cwd ? { cwd: session.cwd } : {}),
				});
				if (session.mode === "code" && session.cwd) this.workspaceFiles.authorize(session.sessionId, session.cwd);
				else this.workspaceFiles.revoke(params.sessionId);
				for (const previousSessionId of previousSessionIds) this.workspaceFiles.revoke(previousSessionId);
				const previousSessions = new Set(previousSessionIds);
				this.cancelPendingInteractionsForSessions(previousSessions);
				await this.unsubscribeSessions(previousSessionIds, true);
				// A request can cross the process boundary while unsubscribe is in flight.
				this.cancelPendingInteractionsForSessions(previousSessions);
				for (const event of this.browserManager.replayEvents(params.sessionId)) this.sendBrowserEvent(event);
				this.onSessionOpened?.(params.sessionId);
				return subscribed.snapshot;
			});
		});
		this.register(DESKTOP_IPC_CHANNELS.readDeliveredFile, 1, async (_event, [input]) => {
			const params = input as ClientParams<"session/readDeliveredFile">;
			const direct = await readDeliveredFileDirect(params.sessionId, params.fileId);
			if (direct) return direct;
			return this.clientCall("session/readDeliveredFile", params);
		});
		this.register(DESKTOP_IPC_CHANNELS.readPreviewFile, 1, async (_event, [input]) => {
			const params = validateReadPreviewFileInput(input);
			if (params.source === "workspace") return this.workspaceFiles.readPreviewBytes(params);
			for (const directory of deliveredPreviewDirectories(params.sessionId)) {
				const result = await readDeliveredPreviewBytes(directory, params.fileId);
				if (result.ok || result.reason === "too-large") return result;
			}
			return { ok: false, reason: "not-found" };
		});
		this.register(DESKTOP_IPC_CHANNELS.interruptTurn, 1, async (_event, [input]) => {
			const params = this.validatedParams("turn/interrupt", input);
			this.onUserInterruptPending?.(params.sessionId, true);
			try {
				return await this.clientCall("turn/interrupt", params);
			} catch (cause) {
				this.onUserInterruptPending?.(params.sessionId, false);
				throw cause;
			}
		});
		this.register(DESKTOP_IPC_CHANNELS.respondToInteraction, 1, async (_event, [input]) => {
			this.respondToInteraction(input);
		});
		this.register(DESKTOP_IPC_CHANNELS.selectProjectFolder, 0, async () => this.selectProjectFolder());
		this.register(DESKTOP_IPC_CHANNELS.selectAttachmentFiles, 0, async () => this.selectAttachmentFiles());
		this.register(DESKTOP_IPC_CHANNELS.getDefaultProjectLocation, 0, async () => this.getDefaultProjectLocation());
		this.register(DESKTOP_IPC_CHANNELS.createProjectFolder, 1, async (_event, [input]) =>
			this.createProjectFolder(input as DesktopCreateProjectFolderInput),
		);
		this.register(DESKTOP_IPC_CHANNELS.getServerState, 0, async () => this.supervisor.view());
		this.register(DESKTOP_IPC_CHANNELS.retryServer, 0, async () => {
			await this.supervisor.retry();
		});
		this.register(DESKTOP_IPC_CHANNELS.getUpdateState, 0, async () => this.updater.view());
		this.register(DESKTOP_IPC_CHANNELS.startUpdate, 0, async () => {
			await this.updater.downloadAndOpen();
		});
		this.register(DESKTOP_IPC_CHANNELS.subscribe, 0, async () => {
			this.ownerSubscribed = true;
			this.sendEvent({ type: "supervisor", view: this.supervisor.view() });
			const pending = this.pendingRendererOpenSession;
			if (pending && this.sendEvent(pending)) this.pendingRendererOpenSession = undefined;
		});
		this.register(DESKTOP_IPC_CHANNELS.createTerminal, 1, async (_event, [input]) =>
			this.terminalManager.create(validateCreateTerminalInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.writeTerminal, 1, async (_event, [input]) => {
			this.terminalManager.write(validateWriteTerminalInput(input));
		});
		this.register(DESKTOP_IPC_CHANNELS.resizeTerminal, 1, async (_event, [input]) => {
			this.terminalManager.resize(validateResizeTerminalInput(input));
		});
		this.register(DESKTOP_IPC_CHANNELS.closeTerminal, 1, async (_event, [input]) => {
			this.terminalManager.close(validateCloseTerminalInput(input).terminalId);
		});
		this.register(DESKTOP_IPC_CHANNELS.createBrowser, 1, async (_event, [input]) =>
			this.browserManager.create(validateCreateBrowserInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.captureBrowserPreview, 1, async (_event, [input]) => {
			const target = validateCloseBrowserInput(input);
			return this.browserManager.capturePreview(target.sessionId, target.browserId);
		});
		this.register(DESKTOP_IPC_CHANNELS.controlBrowser, 1, async (_event, [input]) => {
			await this.browserManager.control(validateBrowserControlInput(input));
		});
		this.register(DESKTOP_IPC_CHANNELS.listBrowserDownloads, 0, async () => this.browserManager.listDownloads());
		this.register(DESKTOP_IPC_CHANNELS.controlBrowserDownload, 1, async (_event, [input]) => {
			await this.browserManager.controlDownload(validateBrowserDownloadControlInput(input));
		});
		this.register(DESKTOP_IPC_CHANNELS.getBrowserDownloadDirectory, 0, async () =>
			this.browserManager.getDownloadDirectory(),
		);
		this.register(DESKTOP_IPC_CHANNELS.openBrowserDownloadDirectory, 0, async () => {
			await this.browserManager.openDownloadDirectory();
		});
		this.register(DESKTOP_IPC_CHANNELS.listBrowserProfiles, 0, async () => this.browserManager.listProfiles());
		this.register(DESKTOP_IPC_CHANNELS.listBrowserImportSources, 0, async () =>
			this.browserManager.listImportSources(),
		);
		this.register(DESKTOP_IPC_CHANNELS.importBrowserData, 1, async (_event, [input]) =>
			this.browserManager.importData(validateBrowserImportInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.listBrowserHistory, 1, async (_event, [input]) =>
			this.browserManager.listHistory(validateListBrowserHistoryInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.clearBrowserHistory, 1, async (_event, [input]) =>
			this.browserManager.clearHistory(validateListBrowserHistoryInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.closeBrowser, 1, async (_event, [input]) => {
			const target = validateCloseBrowserInput(input);
			this.browserManager.close(target.sessionId, target.browserId);
		});
		this.register(DESKTOP_IPC_CHANNELS.takeBrowserControl, 1, async (_event, [input]) => {
			const target = validateCloseBrowserInput(input);
			this.browserManager.takeControl(target.sessionId, target.browserId);
		});
		this.register(DESKTOP_IPC_CHANNELS.resolveBrowserHandoff, 1, async (_event, [input]) => {
			const target = validateResolveBrowserHandoffInput(input);
			this.browserManager.resolveHandoff(target.sessionId, target.browserId, target.decision);
		});
		this.register(DESKTOP_IPC_CHANNELS.listWorkspaceDirectory, 1, async (_event, [input]) =>
			this.workspaceFiles.listDirectory(validateListWorkspaceDirectoryInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.searchWorkspaceFiles, 1, async (_event, [input]) =>
			this.workspaceFiles.search(validateSearchWorkspaceFilesInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.readWorkspaceFile, 1, async (_event, [input]) =>
			this.workspaceFiles.readFile(validateReadWorkspaceFileInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.writeWorkspaceFile, 1, async (_event, [input]) =>
			this.workspaceFiles.writeFile(validateWriteWorkspaceFileInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.openWorkspaceFile, 1, async (_event, [input]) =>
			this.workspaceFiles.openFile(validateOpenWorkspaceFileInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.mutateWorkspaceEntry, 1, async (_event, [input]) =>
			this.workspaceFiles.mutateEntry(validateWorkspaceMutationInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.getWorkspaceReview, 1, async (_event, [input]) =>
			this.workspaceFiles.getReview(validateWorkspaceReviewInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileDiff, 1, async (_event, [input]) =>
			this.workspaceFiles.getReviewFileDiff(validateWorkspaceReviewFileInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileContext, 1, async (_event, [input]) =>
			this.workspaceFiles.getReviewFileContext(validateWorkspaceReviewFileInput(input)),
		);
		this.register(DESKTOP_IPC_CHANNELS.writeClipboardText, 1, async (_event, [input]) => {
			this.writeClipboardText(validateWriteClipboardTextInput(input).text);
		});
		this.register(DESKTOP_IPC_CHANNELS.setWorkspaceEditState, 1, async (_event, [input]) => {
			this.setWorkspaceEditState(validateWorkspaceEditState(input));
		});
	}

	private registerAppServerForwarders(): void {
		for (const definition of Object.values(DESKTOP_RPC_FORWARDING)) {
			this.register(definition.channel, 1, async (_event, [input]) => this.clientCall(definition.method, input));
		}
	}

	private register(
		channel: string,
		argumentCount: number,
		handler: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<unknown>,
	): void {
		const guarded: InvokeHandler = async (event, ...args) => {
			this.assertTrustedSender(event);
			if (args.length !== argumentCount) throw new TypeError("Invalid desktop IPC arguments");
			return await handler(event, args);
		};
		this.ipcMain.handle(channel, guarded);
	}

	private assertTrustedSender(event: IpcMainInvokeEvent): void {
		if (
			!this.owner ||
			this.owner.isDestroyed() ||
			event.sender !== this.owner ||
			event.senderFrame !== this.owner.mainFrame ||
			!isTrustedRendererUrl(event.senderFrame.url)
		) {
			throw new Error("Untrusted desktop IPC sender");
		}
	}

	private validatedParams<Method extends Exclude<ClientRpcRequest["method"], "initialize">>(
		method: Method,
		params: unknown,
	): ClientParams<Method> {
		const request = validateClientRequest({ jsonrpc: "2.0", id: randomUUID(), method, params });
		return request.params as ClientParams<Method>;
	}

	private async clientCall<Method extends Exclude<ClientRpcRequest["method"], "initialize">>(
		method: Method,
		paramsValue: unknown,
	): Promise<ClientResult<Method>> {
		const params = this.validatedParams(method, paramsValue);
		const request = validateClientRequest({ jsonrpc: "2.0", id: randomUUID(), method, params });
		const response = await this.supervisor.request(request);
		if ("error" in response) throw rpcFailure(response);
		return response.result as ClientResult<Method>;
	}

	private async projectCall<Method extends "project/deletePreview" | "project/delete">(
		method: Method,
		params: unknown,
	): Promise<DesktopRpcOutcome<ClientResult<Method>>> {
		try {
			return { ok: true, result: await this.clientCall(method, params) };
		} catch (cause) {
			if (
				cause instanceof Error &&
				cause.name === "MetisRpcError" &&
				typeof (cause as Error & { code?: unknown }).code === "number"
			) {
				return {
					ok: false,
					error: { code: (cause as Error & { code: number }).code, message: cause.message },
				};
			}
			throw cause;
		}
	}

	private handleServerMessage(value: unknown): void {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("Invalid app-server message");
		if (Object.hasOwn(value, "id")) {
			const request = validateServerRequest(value);
			const view = this.supervisor.view();
			if (view.state !== "ready" || request.params.serverEpoch !== view.serverEpoch) return;
			if (request.method === "browser/tool") {
				this.startBrowserCall(request as ServerRpcRequest<"browser/tool">);
				return;
			}
			const interactionRequest = request as ServerRpcRequest<"interaction/request">;
			if (this.pendingInteractions.has(interactionRequest.params.interaction.interactionId)) {
				throw new Error("App-server reused a pending interaction id");
			}
			const interaction = interactionRequest.params.interaction;
			const expiresAt = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
			const delay = expiresAt - Date.now();
			const timer = Number.isFinite(delay)
				? setTimeout(() => this.expireInteraction(interaction.interactionId), Math.max(0, delay))
				: undefined;
			timer?.unref?.();
			this.pendingInteractions.set(interaction.interactionId, {
				request: interactionRequest,
				...(timer ? { timer } : {}),
			});
			if (!this.sendEvent({ type: "app-server", envelope: interactionRequest })) this.cancelPendingInteractions();
			return;
		}
		const notification = validateServerNotification(value);
		const view = this.supervisor.view();
		if (view.state !== "ready" || notification.params.serverEpoch !== view.serverEpoch) return;
		if (notification.method === "browser/tool/cancelled") {
			const pending = this.pendingBrowserCalls.get(notification.params.requestId);
			if (
				pending &&
				pending.request.params.serverEpoch === notification.params.serverEpoch &&
				pending.request.params.sessionId === notification.params.sessionId &&
				pending.request.params.toolCallId === notification.params.toolCallId
			) {
				pending.abort.abort();
				this.pendingBrowserCalls.delete(notification.params.requestId);
			}
			return;
		}
		if (notification.method !== "connection/events") return;
		for (const event of notification.params.events) {
			if (event.type === "session/updated") this.onSessionUpdated?.(event.session);
			else if (event.type === "session/invalidated" && event.reason === "deleted") {
				this.onSessionDeleted?.(event.sessionId);
			} else if (event.type === "project/invalidated" && event.reason === "deleted") {
				this.onProjectDeleted?.(event.mode, event.cwd);
			}
		}
		this.sendEvent({ type: "app-server", envelope: notification });
		void this.clientCall("connection/ack", {
			serverEpoch: notification.params.serverEpoch,
			cursor: notification.params.toCursor,
		}).catch(() => undefined);
	}

	private startBrowserCall(request: ServerRpcRequest<"browser/tool">): void {
		if (this.pendingBrowserCalls.has(request.id)) throw new Error("App-server reused a pending browser request id");
		const owner = this.owner;
		if (!owner || owner.isDestroyed()) {
			this.supervisor.respondToServerRequest(request, {
				jsonrpc: "2.0",
				id: request.id,
				error: createRpcError("OPERATION_FAILED", { sessionId: request.params.sessionId }),
			});
			return;
		}
		const abort = new AbortController();
		const pending = { request, abort };
		this.pendingBrowserCalls.set(request.id, pending);
		void this.browserManager
			.executeTool(request.params.sessionId, request.params.call, abort.signal)
			.then((result) => {
				if (this.pendingBrowserCalls.get(request.id) !== pending) return;
				const view = this.supervisor.view();
				if (view.state !== "ready" || view.serverEpoch !== request.params.serverEpoch) return;
				this.supervisor.respondToServerRequest(request, {
					jsonrpc: "2.0",
					id: request.id,
					result: { toolCallId: request.params.toolCallId, result },
				});
			})
			.catch((cause) => {
				if (this.pendingBrowserCalls.get(request.id) !== pending) return;
				const view = this.supervisor.view();
				if (view.state !== "ready" || view.serverEpoch !== request.params.serverEpoch) return;
				this.supervisor.respondToServerRequest(request, {
					jsonrpc: "2.0",
					id: request.id,
					error: createRpcError(cause instanceof BrowserToolError ? cause.rpcErrorName : "OPERATION_FAILED", {
						sessionId: request.params.sessionId,
					}),
				});
			})
			.finally(() => {
				if (this.pendingBrowserCalls.get(request.id) === pending) this.pendingBrowserCalls.delete(request.id);
			});
	}

	private respondToInteraction(value: unknown): void {
		const input: InteractionResponseInput = validateInteractionResponseInput(value);
		const pending = this.pendingInteractions.get(input.interactionId);
		if (!pending) throw new Error("Interaction is no longer pending");
		const response: ServerRpcSuccessResponse = { jsonrpc: "2.0", id: pending.request.id, result: input };
		this.supervisor.respondToServerRequest(pending.request, response);
		if (pending.timer) clearTimeout(pending.timer);
		this.pendingInteractions.delete(input.interactionId);
	}

	private sendEvent(event: DesktopApiEvent): boolean {
		const owner = this.owner;
		if (!owner || !this.ownerSubscribed || owner.isDestroyed()) return false;
		try {
			owner.send(DESKTOP_EVENT_CHANNEL, structuredClone(event));
			return true;
		} catch {
			this.ownerSubscribed = false;
			return false;
		}
	}

	private sendTerminalEvent(event: DesktopTerminalEvent): void {
		const owner = this.owner;
		if (!owner || owner.isDestroyed()) return;
		try {
			owner.send(DESKTOP_TERMINAL_EVENT_CHANNEL, structuredClone(event));
		} catch {
			this.terminalManager.closeAll();
		}
	}

	private sendBrowserEvent(event: DesktopBrowserEvent): void {
		if (event.type === "closed") this.cancelBrowserCallsForTab(event.sessionId, event.browserId);
		const owner = this.owner;
		if (!owner || owner.isDestroyed()) return;
		try {
			owner.send(DESKTOP_BROWSER_EVENT_CHANNEL, structuredClone(event));
		} catch {
			this.cancelPendingBrowserCalls("tab_closed");
			this.browserManager.suspendRenderer();
		}
	}

	private cancelBrowserCallsForTab(sessionId: string, browserId: string): void {
		for (const pending of this.pendingBrowserCalls.values()) {
			if (pending.request.params.sessionId !== sessionId) continue;
			const call = pending.request.params.call;
			const targetsBrowser =
				(call.tool === "browser_tabs" && call.input.action === "close" && call.input.browserId === browserId) ||
				(call.tool !== "browser_tabs" && call.input.browserId === browserId);
			const isClosingCall = call.tool === "browser_tabs" && call.input.action === "close";
			if (!targetsBrowser || isClosingCall) continue;
			pending.abort.abort();
		}
	}

	private cancelPendingBrowserCalls(reason: "server_restarted" | "tab_closed" = "server_restarted"): void {
		const sessionIds = new Set([...this.pendingBrowserCalls.values()].map(({ request }) => request.params.sessionId));
		for (const sessionId of sessionIds) this.browserManager.cancelSessionHandoffs(sessionId, reason);
		const pending = [...this.pendingBrowserCalls.values()];
		if (reason === "server_restarted") this.pendingBrowserCalls.clear();
		for (const call of pending) call.abort.abort();
	}

	private cancelPendingInteractions(): void {
		const pendingInteractions = [...this.pendingInteractions.values()];
		this.pendingInteractions.clear();
		for (const pending of pendingInteractions) {
			if (pending.timer) clearTimeout(pending.timer);
			this.cancelServerInteraction(pending.request);
		}
	}

	private cancelPendingInteractionsForSessions(sessionIds: ReadonlySet<string>): void {
		for (const [interactionId, pending] of this.pendingInteractions) {
			if (!sessionIds.has(pending.request.params.interaction.sessionId)) continue;
			this.pendingInteractions.delete(interactionId);
			if (pending.timer) clearTimeout(pending.timer);
			this.cancelServerInteraction(pending.request);
		}
	}

	private dropPendingInteractions(): void {
		for (const pending of this.pendingInteractions.values()) {
			if (pending.timer) clearTimeout(pending.timer);
		}
		this.pendingInteractions.clear();
	}

	private expireInteraction(interactionId: string): void {
		const pending = this.pendingInteractions.get(interactionId);
		if (!pending) return;
		this.pendingInteractions.delete(interactionId);
		this.cancelServerInteraction(pending.request);
		this.sendEvent({ type: "interaction-cancelled", interactionId });
	}

	private cancelServerInteraction(request: ServerRpcRequest<"interaction/request">): void {
		const interaction = request.params.interaction;
		const response: RpcErrorResponse = {
			jsonrpc: "2.0",
			id: request.id,
			error: createRpcError("INTERACTION_CANCELLED", {
				interactionId: interaction.interactionId,
				sessionId: interaction.sessionId,
			}),
		};
		try {
			this.supervisor.respondToServerRequest(request, response);
		} catch {
			// A lost app-server has no interaction left to cancel.
		}
	}

	private detachOwner(): void {
		for (const cleanup of this.ownerCleanup) cleanup();
		this.ownerCleanup = [];
		this.owner = undefined;
		this.ownerSubscribed = false;
		this.terminalManager.closeAll();
		this.cancelPendingBrowserCalls("tab_closed");
		this.browserManager.closeAll();
		this.workspaceFiles.clear();
		this.cancelPendingInteractions();
		this.releaseSessionSubscriptions();
		this.setWorkspaceEditState({ dirty: false, language: "en", visibleSessionId: null });
	}

	private forgetSessions(sessionIds: readonly string[]): void {
		const ids = new Set(sessionIds);
		for (const sessionId of ids) {
			this.workspaceFiles.revoke(sessionId);
			this.subscribedSessions.delete(sessionId);
			this.subscribedSessionScopes.delete(sessionId);
		}
		this.cancelPendingBrowserCallsForSessions(ids);
		this.cancelPendingInteractionsForSessions(ids);
	}

	private cancelPendingBrowserCallsForSessions(sessionIds: ReadonlySet<string>): void {
		for (const sessionId of sessionIds) this.browserManager.cancelSessionHandoffs(sessionId, "tab_closed");
		for (const [requestId, pending] of this.pendingBrowserCalls) {
			if (!sessionIds.has(pending.request.params.sessionId)) continue;
			this.pendingBrowserCalls.delete(requestId);
			pending.abort.abort();
		}
	}

	private releaseSessionSubscriptions(): void {
		void this.enqueueSubscriptionMutation(async () => {
			await this.unsubscribeSessionSubscriptions(true);
			if (!this.scheduleSubscribed) return;
			try {
				await this.clientCall("schedule/unsubscribe", {});
				this.scheduleSubscribed = false;
			} catch {
				// App-server restarts clear the remote subscription.
			}
		});
	}

	private enqueueSubscriptionMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.subscriptionMutation.then(operation);
		this.subscriptionMutation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async unsubscribeSessionSubscriptions(ignoreErrors = false): Promise<void> {
		await this.unsubscribeSessions([...this.subscribedSessions], ignoreErrors);
	}

	private async unsubscribeSessions(sessionIds: readonly string[], ignoreErrors: boolean): Promise<void> {
		const errors: unknown[] = [];
		await Promise.all(
			sessionIds.map(async (sessionId) => {
				try {
					await this.clientCall("session/unsubscribe", { sessionId });
					this.subscribedSessions.delete(sessionId);
					this.subscribedSessionScopes.delete(sessionId);
				} catch (error) {
					// A later session switch or renderer teardown retries tracked cleanup.
					if (!ignoreErrors) errors.push(error);
				}
			}),
		);
		if (errors.length > 0) throw errors[0];
	}
}
