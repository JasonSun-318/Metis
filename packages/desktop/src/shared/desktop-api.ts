import {
	assertEnvelopeByteLimit,
	assertSchema,
	type ClientParams,
	type ClientRequestMethod,
	type ClientResult,
	compileSchema,
	type InteractionResponseInput,
	InteractionResultSchema,
	type ServerRpcNotification,
	type ServerRpcRequest,
	SessionIdSchema,
	UuidSchema,
	validateClientRequest,
	validateServerNotification,
	validateServerRequest,
} from "@metis/app-protocol";
import { DESKTOP_RPC_FORWARDING_CHANNELS, type DesktopRpcForwardingApi } from "./app-server-rpc-forwarding.ts";

export type SupervisorState = "stopped" | "starting" | "ready" | "restarting" | "failed" | "shuttingDown";

export interface SupervisorView {
	readonly state: SupervisorState;
	readonly serverEpoch: string | null;
	readonly restartAttempt: number;
	readonly failure: string | null;
}

/** Theme preference shared between the renderer and the main process. */
export type DesktopThemePreference = "dark" | "light" | "system";

/** Standalone IPC channel for theme preference (kept out of DESKTOP_IPC_CHANNELS). */
export const DESKTOP_THEME_CHANNEL = "metis:theme";

export type DesktopUpdateState =
	| { readonly status: "unavailable" | "checking" }
	| { readonly status: "available" | "ready"; readonly version: string }
	| { readonly status: "downloading"; readonly version: string; readonly progress: number };

export type DesktopApiEvent =
	| {
			readonly type: "app-server";
			readonly envelope: ServerRpcRequest<"interaction/request"> | ServerRpcNotification<"connection/events">;
	  }
	| { readonly type: "interaction-cancelled"; readonly interactionId: string }
	| { readonly type: "open-session"; readonly sessionId: string; readonly mode: "chat" | "code" }
	| { readonly type: "supervisor"; readonly view: SupervisorView };

export const DESKTOP_IPC_CHANNELS = {
	...DESKTOP_RPC_FORWARDING_CHANNELS,
	openSkillFolder: "metis:open-skill-folder",
	subscribeSchedule: "metis:subscribe-schedule",
	unsubscribeSchedule: "metis:unsubscribe-schedule",
	setScheduleKeepAwake: "metis:set-schedule-keep-awake",
	previewProjectDelete: "metis:preview-project-delete",
	deleteProject: "metis:delete-project",
	deleteSession: "metis:delete-session",
	openSession: "metis:open-session",
	readDeliveredFile: "metis:read-delivered-file",
	readPreviewFile: "metis:read-preview-file",
	interruptTurn: "metis:interrupt-turn",
	respondToInteraction: "metis:respond-to-interaction",
	selectProjectFolder: "metis:select-project-folder",
	selectAttachmentFiles: "metis:select-attachment-files",
	getDefaultProjectLocation: "metis:get-default-project-location",
	createProjectFolder: "metis:create-project-folder",
	getServerState: "metis:get-server-state",
	retryServer: "metis:retry-server",
	subscribe: "metis:subscribe",
	createTerminal: "metis:create-terminal",
	writeTerminal: "metis:write-terminal",
	resizeTerminal: "metis:resize-terminal",
	closeTerminal: "metis:close-terminal",
	createBrowser: "metis:create-browser",
	captureBrowserPreview: "metis:capture-browser-preview",
	controlBrowser: "metis:control-browser",
	closeBrowser: "metis:close-browser",
	takeBrowserControl: "metis:take-browser-control",
	resolveBrowserHandoff: "metis:resolve-browser-handoff",
	listBrowserDownloads: "metis:list-browser-downloads",
	controlBrowserDownload: "metis:control-browser-download",
	listBrowserProfiles: "metis:list-browser-profiles",
	listBrowserImportSources: "metis:list-browser-import-sources",
	importBrowserData: "metis:import-browser-data",
	listBrowserHistory: "metis:list-browser-history",
	clearBrowserHistory: "metis:clear-browser-history",
	listWorkspaceDirectory: "metis:list-workspace-directory",
	searchWorkspaceFiles: "metis:search-workspace-files",
	readWorkspaceFile: "metis:read-workspace-file",
	writeWorkspaceFile: "metis:write-workspace-file",
	openWorkspaceFile: "metis:open-workspace-file",
	mutateWorkspaceEntry: "metis:mutate-workspace-entry",
	getWorkspaceReview: "metis:get-workspace-review",
	getWorkspaceReviewFileDiff: "metis:get-workspace-review-file-diff",
	getWorkspaceReviewFileContext: "metis:get-workspace-review-file-context",
	writeClipboardText: "metis:write-clipboard-text",
	setWorkspaceEditState: "metis:set-workspace-edit-state",
	getUpdateState: "metis:get-update-state",
	startUpdate: "metis:start-update",
} as const;

export const DESKTOP_EVENT_CHANNEL = "metis:event";
export const DESKTOP_TERMINAL_EVENT_CHANNEL = "metis:terminal-event";
export const DESKTOP_BROWSER_EVENT_CHANNEL = "metis:browser-event";
export const DESKTOP_UPDATE_EVENT_CHANNEL = "metis:update-event";

export interface DesktopCreateTerminalInput {
	readonly terminalId: string;
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
}

export interface DesktopWriteTerminalInput {
	readonly terminalId: string;
	readonly data: string;
}

export interface DesktopResizeTerminalInput {
	readonly terminalId: string;
	readonly cols: number;
	readonly rows: number;
}

export interface DesktopCloseTerminalInput {
	readonly terminalId: string;
}

export interface DesktopTerminalInfo {
	readonly terminalId: string;
	readonly pid: number;
	readonly cwd: string;
	readonly shell: string;
}

export type DesktopTerminalEvent =
	| { readonly type: "data"; readonly terminalId: string; readonly data: string }
	| { readonly type: "exit"; readonly terminalId: string; readonly exitCode: number; readonly signal?: number };

export interface DesktopBrowserBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface DesktopCreateBrowserInput {
	readonly sessionId: string;
	readonly browserId: string;
	readonly profileId: string;
}

export interface DesktopCloseBrowserInput {
	readonly sessionId: string;
	readonly browserId: string;
}

export type DesktopBrowserCommand = "find" | "print" | "zoom-in" | "zoom-out" | "zoom-reset";

export interface DesktopBrowserState {
	readonly browserId: string;
	readonly profileId: string;
	readonly url: string;
	readonly title: string;
	readonly faviconUrl: string | null;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly zoomPercent: number;
}

