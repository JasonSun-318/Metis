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
	| { readonly type: "app-server"; readonly envelope: ServerRpcRequest | ServerRpcNotification }
	| { readonly type: "interaction-cancelled"; readonly interactionId: string }
	| { readonly type: "open-session"; readonly sessionId: string; readonly mode: "chat" | "code" }
	| { readonly type: "supervisor"; readonly view: SupervisorView };

export const DESKTOP_IPC_CHANNELS = {
	listSessions: "metis:list-sessions",
	listSkills: "metis:list-skills",
	getSkill: "metis:get-skill",
	upsertSkill: "metis:upsert-skill",
	removeSkill: "metis:remove-skill",
	inspectSkillImport: "metis:inspect-skill-import",
	importSkills: "metis:import-skills",
	openSkillFolder: "metis:open-skill-folder",
	listMcpServers: "metis:list-mcp-servers",
	inspectMcpImport: "metis:inspect-mcp-import",
	importMcpServers: "metis:import-mcp-servers",
	getMcpServer: "metis:get-mcp-server",
	getMcpCatalogItem: "metis:get-mcp-catalog-item",
	upsertMcpServer: "metis:upsert-mcp-server",
	removeMcpServer: "metis:remove-mcp-server",
	restartMcpServer: "metis:restart-mcp-server",
	setMcpCredential: "metis:set-mcp-credential",
	clearMcpCredential: "metis:clear-mcp-credential",
	getProfile: "metis:get-profile",
	listModels: "metis:list-models",
	getModelSettings: "metis:get-model-settings",
	updateModelSettings: "metis:update-model-settings",
	getPersonalization: "metis:get-personalization",
	updatePersonalization: "metis:update-personalization",
	getWebSearchSettings: "metis:get-web-search-settings",
	revealWebSearchCredential: "metis:reveal-web-search-credential",
	updateWebSearchSettings: "metis:update-web-search-settings",
	listHooks: "metis:list-hooks",
	upsertHook: "metis:upsert-hook",
	deleteHook: "metis:delete-hook",
	testModelConnection: "metis:test-model-connection",
	getUsage: "metis:get-usage",
	createSchedule: "metis:create-schedule",
	listSchedules: "metis:list-schedules",
	getSchedule: "metis:get-schedule",
	updateSchedule: "metis:update-schedule",
	pauseSchedule: "metis:pause-schedule",
	resumeSchedule: "metis:resume-schedule",
	deleteSchedule: "metis:delete-schedule",
	runScheduleNow: "metis:run-schedule-now",
	listScheduleRuns: "metis:list-schedule-runs",
	getScheduleRun: "metis:get-schedule-run",
	markScheduleRunRead: "metis:mark-schedule-run-read",
	subscribeSchedule: "metis:subscribe-schedule",
	unsubscribeSchedule: "metis:unsubscribe-schedule",
	setScheduleKeepAwake: "metis:set-schedule-keep-awake",
	previewProjectDelete: "metis:preview-project-delete",
	deleteProject: "metis:delete-project",
	createSession: "metis:create-session",
	renameSession: "metis:rename-session",
	forkSession: "metis:fork-session",
	deleteSession: "metis:delete-session",
	openSession: "metis:open-session",
	markSessionRead: "metis:mark-session-read",
	readItems: "metis:read-items",
	readSessionImage: "metis:read-session-image",
	getSessionStatus: "metis:get-session-status",
	compactSession: "metis:compact-session",
	setSessionGoal: "metis:set-session-goal",
	clearSessionGoal: "metis:clear-session-goal",
	readSubagentItems: "metis:read-subagent-items",
	interruptSubagent: "metis:interrupt-subagent",
	setThinkingSelection: "metis:set-thinking-selection",
	setPermissionMode: "metis:set-permission-mode",
	listPermissionRules: "metis:list-permission-rules",
	deletePermissionRule: "metis:delete-permission-rule",
	clearPermissionRules: "metis:clear-permission-rules",
	setModel: "metis:set-model",
	startTurn: "metis:start-turn",
	steerTurn: "metis:steer-turn",
	queueTurn: "metis:queue-turn",
	updateQueuedTurn: "metis:update-queued-turn",
	deleteQueuedTurn: "metis:delete-queued-turn",
	sendQueuedTurn: "metis:send-queued-turn",
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
	readonly browserId: string;
}