export type DesktopBrowserControlInput =
	| { readonly type: "navigate"; readonly sessionId: string; readonly browserId: string; readonly url: string }
	| {
			readonly type: "find";
			readonly sessionId: string;
			readonly browserId: string;
			readonly text: string;
			readonly forward: boolean;
			readonly findNext: boolean;
	  }
	| {
			readonly type:
				| "back"
				| "forward"
				| "reload"
				| "open-external"
				| "stop-find"
				| "print"
				| "zoom-in"
				| "zoom-out"
				| "zoom-reset"
				| "capture-page"
				| "clear-data";
			readonly sessionId: string;
			readonly browserId: string;
	  }
	| {
			readonly type: "set-zoom";
			readonly sessionId: string;
			readonly browserId: string;
			readonly zoomPercent: number;
	  }
	| {
			readonly type: "present";
			readonly sessionId: string;
			readonly browserId: string;
			readonly visible: boolean;
			readonly bounds: DesktopBrowserBounds;
	  };

export type DesktopBrowserHandoffReason =
	| "login"
	| "otp"
	| "passkey"
	| "device_approval"
	| "captcha"
	| "sensitive_action"
	| "other";

export interface DesktopResolveBrowserHandoffInput extends DesktopCloseBrowserInput {
	readonly decision: "complete" | "cancel";
}

export type DesktopBrowserEvent =
	| { readonly type: "state"; readonly state: DesktopBrowserState }
	| { readonly type: "error"; readonly browserId: string; readonly message: string }
	| {
			readonly type: "find-result";
			readonly browserId: string;
			readonly activeMatchOrdinal: number;
			readonly matches: number;
	  }
	| { readonly type: "command"; readonly browserId: string; readonly command: DesktopBrowserCommand }
	| { readonly type: "downloads"; readonly downloads: readonly DesktopDownloadItem[] }
	| { readonly type: "history"; readonly profileId: string; readonly entries: readonly DesktopHistoryEntry[] }
	| { readonly type: "opened"; readonly sessionId: string; readonly browserId: string; readonly profileId: string }
	| { readonly type: "closed"; readonly sessionId: string; readonly browserId: string }
	| { readonly type: "activity"; readonly sessionId: string; readonly browserId: string; readonly active: boolean }
	| {
			readonly type: "handoff";
			readonly sessionId: string;
			readonly browserId: string;
			readonly status: "requested" | "completed" | "cancelled";
			readonly reason?: DesktopBrowserHandoffReason;
	  };

export const DEFAULT_BROWSER_PROFILE_ID = "00000000-0000-4000-8000-000000000001";
export type DesktopBrowserSourceId = "chrome" | "edge" | "brave" | "chromium";

export interface DesktopBrowserProfile {
	readonly profileId: string;
	readonly name: string;
	readonly sourceId: DesktopBrowserSourceId | null;
	readonly sourceProfileId: string | null;
}

export interface DesktopBrowserImportSourceProfile {
	readonly sourceProfileId: string;
	readonly name: string;
	readonly email: string | null;
}

export interface DesktopBrowserImportSource {
	readonly sourceId: DesktopBrowserSourceId;
	readonly name: string;
	readonly running: boolean;
	readonly profiles: readonly DesktopBrowserImportSourceProfile[];
}

export interface DesktopBrowserImportInput {
	readonly sourceId: DesktopBrowserSourceId;
	readonly sourceProfileId: string;
	readonly dataTypes: { readonly cookies: boolean; readonly history: boolean };
}

export interface DesktopBrowserImportResult {
	readonly profile: DesktopBrowserProfile;
	readonly cookies: { readonly imported: number; readonly skipped: number } | null;
	readonly history: { readonly accepted: number; readonly retained: number } | null;
}

export interface DesktopListBrowserHistoryInput {
	readonly profileId: string;
}

export type DesktopDownloadState = "progressing" | "paused" | "completed" | "cancelled" | "interrupted";

export interface DesktopDownloadItem {
	readonly downloadId: string;
	readonly url: string;
	readonly filename: string;
	readonly savePath: string;
	readonly state: DesktopDownloadState;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly startedAt: number;
}

export type DesktopDownloadControlType = "pause" | "resume" | "cancel" | "remove" | "open" | "reveal" | "retry";

export interface DesktopDownloadControlInput {
	readonly type: DesktopDownloadControlType;
	readonly downloadId: string;
}

export interface DesktopHistoryEntry {
	readonly entryId: string;
	readonly url: string;
	readonly title: string;
	readonly faviconUrl: string | null;
	readonly visitedAt: number;
}

export interface DesktopWorkspaceTarget {
	readonly sessionId: string;
	readonly relativePath: string;
}

export interface DesktopWorkspaceEntry {
	readonly name: string;
	readonly relativePath: string;
	readonly kind: "directory" | "file" | "symlink";
}

export type DesktopWorkspaceMutableKind = "directory" | "file";

export type DesktopWorkspaceMutationInput =
	| {
			readonly action: "create";
			readonly sessionId: string;
			readonly parentRelativePath: string;
			readonly name: string;
			readonly kind: DesktopWorkspaceMutableKind;
	  }
	| {
			readonly action: "rename";
			readonly sessionId: string;
			readonly relativePath: string;
			readonly name: string;
	  }
	| {
			readonly action: "move";
			readonly sessionId: string;
			readonly relativePath: string;
			readonly destinationDirectoryRelativePath: string;
	  }
	| { readonly action: "trash"; readonly sessionId: string; readonly relativePath: string };

export type DesktopWorkspaceMutationResult =
	| {
			readonly action: "create";
			readonly kind: DesktopWorkspaceMutableKind;
			readonly relativePath: string;
			readonly absolutePath: string;
	  }
	| {
			readonly action: "rename" | "move";
			readonly kind: DesktopWorkspaceMutableKind;
			readonly previousRelativePath: string;
			readonly previousAbsolutePath: string;
			readonly relativePath: string;
			readonly absolutePath: string;
	  }
	| {
			readonly action: "trash";
			readonly kind: DesktopWorkspaceMutableKind;
			readonly previousRelativePath: string;
			readonly previousAbsolutePath: string;
	  };

export type DesktopWorkspaceReviewRevision = "working-tree" | string;

export interface DesktopWorkspaceReviewInput {
	readonly sessionId: string;
	readonly revision: DesktopWorkspaceReviewRevision;
}

export interface DesktopWorkspaceReviewFileInput extends DesktopWorkspaceReviewInput {
	readonly relativePath: string;
}

export type DesktopWorkspaceReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

export interface DesktopWorkspaceReviewFile {
	readonly relativePath: string;
	readonly previousRelativePath: string | null;
	readonly status: DesktopWorkspaceReviewFileStatus;
	readonly additions: number | null;
	readonly deletions: number | null;
	readonly binary: boolean;
}

export interface DesktopWorkspaceReviewCommit {
	readonly hash: string;
	readonly shortHash: string;
	readonly subject: string;
	readonly authorName: string;
	readonly authoredAt: string;
}