export interface DesktopCloseBrowserInput {
	readonly browserId: string;
}

export type DesktopBrowserCommand = "find" | "print" | "zoom-in" | "zoom-out" | "zoom-reset";

export interface DesktopBrowserState {
	readonly browserId: string;
	readonly url: string;
	readonly title: string;
	readonly faviconUrl: string | null;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly zoomPercent: number;
}

export type DesktopBrowserControlInput =
	| { readonly type: "navigate"; readonly browserId: string; readonly url: string }
	| {
			readonly type: "find";
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
			readonly browserId: string;
	  }
	| {
			readonly type: "set-zoom";
			readonly browserId: string;
			readonly zoomPercent: number;
	  }
	| {
			readonly type: "present";
			readonly browserId: string;
			readonly visible: boolean;
			readonly bounds: DesktopBrowserBounds;
	  };

export type DesktopBrowserEvent =
	| { readonly type: "state"; readonly state: DesktopBrowserState }
	| { readonly type: "error"; readonly browserId: string; readonly message: string }
	| {
			readonly type: "find-result";
			readonly browserId: string;
			readonly activeMatchOrdinal: number;
			readonly matches: number;
	  }
	| { readonly type: "command"; readonly browserId: string; readonly command: DesktopBrowserCommand };

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

export type DesktopWorkspaceFile =
	| (DesktopWorkspaceFileBase & { readonly kind: "text"; readonly text: string; readonly revision: string })
	| (DesktopWorkspaceFileBase & {
			readonly kind: "image";
			readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
			readonly dataUrl: string;
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

export interface MetisDesktopApi {
	readonly platform: string;
	listSessions(input?: ClientParams<"session/list">): Promise<ClientResult<"session/list">>;
	listSkills(input: ClientParams<"skill/list">): Promise<ClientResult<"skill/list">>;
	getSkill(input: ClientParams<"skill/get">): Promise<ClientResult<"skill/get">>;
	upsertSkill(input: ClientParams<"skill/upsert">): Promise<ClientResult<"skill/upsert">>;
	removeSkill(input: ClientParams<"skill/remove">): Promise<ClientResult<"skill/remove">>;
	inspectSkillImport(input: ClientParams<"skill/import/inspect">): Promise<ClientResult<"skill/import/inspect">>;
	importSkills(input: ClientParams<"skill/import">): Promise<ClientResult<"skill/import">>;
	openSkillFolder(input: ClientParams<"skill/get">): Promise<void>;
	listMcpServers(input: ClientParams<"mcp/list">): Promise<ClientResult<"mcp/list">>;
	inspectMcpImport(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">>;
	importMcpServers(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">>;
	getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">>;
	getMcpCatalogItem(input: ClientParams<"mcp/catalog/get">): Promise<ClientResult<"mcp/catalog/get">>;
	upsertMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">>;
	removeMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">>;
	restartMcpServer(input: ClientParams<"mcp/restart">): Promise<ClientResult<"mcp/restart">>;
	setMcpCredential(input: ClientParams<"mcp/credential/set">): Promise<ClientResult<"mcp/credential/set">>;
	clearMcpCredential(input: ClientParams<"mcp/credential/clear">): Promise<ClientResult<"mcp/credential/clear">>;
	getProfile(): Promise<ClientResult<"profile/get">>;
	listModels(): Promise<ClientResult<"model/list">>;
	getModelSettings(): Promise<ClientResult<"model/settings/get">>;
	updateModelSettings(input: ClientParams<"model/settings/update">): Promise<ClientResult<"model/settings/update">>;
	getPersonalization(): Promise<ClientResult<"personalization/get">>;
	updatePersonalization(
		input: ClientParams<"personalization/update">,
	): Promise<ClientResult<"personalization/update">>;
	getWebSearchSettings(): Promise<ClientResult<"webSearch/get">>;
	revealWebSearchCredential(
		input: ClientParams<"webSearch/credential/reveal">,
	): Promise<ClientResult<"webSearch/credential/reveal">>;
	updateWebSearchSettings(input: ClientParams<"webSearch/update">): Promise<ClientResult<"webSearch/update">>;
	listHooks(): Promise<ClientResult<"hooks/list">>;
	upsertHook(input: ClientParams<"hooks/upsert">): Promise<ClientResult<"hooks/upsert">>;
	deleteHook(input: ClientParams<"hooks/delete">): Promise<ClientResult<"hooks/delete">>;
	testModelConnection(input: ClientParams<"model/testConnection">): Promise<ClientResult<"model/testConnection">>;
	getUsage(input: ClientParams<"usage/get">): Promise<ClientResult<"usage/get">>;
	createSchedule(input: ClientParams<"schedule/create">): Promise<ClientResult<"schedule/create">>;
	listSchedules(input?: ClientParams<"schedule/list">): Promise<ClientResult<"schedule/list">>;
	getSchedule(input: ClientParams<"schedule/get">): Promise<ClientResult<"schedule/get">>;
	updateSchedule(input: ClientParams<"schedule/update">): Promise<ClientResult<"schedule/update">>;
	pauseSchedule(input: ClientParams<"schedule/pause">): Promise<ClientResult<"schedule/pause">>;
	resumeSchedule(input: ClientParams<"schedule/resume">): Promise<ClientResult<"schedule/resume">>;
	deleteSchedule(input: ClientParams<"schedule/delete">): Promise<ClientResult<"schedule/delete">>;
	runScheduleNow(input: ClientParams<"schedule/run-now">): Promise<ClientResult<"schedule/run-now">>;
	listScheduleRuns(input: ClientParams<"schedule/run/list">): Promise<ClientResult<"schedule/run/list">>;
	getScheduleRun(input: ClientParams<"schedule/run/get">): Promise<ClientResult<"schedule/run/get">>;
	markScheduleRunRead(input: ClientParams<"schedule/run/mark-read">): Promise<ClientResult<"schedule/run/mark-read">>;
	subscribeSchedule(): Promise<ClientResult<"schedule/subscribe">>;
	unsubscribeSchedule(): Promise<ClientResult<"schedule/unsubscribe">>;
	setScheduleKeepAwake(enabled: boolean): Promise<void>;
	previewProjectDelete(
		input: ClientParams<"project/deletePreview">,
	): Promise<DesktopRpcOutcome<ClientResult<"project/deletePreview">>>;
	deleteProject(input: ClientParams<"project/delete">): Promise<DesktopRpcOutcome<ClientResult<"project/delete">>>;
	createSession(input: ClientParams<"session/create">): Promise<ClientResult<"session/create">>;
	renameSession(input: ClientParams<"session/rename">): Promise<ClientResult<"session/rename">>;
	forkSession(input: ClientParams<"session/fork">): Promise<ClientResult<"session/fork">>;
	deleteSession(input: ClientParams<"session/delete">): Promise<ClientResult<"session/delete">>;
	openSession(input: ClientParams<"session/open">): Promise<ClientResult<"session/subscribe">["snapshot"]>;
	markSessionRead(input: ClientParams<"session/markRead">): Promise<ClientResult<"session/markRead">>;
	readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">>;
	readSessionImage(input: ClientParams<"session/readImage">): Promise<ClientResult<"session/readImage">>;
	getSessionStatus(input: ClientParams<"session/status">): Promise<ClientResult<"session/status">>;
	compactSession(input: ClientParams<"session/compact">): Promise<ClientResult<"session/compact">>;
	setSessionGoal(input: ClientParams<"session/goal/set">): Promise<ClientResult<"session/goal/set">>;
	clearSessionGoal(input: ClientParams<"session/goal/clear">): Promise<ClientResult<"session/goal/clear">>;
	readSubagentItems(input: ClientParams<"subagent/readItems">): Promise<ClientResult<"subagent/readItems">>;
	interruptSubagent(input: ClientParams<"subagent/interrupt">): Promise<ClientResult<"subagent/interrupt">>;
	setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">>;
	setPermissionMode(
		input: ClientParams<"session/setPermissionMode">,
	): Promise<ClientResult<"session/setPermissionMode">>;
	listPermissionRules(input: ClientParams<"permission/rules/list">): Promise<ClientResult<"permission/rules/list">>;
	deletePermissionRule(
		input: ClientParams<"permission/rules/delete">,
	): Promise<ClientResult<"permission/rules/delete">>;
	clearPermissionRules(input: ClientParams<"permission/rules/clear">): Promise<ClientResult<"permission/rules/clear">>;
	setModel(input: ClientParams<"session/setModel">): Promise<ClientResult<"session/setModel">>;
	startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">>;
	steerTurn(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">>;
	queueTurn(input: ClientParams<"turn/queue">): Promise<ClientResult<"turn/queue">>;
	updateQueuedTurn(input: ClientParams<"turn/queue/update">): Promise<ClientResult<"turn/queue/update">>;
	deleteQueuedTurn(input: ClientParams<"turn/queue/delete">): Promise<ClientResult<"turn/queue/delete">>;
	sendQueuedTurn(input: ClientParams<"turn/queue/send">): Promise<ClientResult<"turn/queue/send">>;
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

export function validateCreateBrowserInput(value: unknown): DesktopCreateBrowserInput {
	const input = exactRecord(value, ["browserId"], "browser create input");
	return { browserId: browserId(input.browserId) };
}

export function validateCloseBrowserInput(value: unknown): DesktopCloseBrowserInput {
	const input = exactRecord(value, ["browserId"], "browser close input");
	return { browserId: browserId(input.browserId) };
}

export function validateBrowserControlInput(value: unknown): DesktopBrowserControlInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid browser control input");
	}
	const type = (value as { type?: unknown }).type;
	if (type === "navigate") {
		const input = exactRecord(value, ["type", "browserId", "url"], "browser navigate input");
		const url = browserText(input.url, "URL", 8_192);
		if (url.length === 0) throw new TypeError("Invalid browser URL");
		return { type, browserId: browserId(input.browserId), url };
	}
	if (type === "find") {
		const input = exactRecord(value, ["type", "browserId", "text", "forward", "findNext"], "browser find input");
		if (typeof input.forward !== "boolean" || typeof input.findNext !== "boolean") {
			throw new TypeError("Invalid browser find direction");
		}
		return {
			type,
			browserId: browserId(input.browserId),
			text: browserText(input.text, "find text", 2_048),
			forward: input.forward,
			findNext: input.findNext,
		};
	}
	if (type === "set-zoom") {
		const input = exactRecord(value, ["type", "browserId", "zoomPercent"], "browser zoom input");
		return {
			type,
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
		const input = exactRecord(value, ["type", "browserId"], "browser control input");
		return { type, browserId: browserId(input.browserId) };
	}
	if (type === "present") {
		const input = exactRecord(value, ["type", "browserId", "visible", "bounds"], "browser present input");
		const bounds = exactRecord(input.bounds, ["x", "y", "width", "height"], "browser bounds");
		if (typeof input.visible !== "boolean") throw new TypeError("Invalid browser visibility");
		return {
			type,
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
			["browserId", "url", "title", "faviconUrl", "loading", "canGoBack", "canGoForward", "zoomPercent"],
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
	throw new TypeError("Invalid browser event");
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
		return {
			type: "app-server",
			envelope: Object.hasOwn(envelope, "id")
				? validateServerRequest(envelope)
				: validateServerNotification(envelope),
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