export type DesktopWorkspaceReviewSnapshot =
	| { readonly kind: "not-repository" }
	| {
			readonly kind: "review";
			readonly repositoryRoot: string;
			readonly branch: string;
			readonly head: string | null;
			readonly revision: DesktopWorkspaceReviewRevision;
			readonly files: readonly DesktopWorkspaceReviewFile[];
			readonly commits: readonly DesktopWorkspaceReviewCommit[];
	  };

export type DesktopWorkspaceReviewFileDiff =
	| { readonly kind: "text"; readonly patch: string }
	| { readonly kind: "binary" }
	| { readonly kind: "too-large" };

export interface DesktopWorkspaceReviewTextFile {
	readonly name: string;
	readonly contents: string;
	readonly cacheKey: string;
}

export type DesktopWorkspaceReviewFileContext =
	| {
			readonly kind: "text";
			readonly oldFile: DesktopWorkspaceReviewTextFile;
			readonly newFile: DesktopWorkspaceReviewTextFile;
	  }
	| { readonly kind: "unavailable"; readonly reason: "binary" | "too-large" };

export interface DesktopWorkspaceSearchInput {
	readonly sessionId: string;
	readonly query: string;
}

export interface DesktopOpenWorkspaceFileInput extends DesktopWorkspaceTarget {
	readonly action: "default" | "reveal";
}

export interface DesktopWriteWorkspaceFileInput extends DesktopWorkspaceTarget {
	readonly text: string;
	readonly expectedRevision: string;
}

export interface DesktopWriteWorkspaceFileResult {
	readonly revision: string;
	readonly byteLength: number;
}

export interface DesktopWriteClipboardTextInput {
	readonly text: string;
}

interface DesktopWorkspaceFileBase {
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly byteLength: number;
}

export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

export type DesktopPreviewFileInput =
	| { readonly source: "delivered"; readonly sessionId: string; readonly fileId: string }
	| { readonly source: "workspace"; readonly sessionId: string; readonly relativePath: string };

export type DesktopPreviewFile =
	| {
			readonly ok: true;
			readonly name: string;
			readonly byteLength: number;
			readonly mediaType: string;
			readonly bytes: Uint8Array;
	  }
	| { readonly ok: false; readonly reason: "too-large" | "not-found" };

export type DesktopWorkspaceFile =
	| (DesktopWorkspaceFileBase & { readonly kind: "text"; readonly text: string; readonly revision: string })
	| (DesktopWorkspaceFileBase & {
			readonly kind: "image";
			readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
			readonly dataUrl: string;
	  })
	| (DesktopWorkspaceFileBase & {
			readonly kind: "binary";
			readonly mediaType: string;
			readonly dataUrl: string;
			readonly revision?: string;
	  })
	| (DesktopWorkspaceFileBase & { readonly kind: "unsupported"; readonly reason: "binary" | "too-large" });

export interface DesktopAttachmentSelection {
	readonly path: string;
	readonly name: string;
	/** Renderer-only thumbnail generated by the trusted main process. Never sent to App Server. */
	readonly previewDataUrl?: string;
}

export interface DesktopWorkspaceEditState {
	readonly dirty: boolean;
	readonly language: "en" | "zh";
	readonly visibleSessionId: string | null;
}

export interface DesktopCreateProjectFolderInput {
	readonly parentDirectory: string;
	readonly name: string;
	readonly files: readonly DesktopAttachmentSelection[];
}

export type DesktopRpcOutcome<Result> =
	| { readonly ok: true; readonly result: Result }
	| { readonly ok: false; readonly error: { readonly code: number; readonly message: string } };

export interface MetisDesktopApi extends DesktopRpcForwardingApi {
	readonly platform: string;
	openSkillFolder(input: ClientParams<"skill/get">): Promise<void>;
	subscribeSchedule(): Promise<ClientResult<"schedule/subscribe">>;
	unsubscribeSchedule(): Promise<ClientResult<"schedule/unsubscribe">>;
	setScheduleKeepAwake(enabled: boolean): Promise<void>;
	previewProjectDelete(
		input: ClientParams<"project/deletePreview">,
	): Promise<DesktopRpcOutcome<ClientResult<"project/deletePreview">>>;
	deleteProject(input: ClientParams<"project/delete">): Promise<DesktopRpcOutcome<ClientResult<"project/delete">>>;
	deleteSession(input: ClientParams<"session/delete">): Promise<ClientResult<"session/delete">>;
	openSession(input: ClientParams<"session/open">): Promise<ClientResult<"session/subscribe">["snapshot"]>;
	readDeliveredFile(
		input: ClientParams<"session/readDeliveredFile">,
	): Promise<ClientResult<"session/readDeliveredFile">>;
	readPreviewFile(input: DesktopPreviewFileInput): Promise<DesktopPreviewFile>;
	interruptTurn(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">>;
	respondToInteraction(input: InteractionResponseInput): Promise<void>;
	selectProjectFolder(): Promise<string | null>;
	selectAttachmentFiles(): Promise<DesktopAttachmentSelection[]>;
	resolveDroppedFiles(files: readonly File[]): DesktopAttachmentSelection[];
	getDefaultProjectLocation(): Promise<string>;
	createProjectFolder(input: DesktopCreateProjectFolderInput): Promise<string>;
	createTerminal(input: DesktopCreateTerminalInput): Promise<DesktopTerminalInfo>;
	writeTerminal(input: DesktopWriteTerminalInput): Promise<void>;
	resizeTerminal(input: DesktopResizeTerminalInput): Promise<void>;
	closeTerminal(input: DesktopCloseTerminalInput): Promise<void>;
	subscribeTerminal(listener: (event: DesktopTerminalEvent) => void): () => void;
	createBrowser(input: DesktopCreateBrowserInput): Promise<DesktopBrowserState>;
	captureBrowserPreview(input: DesktopCloseBrowserInput): Promise<string>;
	controlBrowser(input: DesktopBrowserControlInput): Promise<void>;
	closeBrowser(input: DesktopCloseBrowserInput): Promise<void>;
	takeBrowserControl(input: DesktopCloseBrowserInput): Promise<void>;
	resolveBrowserHandoff(input: DesktopResolveBrowserHandoffInput): Promise<void>;
	listBrowserDownloads(): Promise<readonly DesktopDownloadItem[]>;
	controlBrowserDownload(input: DesktopDownloadControlInput): Promise<void>;
	listBrowserProfiles(): Promise<readonly DesktopBrowserProfile[]>;
	listBrowserImportSources(): Promise<readonly DesktopBrowserImportSource[]>;
	importBrowserData(input: DesktopBrowserImportInput): Promise<DesktopBrowserImportResult>;
	listBrowserHistory(input: DesktopListBrowserHistoryInput): Promise<readonly DesktopHistoryEntry[]>;
	clearBrowserHistory(input: DesktopListBrowserHistoryInput): Promise<void>;
	subscribeBrowser(listener: (event: DesktopBrowserEvent) => void): () => void;
	listWorkspaceDirectory(input: DesktopWorkspaceTarget): Promise<readonly DesktopWorkspaceEntry[]>;
	searchWorkspaceFiles(input: DesktopWorkspaceSearchInput): Promise<readonly string[]>;
	readWorkspaceFile(input: DesktopWorkspaceTarget): Promise<DesktopWorkspaceFile>;
	writeWorkspaceFile(input: DesktopWriteWorkspaceFileInput): Promise<DesktopWriteWorkspaceFileResult>;
	openWorkspaceFile(input: DesktopOpenWorkspaceFileInput): Promise<void>;
	mutateWorkspaceEntry(input: DesktopWorkspaceMutationInput): Promise<DesktopWorkspaceMutationResult>;
	getWorkspaceReview(input: DesktopWorkspaceReviewInput): Promise<DesktopWorkspaceReviewSnapshot>;
	getWorkspaceReviewFileDiff(input: DesktopWorkspaceReviewFileInput): Promise<DesktopWorkspaceReviewFileDiff>;
	getWorkspaceReviewFileContext(input: DesktopWorkspaceReviewFileInput): Promise<DesktopWorkspaceReviewFileContext>;
	writeClipboardText(input: DesktopWriteClipboardTextInput): Promise<void>;
	setWorkspaceEditState(input: DesktopWorkspaceEditState): Promise<void>;
	getUpdateState(): Promise<DesktopUpdateState>;
	startUpdate(): Promise<void>;
	subscribeUpdate(listener: (state: DesktopUpdateState) => void): () => void;
	subscribe(listener: (event: DesktopApiEvent) => void): () => void;
	getServerState(): Promise<SupervisorView>;
	retryServer(): Promise<void>;
	getThemePreference(): Promise<DesktopThemePreference>;
	setThemePreference(theme: DesktopThemePreference): Promise<void>;
}

const interactionResponseValidator = compileSchema(InteractionResultSchema);
const interactionIdValidator = compileSchema(UuidSchema);
const sessionIdValidator = compileSchema(SessionIdSchema);

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	assertEnvelopeByteLimit(value);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
		throw new TypeError(`Invalid ${label}`);
	return record;
}

function workspaceSessionId(value: unknown): string {
	assertSchema(interactionIdValidator, value, "invalid_params", "workspace session id");
	return value as string;
}

function workspaceRelativePath(value: unknown, allowRoot: boolean): string {
	if (
		typeof value !== "string" ||
		value.length > 4_096 ||
		value.includes("\0") ||
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[A-Za-z]:\//u.test(value) ||
		(!allowRoot && value.length === 0)
	) {
		throw new TypeError("Invalid workspace relative path");
	}
	const parts = value.split("/");
	if (value.length > 0 && parts.some((part) => part === "" || part === "." || part === "..")) {
		throw new TypeError("Invalid workspace relative path");
	}
	return value;
}

export function validateListWorkspaceDirectoryInput(value: unknown): DesktopWorkspaceTarget {
	const input = exactRecord(value, ["sessionId", "relativePath"], "workspace directory input");
	return {
		sessionId: workspaceSessionId(input.sessionId),
		relativePath: workspaceRelativePath(input.relativePath, true),
	};
}

export function validateSearchWorkspaceFilesInput(value: unknown): DesktopWorkspaceSearchInput {
	const input = exactRecord(value, ["sessionId", "query"], "workspace search input");
	if (
		typeof input.query !== "string" ||
		input.query.length > 256 ||
		input.query.includes("\0") ||
		input.query.trim().length === 0
	) {
		throw new TypeError("Invalid workspace search query");
	}
	return { sessionId: workspaceSessionId(input.sessionId), query: input.query };
}

export function validateReadWorkspaceFileInput(value: unknown): DesktopWorkspaceTarget {
	const input = exactRecord(value, ["sessionId", "relativePath"], "workspace file input");
	return {
		sessionId: workspaceSessionId(input.sessionId),
		relativePath: workspaceRelativePath(input.relativePath, false),
	};
}

const DELIVERED_FILE_ID = /^[a-f0-9]{16}$/iu;

export function validateReadPreviewFileInput(value: unknown): DesktopPreviewFileInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid preview file input");
	}
	const record = value as Record<string, unknown>;
	if (record.source === "delivered") {
		const input = exactRecord(value, ["source", "sessionId", "fileId"], "preview file input");
		if (typeof input.fileId !== "string" || !DELIVERED_FILE_ID.test(input.fileId)) {
			throw new TypeError("Invalid preview file id");
		}
		assertSchema(sessionIdValidator, input.sessionId, "invalid_params", "preview session id");
		return {
			source: "delivered",
			sessionId: input.sessionId as string,
			fileId: input.fileId.toLowerCase(),
		};
	}
	if (record.source === "workspace") {
		const input = exactRecord(value, ["source", "sessionId", "relativePath"], "preview file input");
		return {
			source: "workspace",
			sessionId: workspaceSessionId(input.sessionId),
			relativePath: workspaceRelativePath(input.relativePath, false),
		};
	}
	throw new TypeError("Invalid preview file input");
}

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u;

function workspaceReviewRevision(value: unknown): DesktopWorkspaceReviewRevision {
	if (value !== "working-tree" && (typeof value !== "string" || !FULL_GIT_OBJECT_ID.test(value))) {
		throw new TypeError("Invalid workspace review revision");
	}
	return value;
}

export function validateWorkspaceReviewInput(value: unknown): DesktopWorkspaceReviewInput {
	const input = exactRecord(value, ["sessionId", "revision"], "workspace review input");
	return {
		sessionId: workspaceSessionId(input.sessionId),
		revision: workspaceReviewRevision(input.revision),
	};
}

export function validateWorkspaceReviewFileInput(value: unknown): DesktopWorkspaceReviewFileInput {
	const input = exactRecord(value, ["sessionId", "revision", "relativePath"], "workspace review file input");
	return {
		sessionId: workspaceSessionId(input.sessionId),
		revision: workspaceReviewRevision(input.revision),
		relativePath: workspaceRelativePath(input.relativePath, false),
	};
}

export function validateWriteWorkspaceFileInput(value: unknown): DesktopWriteWorkspaceFileInput {
	const input = exactRecord(value, ["sessionId", "relativePath", "text", "expectedRevision"], "workspace write input");
	if (typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > 2 * 1024 * 1024) {
		throw new TypeError("Invalid workspace file text");
	}
	if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedRevision)) {
		throw new TypeError("Invalid workspace file revision");
	}
	return {
		sessionId: workspaceSessionId(input.sessionId),
		relativePath: workspaceRelativePath(input.relativePath, false),
		text: input.text,
		expectedRevision: input.expectedRevision,
	};
}

export function validateOpenWorkspaceFileInput(value: unknown): DesktopOpenWorkspaceFileInput {
	const input = exactRecord(value, ["sessionId", "relativePath", "action"], "workspace open input");
	if (input.action !== "default" && input.action !== "reveal") {
		throw new TypeError("Invalid workspace open action");
	}
	return {
		sessionId: workspaceSessionId(input.sessionId),
		relativePath: workspaceRelativePath(input.relativePath, false),
		action: input.action,
	};
}

function workspaceEntryName(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 255 ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("\0")
	)
		throw new TypeError("Invalid workspace entry name");
	return value;
}

export function validateWorkspaceMutationInput(value: unknown): DesktopWorkspaceMutationInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid workspace mutation input");
	}
	const action = (value as { readonly action?: unknown }).action;
	if (action === "create") {
		const input = exactRecord(
			value,
			["action", "sessionId", "parentRelativePath", "name", "kind"],
			"workspace create input",
		);
		if (input.kind !== "file" && input.kind !== "directory") throw new TypeError("Invalid workspace entry kind");
		return {
			action,
			sessionId: workspaceSessionId(input.sessionId),
			parentRelativePath: workspaceRelativePath(input.parentRelativePath, true),
			name: workspaceEntryName(input.name),
			kind: input.kind,
		};
	}
	if (action === "rename") {
		const input = exactRecord(value, ["action", "sessionId", "relativePath", "name"], "workspace rename input");
		return {
			action,
			sessionId: workspaceSessionId(input.sessionId),
			relativePath: workspaceRelativePath(input.relativePath, false),
			name: workspaceEntryName(input.name),
		};
	}
	if (action === "move") {
		const input = exactRecord(
			value,
			["action", "sessionId", "relativePath", "destinationDirectoryRelativePath"],
			"workspace move input",
		);
		return {
			action,
			sessionId: workspaceSessionId(input.sessionId),
			relativePath: workspaceRelativePath(input.relativePath, false),
			destinationDirectoryRelativePath: workspaceRelativePath(input.destinationDirectoryRelativePath, true),
		};
	}
	if (action === "trash") {
		const input = exactRecord(value, ["action", "sessionId", "relativePath"], "workspace trash input");
		return {
			action,
			sessionId: workspaceSessionId(input.sessionId),
			relativePath: workspaceRelativePath(input.relativePath, false),
		};
	}
	throw new TypeError("Invalid workspace mutation action");
}

export function validateWriteClipboardTextInput(value: unknown): DesktopWriteClipboardTextInput {
	const input = exactRecord(value, ["text"], "clipboard write input");
	if (typeof input.text !== "string") throw new TypeError("Invalid clipboard text");
	return { text: input.text };
}

export function validateWorkspaceEditState(value: unknown): DesktopWorkspaceEditState {
	const input = exactRecord(value, ["dirty", "language", "visibleSessionId"], "workspace edit state");
	if (typeof input.dirty !== "boolean" || (input.language !== "en" && input.language !== "zh")) {
		throw new TypeError("Invalid workspace edit state");
	}
	if (input.visibleSessionId !== null) {
		assertSchema(sessionIdValidator, input.visibleSessionId, "invalid_params", "visible session id");
	}
	return {
		dirty: input.dirty,
		language: input.language,
		visibleSessionId: input.visibleSessionId as string | null,
	};
}

export function validateDesktopUpdateState(value: unknown): DesktopUpdateState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid desktop update state");
	}
	const status = (value as { readonly status?: unknown }).status;
	if (status === "unavailable" || status === "checking") {
		exactRecord(value, ["status"], "desktop update state");
		return { status };
	}
	if (status === "available" || status === "ready") {
		const state = exactRecord(value, ["status", "version"], "desktop update state");
		if (typeof state.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(state.version)) {
			throw new TypeError("Invalid desktop update version");
		}
		return { status, version: state.version };
	}
	if (status === "downloading") {
		const state = exactRecord(value, ["status", "version", "progress"], "desktop update state");
		if (
			typeof state.version !== "string" ||
			!/^\d+\.\d+\.\d+$/u.test(state.version) ||
			!Number.isInteger(state.progress) ||
			Number(state.progress) < 0 ||
			Number(state.progress) > 100
		) {
			throw new TypeError("Invalid desktop update progress");
		}
		return { status, version: state.version, progress: Number(state.progress) };
	}
	throw new TypeError("Invalid desktop update state");
}

function terminalId(value: unknown): string {
	assertSchema(interactionIdValidator, value, "invalid_params", "terminal id");
	return value as string;
}

function terminalDimension(value: unknown, label: string): number {
	if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000) {
		throw new TypeError(`Invalid terminal ${label}`);
	}
	return Number(value);
}

export function validateCreateTerminalInput(value: unknown): DesktopCreateTerminalInput {
	const input = exactRecord(value, ["terminalId", "cwd", "cols", "rows"], "terminal create input");
	if (
		typeof input.cwd !== "string" ||
		input.cwd.length === 0 ||
		input.cwd.length > 4_096 ||
		input.cwd.includes("\0")
	) {
		throw new TypeError("Invalid terminal working directory");
	}
	return {
		terminalId: terminalId(input.terminalId),
		cwd: input.cwd,
		cols: terminalDimension(input.cols, "columns"),
		rows: terminalDimension(input.rows, "rows"),
	};
}

export function validateWriteTerminalInput(value: unknown): DesktopWriteTerminalInput {
	const input = exactRecord(value, ["terminalId", "data"], "terminal write input");
	if (typeof input.data !== "string" || input.data.length > 65_536) throw new TypeError("Invalid terminal input");
	return { terminalId: terminalId(input.terminalId), data: input.data };
}

export function validateResizeTerminalInput(value: unknown): DesktopResizeTerminalInput {
	const input = exactRecord(value, ["terminalId", "cols", "rows"], "terminal resize input");
	return {
		terminalId: terminalId(input.terminalId),
		cols: terminalDimension(input.cols, "columns"),
		rows: terminalDimension(input.rows, "rows"),
	};
}

export function validateCloseTerminalInput(value: unknown): DesktopCloseTerminalInput {
	const input = exactRecord(value, ["terminalId"], "terminal close input");
	return { terminalId: terminalId(input.terminalId) };
}

export function validateDesktopTerminalEvent(value: unknown): DesktopTerminalEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Invalid terminal event");
	const type = (value as { type?: unknown }).type;
	if (type === "data") {
		const event = exactRecord(value, ["type", "terminalId", "data"], "terminal data event");
		if (typeof event.data !== "string") throw new TypeError("Invalid terminal data event");
		return { type, terminalId: terminalId(event.terminalId), data: event.data };
	}
	if (type === "exit") {
		const record = value as Record<string, unknown>;
		const keys = Object.hasOwn(record, "signal")
			? ["type", "terminalId", "exitCode", "signal"]
			: ["type", "terminalId", "exitCode"];
		const event = exactRecord(value, keys, "terminal exit event");
		if (!Number.isInteger(event.exitCode) || (event.signal !== undefined && !Number.isInteger(event.signal))) {
			throw new TypeError("Invalid terminal exit event");
		}
		return {
			type,
			terminalId: terminalId(event.terminalId),
			exitCode: Number(event.exitCode),
			...(event.signal === undefined ? {} : { signal: Number(event.signal) }),
		};
	}
	throw new TypeError("Invalid terminal event");
}

function browserId(value: unknown): string {
	assertSchema(interactionIdValidator, value, "invalid_params", "browser id");
	return value as string;
}

function browserSessionId(value: unknown): string {
	assertSchema(sessionIdValidator, value, "invalid_params", "browser session id");
	return value as string;
}

function browserCoordinate(value: unknown, label: string, allowZero: boolean): number {
	if (!Number.isInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > 32_768) {
		throw new TypeError(`Invalid browser ${label}`);
	}
	return Number(value);
}

function browserInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new TypeError(`Invalid browser ${label}`);
	}
	return Number(value);
}

function browserText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
		throw new TypeError(`Invalid browser ${label}`);
	}
	return value;
}

const BROWSER_SOURCE_IDS: readonly DesktopBrowserSourceId[] = ["chrome", "edge", "brave", "chromium"];

function browserProfileId(value: unknown): string {
	assertSchema(interactionIdValidator, value, "invalid_params", "browser profile id");
	return value as string;
}

function browserSourceId(value: unknown): DesktopBrowserSourceId {
	if (!(BROWSER_SOURCE_IDS as readonly unknown[]).includes(value)) throw new TypeError("Invalid browser source");
	return value as DesktopBrowserSourceId;
}

export function validateBrowserSourceProfileId(value: unknown): string {
	const id = browserText(value, "source profile id", 128);
	if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
		throw new TypeError("Invalid source profile id");
	}
	return id;
}

function validateBrowserProfile(value: unknown): DesktopBrowserProfile {
	const profile = exactRecord(value, ["profileId", "name", "sourceId", "sourceProfileId"], "browser profile");
	const sourceId = profile.sourceId === null ? null : browserSourceId(profile.sourceId);
	const sourceProfileId =
		profile.sourceProfileId === null ? null : validateBrowserSourceProfileId(profile.sourceProfileId);
	if ((sourceId === null) !== (sourceProfileId === null)) throw new TypeError("Invalid browser profile source");
	const name = browserText(profile.name, "profile name", 128).trim();
	if (name === "") throw new TypeError("Invalid browser profile name");
	return { profileId: browserProfileId(profile.profileId), name, sourceId, sourceProfileId };
}

export function validateBrowserProfileList(value: unknown): readonly DesktopBrowserProfile[] {
	assertEnvelopeByteLimit(value);
	if (!Array.isArray(value) || value.length > 128) throw new TypeError("Invalid browser profiles");
	return value.map(validateBrowserProfile);
}

function validateBrowserImportSourceProfile(value: unknown): DesktopBrowserImportSourceProfile {
	const profile = exactRecord(value, ["sourceProfileId", "name", "email"], "browser import source profile");
	return {
		sourceProfileId: validateBrowserSourceProfileId(profile.sourceProfileId),
		name: browserText(profile.name, "source profile name", 128),
		email: profile.email === null ? null : browserText(profile.email, "source profile email", 320),
	};
}

export function validateBrowserImportSourceList(value: unknown): readonly DesktopBrowserImportSource[] {
	assertEnvelopeByteLimit(value);
	if (!Array.isArray(value) || value.length > BROWSER_SOURCE_IDS.length)
		throw new TypeError("Invalid browser import sources");
	return value.map((candidate) => {
		const source = exactRecord(candidate, ["sourceId", "name", "running", "profiles"], "browser import source");
		if (typeof source.running !== "boolean" || !Array.isArray(source.profiles) || source.profiles.length > 128) {
			throw new TypeError("Invalid browser import source");
		}
		return {
			sourceId: browserSourceId(source.sourceId),
			name: browserText(source.name, "source name", 128),
			running: source.running,
			profiles: source.profiles.map(validateBrowserImportSourceProfile),
		};
	});
}

export function validateBrowserImportInput(value: unknown): DesktopBrowserImportInput {
	const input = exactRecord(value, ["sourceId", "sourceProfileId", "dataTypes"], "browser import input");
	const dataTypes = exactRecord(input.dataTypes, ["cookies", "history"], "browser import data types");
	if (typeof dataTypes.cookies !== "boolean" || typeof dataTypes.history !== "boolean") {
		throw new TypeError("Invalid browser import data types");
	}
	if (!dataTypes.cookies && !dataTypes.history) throw new TypeError("Select browser data to import");
	return {
		sourceId: browserSourceId(input.sourceId),
		sourceProfileId: validateBrowserSourceProfileId(input.sourceProfileId),
		dataTypes: { cookies: dataTypes.cookies, history: dataTypes.history },
	};
}

export function validateBrowserImportResult(value: unknown): DesktopBrowserImportResult {
	const result = exactRecord(value, ["profile", "cookies", "history"], "browser import result");
	const counts = (candidate: unknown, label: string, retained = false) => {
		if (candidate === null) return null;
		const names = retained ? ["accepted", "retained"] : ["imported", "skipped"];
		const record = exactRecord(candidate, names, label);
		return retained
			? {
					accepted: browserInteger(record.accepted, "history accepted count", 0, Number.MAX_SAFE_INTEGER),
					retained: browserInteger(record.retained, "history retained count", 0, 500),
				}
			: {
					imported: browserInteger(record.imported, "cookie imported count", 0, Number.MAX_SAFE_INTEGER),
					skipped: browserInteger(record.skipped, "cookie skipped count", 0, Number.MAX_SAFE_INTEGER),
				};
	};
	return {
		profile: validateBrowserProfile(result.profile),
		cookies: counts(result.cookies, "browser cookie import result") as DesktopBrowserImportResult["cookies"],
		history: counts(result.history, "browser history import result", true) as DesktopBrowserImportResult["history"],
	};
}

export function validateListBrowserHistoryInput(value: unknown): DesktopListBrowserHistoryInput {
	const input = exactRecord(value, ["profileId"], "browser history input");
	return { profileId: browserProfileId(input.profileId) };
}

export function validateCreateBrowserInput(value: unknown): DesktopCreateBrowserInput {
	const input = exactRecord(value, ["sessionId", "browserId", "profileId"], "browser create input");
	return {
		sessionId: browserSessionId(input.sessionId),
		browserId: browserId(input.browserId),
		profileId: browserProfileId(input.profileId),
	};
}

export function validateCloseBrowserInput(value: unknown): DesktopCloseBrowserInput {
	const input = exactRecord(value, ["sessionId", "browserId"], "browser close input");
	return { sessionId: browserSessionId(input.sessionId), browserId: browserId(input.browserId) };
}

export function validateResolveBrowserHandoffInput(value: unknown): DesktopResolveBrowserHandoffInput {
	const input = exactRecord(value, ["sessionId", "browserId", "decision"], "browser handoff input");
	if (input.decision !== "complete" && input.decision !== "cancel") throw new TypeError("Invalid handoff decision");
	return {
		sessionId: browserSessionId(input.sessionId),
		browserId: browserId(input.browserId),
		decision: input.decision,
	};
}

export function validateBrowserControlInput(value: unknown): DesktopBrowserControlInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid browser control input");
	}
	const type = (value as { type?: unknown }).type;
	if (type === "navigate") {
		const input = exactRecord(value, ["type", "sessionId", "browserId", "url"], "browser navigate input");
		const url = browserText(input.url, "URL", 8_192);
		if (url.length === 0) throw new TypeError("Invalid browser URL");
		return { type, sessionId: browserSessionId(input.sessionId), browserId: browserId(input.browserId), url };
	}
	if (type === "find") {
		const input = exactRecord(
			value,
			["type", "sessionId", "browserId", "text", "forward", "findNext"],
			"browser find input",
		);
		if (typeof input.forward !== "boolean" || typeof input.findNext !== "boolean") {
			throw new TypeError("Invalid browser find direction");
		}
		return {
			type,
			sessionId: browserSessionId(input.sessionId),
			browserId: browserId(input.browserId),
			text: browserText(input.text, "find text", 2_048),
			forward: input.forward,
			findNext: input.findNext,
		};
	}
	if (type === "set-zoom") {
		const input = exactRecord(value, ["type", "sessionId", "browserId", "zoomPercent"], "browser zoom input");
		return {
			type,
			sessionId: browserSessionId(input.sessionId),
			browserId: browserId(input.browserId),
			zoomPercent: browserInteger(input.zoomPercent, "zoom percent", 25, 500),
		};
	}
	if (
		type === "back" ||
		type === "forward" ||
		type === "reload" ||
		type === "open-external" ||
		type === "stop-find" ||
		type === "print" ||
		type === "zoom-in" ||
		type === "zoom-out" ||
		type === "zoom-reset" ||
		type === "capture-page" ||
		type === "clear-data"
	) {
		const input = exactRecord(value, ["type", "sessionId", "browserId"], "browser control input");
		return { type, sessionId: browserSessionId(input.sessionId), browserId: browserId(input.browserId) };
	}
	if (type === "present") {
		const input = exactRecord(
			value,
			["type", "sessionId", "browserId", "visible", "bounds"],
			"browser present input",
		);
		const bounds = exactRecord(input.bounds, ["x", "y", "width", "height"], "browser bounds");
		if (typeof input.visible !== "boolean") throw new TypeError("Invalid browser visibility");
		return {
			type,
			sessionId: browserSessionId(input.sessionId),
			browserId: browserId(input.browserId),
			visible: input.visible,
			bounds: {
				x: browserCoordinate(bounds.x, "x", true),
				y: browserCoordinate(bounds.y, "y", true),
				width: browserCoordinate(bounds.width, "width", false),
				height: browserCoordinate(bounds.height, "height", false),
			},
		};
	}
	throw new TypeError("Invalid browser control input");
}

export function validateDesktopBrowserEvent(value: unknown): DesktopBrowserEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid browser event");
	}
	const type = (value as { type?: unknown }).type;
	if (type === "state") {
		const event = exactRecord(value, ["type", "state"], "browser state event");
		const state = exactRecord(
			event.state,
			[
				"browserId",
				"profileId",
				"url",
				"title",
				"faviconUrl",
				"loading",
				"canGoBack",
				"canGoForward",
				"zoomPercent",
			],
			"browser state",
		);
		if (
			typeof state.loading !== "boolean" ||
			typeof state.canGoBack !== "boolean" ||
			typeof state.canGoForward !== "boolean" ||
			(state.faviconUrl !== null && typeof state.faviconUrl !== "string")
		) {
			throw new TypeError("Invalid browser state");
		}
		return {
			type,
			state: {
				browserId: browserId(state.browserId),
				profileId: browserProfileId(state.profileId),
				url: browserText(state.url, "state URL", 8_192),
				title: browserText(state.title, "title", 512),
				faviconUrl: state.faviconUrl === null ? null : browserText(state.faviconUrl, "favicon URL", 8_192),
				loading: state.loading,
				canGoBack: state.canGoBack,
				canGoForward: state.canGoForward,
				zoomPercent: browserInteger(state.zoomPercent, "zoom percent", 25, 500),
			},
		};
	}
	if (type === "error") {
		const event = exactRecord(value, ["type", "browserId", "message"], "browser error event");
		return {
			type,
			browserId: browserId(event.browserId),
			message: browserText(event.message, "error", 2_048),
		};
	}
	if (type === "find-result") {
		const event = exactRecord(
			value,
			["type", "browserId", "activeMatchOrdinal", "matches"],
			"browser find result event",
		);
		return {
			type,
			browserId: browserId(event.browserId),
			activeMatchOrdinal: browserInteger(event.activeMatchOrdinal, "active match", 0, 1_000_000),
			matches: browserInteger(event.matches, "match count", 0, 1_000_000),
		};
	}
	if (type === "command") {
		const event = exactRecord(value, ["type", "browserId", "command"], "browser command event");
		if (
			!(["find", "print", "zoom-in", "zoom-out", "zoom-reset"] as const).includes(
				event.command as DesktopBrowserCommand,
			)
		) {
			throw new TypeError("Invalid browser command");
		}
		return { type, browserId: browserId(event.browserId), command: event.command as DesktopBrowserCommand };
	}
	if (type === "downloads") {
		const event = exactRecord(value, ["type", "downloads"], "browser downloads event");
		if (!Array.isArray(event.downloads)) throw new TypeError("Invalid browser downloads");
		return { type, downloads: event.downloads.map(validateBrowserDownloadItem) };
	}
	if (type === "history") {
		const event = exactRecord(value, ["type", "profileId", "entries"], "browser history event");
		if (!Array.isArray(event.entries)) throw new TypeError("Invalid browser history");
		return {
			type,
			profileId: browserProfileId(event.profileId),
			entries: event.entries.map(validateBrowserHistoryEntry),
		};
	}
	if (type === "opened") {
		const event = exactRecord(value, ["type", "sessionId", "browserId", "profileId"], "browser opened event");
		return {
			type,
			sessionId: browserSessionId(event.sessionId),
			browserId: browserId(event.browserId),
			profileId: browserProfileId(event.profileId),
		};
	}
	if (type === "closed") {
		const event = exactRecord(value, ["type", "sessionId", "browserId"], "browser closed event");
		return { type, sessionId: browserSessionId(event.sessionId), browserId: browserId(event.browserId) };
	}
	if (type === "activity") {
		const event = exactRecord(value, ["type", "sessionId", "browserId", "active"], "browser activity event");
		if (typeof event.active !== "boolean") throw new TypeError("Invalid browser activity");
		return {
			type,
			sessionId: browserSessionId(event.sessionId),
			browserId: browserId(event.browserId),
			active: event.active,
		};
	}
	if (type === "handoff") {
		const event = exactRecord(
			value,
			eventHasReason(value)
				? ["type", "sessionId", "browserId", "status", "reason"]
				: ["type", "sessionId", "browserId", "status"],
			"browser handoff event",
		);
		if (event.status !== "requested" && event.status !== "completed" && event.status !== "cancelled") {
			throw new TypeError("Invalid browser handoff status");
		}
		const reasons: readonly DesktopBrowserHandoffReason[] = [
			"login",
			"otp",
			"passkey",
			"device_approval",
			"captcha",
			"sensitive_action",
			"other",
		];
		if ((event.status === "requested") !== reasons.includes(event.reason as DesktopBrowserHandoffReason)) {
			throw new TypeError("Invalid browser handoff reason");
		}
		return {
			type,
			sessionId: browserSessionId(event.sessionId),
			browserId: browserId(event.browserId),
			status: event.status,
			...(event.status === "requested" ? { reason: event.reason as DesktopBrowserHandoffReason } : {}),
		};
	}
	throw new TypeError("Invalid browser event");
}

function eventHasReason(value: object): boolean {
	return Object.hasOwn(value, "reason");
}

const DOWNLOAD_STATES: readonly DesktopDownloadState[] = [
	"progressing",
	"paused",
	"completed",
	"cancelled",
	"interrupted",
];

const DOWNLOAD_CONTROL_TYPES: readonly DesktopDownloadControlType[] = [
	"pause",
	"resume",
	"cancel",
	"remove",
	"open",
	"reveal",
	"retry",
];

function validateBrowserDownloadItem(value: unknown): DesktopDownloadItem {
	const item = exactRecord(
		value,
		["downloadId", "url", "filename", "savePath", "state", "receivedBytes", "totalBytes", "startedAt"],
		"browser download item",
	);
	if (!(DOWNLOAD_STATES as readonly string[]).includes(item.state as DesktopDownloadState)) {
		throw new TypeError("Invalid download state");
	}
	return {
		downloadId: browserId(item.downloadId),
		url: browserText(item.url, "download URL", 8_192),
		filename: browserText(item.filename, "download filename", 256),
		savePath: browserText(item.savePath, "download path", 4_096),
		state: item.state as DesktopDownloadState,
		receivedBytes: browserInteger(item.receivedBytes, "received bytes", 0, Number.MAX_SAFE_INTEGER),
		totalBytes: browserInteger(item.totalBytes, "total bytes", 0, Number.MAX_SAFE_INTEGER),
		startedAt: browserInteger(item.startedAt, "started at", 0, Number.MAX_SAFE_INTEGER),
	};
}

export function validateBrowserDownloadList(value: unknown): readonly DesktopDownloadItem[] {
	if (!Array.isArray(value)) throw new TypeError("Invalid browser downloads");
	return value.map(validateBrowserDownloadItem);
}

export function validateBrowserDownloadControlInput(value: unknown): DesktopDownloadControlInput {
	const input = exactRecord(value, ["type", "downloadId"], "browser download control input");
	if (!(DOWNLOAD_CONTROL_TYPES as readonly string[]).includes(input.type as DesktopDownloadControlType)) {
		throw new TypeError("Invalid download control type");
	}
	return { type: input.type as DesktopDownloadControlType, downloadId: browserId(input.downloadId) };
}

export function validateBrowserHistoryEntry(value: unknown): DesktopHistoryEntry {
	const entry = exactRecord(value, ["entryId", "url", "title", "faviconUrl", "visitedAt"], "browser history entry");
	return {
		entryId: browserId(entry.entryId),
		url: browserText(entry.url, "history URL", 8_192),
		title: browserText(entry.title, "history title", 512),
		faviconUrl: entry.faviconUrl === null ? null : browserText(entry.faviconUrl, "history favicon URL", 8_192),
		visitedAt: browserInteger(entry.visitedAt, "visited at", 0, Number.MAX_SAFE_INTEGER),
	};
}

export function validateBrowserHistoryList(value: unknown): readonly DesktopHistoryEntry[] {
	if (!Array.isArray(value)) throw new TypeError("Invalid browser history");
	return value.map(validateBrowserHistoryEntry);
}

export function validateDesktopClientParams<Method extends Exclude<ClientRequestMethod, "initialize">>(
	method: Method,
	value: unknown,
): ClientParams<Method> {
	const request = validateClientRequest({ jsonrpc: "2.0", id: "desktop-boundary", method, params: value });
	return request.params as ClientParams<Method>;
}

export function validateInteractionResponseInput(value: unknown): InteractionResponseInput {
	assertEnvelopeByteLimit(value);
	assertSchema(interactionResponseValidator, value, "invalid_params", "interaction response");
	return value as InteractionResponseInput;
}

function isSupervisorView(value: unknown): value is SupervisorView {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return (
		keys.length === 4 &&
		keys.every((key) => ["state", "serverEpoch", "restartAttempt", "failure"].includes(key)) &&
		["stopped", "starting", "ready", "restarting", "failed", "shuttingDown"].includes(String(record.state)) &&
		(record.serverEpoch === null || typeof record.serverEpoch === "string") &&
		Number.isInteger(record.restartAttempt) &&
		Number(record.restartAttempt) >= 0 &&
		(record.failure === null || typeof record.failure === "string")
	);
}

export function validateDesktopApiEvent(value: unknown): DesktopApiEvent {
	assertEnvelopeByteLimit(value);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Invalid desktop event");
	const event = value as Record<string, unknown>;
	if (event.type === "app-server" && Object.keys(event).length === 2) {
		const envelope = event.envelope as Record<string, unknown>;
		const validated = Object.hasOwn(envelope, "id")
			? validateServerRequest(envelope)
			: validateServerNotification(envelope);
		if (validated.method !== "interaction/request" && validated.method !== "connection/events") {
			throw new TypeError("Invalid renderer app-server event");
		}
		return {
			type: "app-server",
			envelope: validated as ServerRpcRequest<"interaction/request"> | ServerRpcNotification<"connection/events">,
		};
	}
	if (event.type === "supervisor" && Object.keys(event).length === 2 && isSupervisorView(event.view)) {
		return { type: "supervisor", view: event.view };
	}
	if (event.type === "interaction-cancelled" && Object.keys(event).length === 2) {
		assertSchema(interactionIdValidator, event.interactionId, "invalid_params", "interaction id");
		return { type: "interaction-cancelled", interactionId: event.interactionId as string };
	}
	if (
		event.type === "open-session" &&
		Object.keys(event).length === 3 &&
		(event.mode === "chat" || event.mode === "code")
	) {
		assertSchema(sessionIdValidator, event.sessionId, "invalid_params", "session id");
		return { type: "open-session", sessionId: event.sessionId as string, mode: event.mode };
	}
	throw new TypeError("Invalid desktop event");
}
