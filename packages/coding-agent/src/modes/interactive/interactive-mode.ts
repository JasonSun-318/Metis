/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@metis/agent-core";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	OAuthProviderId,
	OAuthSelectPrompt,
} from "@metis/ai/compat";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@metis/tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@metis/tui";
import chalk from "chalk";
import { spawn } from "child_process";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	getMetisEnv,
	VERSION,
} from "../../config.ts";
import { type AgentMode, isAgentMode } from "../../core/agent-mode.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import {
	CACHE_TTL_MS,
	type CacheMiss,
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
} from "../../core/cache-stats.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	ProjectTrustContext,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { resolveMcpServerSettings } from "../../core/mcp/config.ts";
import type { McpServerStatus } from "../../core/mcp/manager.ts";
import type { MemoryExtractRun } from "../../core/memory/memory-types.ts";
import { createCompactionSummaryMessage } from "../../core/messages.ts";
import { defaultModelPerProvider, findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import {
	formatPermissionApproval,
	type PermissionApprovalDecision,
	type PermissionApprovalRequest,
} from "../../core/permission-policy.ts";
import { parseCommandArgs } from "../../core/prompt-templates.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { readScheduledSessionView } from "../../core/schedules/executor.ts";
import type { ScheduleManager } from "../../core/schedules/manager.ts";
import { validateScheduleInputSpec } from "../../core/schedules/time.ts";
import { resolveScheduleCreateTarget } from "../../core/schedules/tool.ts";
import type { ScheduleInputSpec, ScheduleRun, ScheduleTask } from "../../core/schedules/types.ts";
import {
	formatSessionAttachment,
	formatSessionAttachmentDisplayText,
	importSessionAttachments,
	MAX_SESSION_ATTACHMENTS,
	removeSessionAttachment,
	replaceSessionAttachmentReferences,
	type SessionAttachment,
} from "../../core/session-attachments.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import {
	getDefaultSessionDir,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "../../core/session-manager.ts";
import type {
	McpHttpServerSettings,
	McpServerSettings,
	McpStdioServerSettings,
	SettingsScope,
} from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import {
	WEB_SEARCH_PROVIDER_INFO,
	webSearchCredentialId,
	webSearchProviderFromCredentialId,
} from "../../core/web-search-config.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import { readClipboardImage } from "../../utils/clipboard-image.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { processImage } from "../../utils/image-process.ts";
import { canonicalizePath, getCwdRelativePath, isPathInside, resolvePath } from "../../utils/paths.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent, formatTokens } from "./components/footer.ts";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import { PermissionsSelectorComponent } from "./components/permissions-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { getModelSearchText } from "./model-search.ts";
import {
	findLoginProviderOptions,
	formatLoginProviderCompletionDescription,
	getLoginProviderCompletionOptions,
	getLoginProviderSearchText,
	listLoginProviderOptions,
	listLogoutProviderOptions,
} from "./provider-auth-options.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

const COMPACTION_SAFE_COMMANDS = new Set(["copy", "session", "hotkeys", "dream", "dirs", "quit", "debug"]);
const COMPACTION_WARNING =
	"Compact/Memory extract is running. Wait for it to finish, then run the command again. Press Esc to cancel.";

function formatMemoryExtractDuration(durationMs: number): string {
	return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function formatMemoryExtractHistoryLine(record: MemoryExtractRun): string {
	const symbol = record.status === "success" ? "✓" : record.status === "failed" ? "✗" : "–";
	const reason = record.reason ? ` · ${record.reason.slice(0, 160)}` : "";
	return `${record.startedAt} · ${record.trigger} · ${symbol} ${record.status}${reason}`;
}

const SCHEDULE_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function formatScheduleSpec(schedule: ScheduleTask["schedule"]): string {
	switch (schedule.kind) {
		case "once":
			return `${schedule.date} ${schedule.time}`;
		case "daily":
			return `Daily at ${schedule.time}`;
		case "weekly":
			return `Weekly on ${schedule.weekdays.map((day) => SCHEDULE_WEEKDAYS[day - 1]).join(", ")} at ${schedule.time}`;
		case "monthly":
			return `Monthly on day ${schedule.day} at ${schedule.time}`;
		case "interval": {
			const unit =
				schedule.unit === "minute"
					? schedule.every === 1
						? "minute"
						: "minutes"
					: schedule.every === 1
						? "hour"
						: "hours";
			return `Every ${schedule.every} ${unit} from ${schedule.startAt}`;
		}
	}
}

function formatScheduleTaskStatus(status: ScheduleTask["status"]): string {
	switch (status) {
		case "active":
			return "Active";
		case "paused":
			return "Paused";
		case "completed":
			return "Completed";
		case "deleting":
			return "Deleting";
	}
}

function formatScheduleRunStatus(status: ScheduleRun["status"]): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "running":
			return "Running";
		case "succeeded":
			return "Succeeded";
		case "failed":
			return "Failed";
		case "missed":
			return "Missed";
		case "skipped":
			return "Skipped";
		case "cancelled":
			return "Cancelled";
	}
}

function formatScheduleRunReason(reason: NonNullable<ScheduleRun["reason"]>): string {
	switch (reason) {
		case "overlap":
			return "Another execution was already running";
		case "offline":
			return "The scheduler was offline";
		case "interrupted":
			return "Execution was interrupted";
		case "deleted":
			return "The task was deleted";
	}
}

type ScheduleDisplayMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;

function scheduleMessageText(message: ScheduleDisplayMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

type InteractiveUserInput = {
	text: string;
	images?: ImageContent[];
};

type PendingFileAttachment = {
	attachment: SessionAttachment;
	sessionId: string;
};

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" }>;

const CLIPBOARD_IMAGE_PLACEHOLDER_REGEX = /\[image(\d+)\]/g;
const CLIPBOARD_IMAGE_PLACEHOLDER_SINGLE = /^\[image(\d+)\]$/;
const FILE_ATTACHMENT_PLACEHOLDER_REGEX = /\[file(\d+):[^\]]+\]/g;
const FILE_ATTACHMENT_PLACEHOLDER_SINGLE = /^\[file(\d+):[^\]]+\]$/;

function clipboardImagePlaceholder(id: number): string {
	return `[image${id}]`;
}

function fileAttachmentPlaceholder(id: number, name: string): string {
	return `[file${id}:${name}]`;
}

function parsePastedPathList(value: string): string[] | undefined {
	const paths: string[] = [];
	let path = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		if (process.platform !== "win32" && character === "\\" && quote !== "'") {
			const escaped = value[++index];
			if (escaped === undefined) return undefined;
			path += escaped;
		} else if (quote) {
			if (character === quote) quote = undefined;
			else path += character;
		} else if (character === "'" || character === '"') {
			quote = character;
		} else if (/\s/.test(character)) {
			if (path) {
				paths.push(path);
				path = "";
			}
		} else {
			path += character;
		}
	}
	if (quote) return undefined;
	if (path) paths.push(path);
	return paths.length > 0 ? paths : undefined;
}

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Shared scheduled-task manager owned by the CLI host. */
	scheduleManager?: ScheduleManager;
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .metis directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private loadedResourcesContainer: Container;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (input: InteractiveUserInput) => void;
	private pendingUserInputs: InteractiveUserInput[] = [];
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	private readonly idleStatus = new IdleStatus();
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private pendingClipboardImages = new Map<number, ImageContent>();
	private clipboardImageCounter = 0;
	private pendingFileAttachments = new Map<number, PendingFileAttachment>();
	private fileAttachmentCounter = 0;

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;
	private outputPad = 1;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private scheduleUnsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();
	private permissionApprovalAbortController?: AbortController;

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.permissionApprovalAbortController?.abort();
			this.cleanupClipboardAttachments();
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async (session) => {
			this.bindPermissionApproval(session);
			await this.rebindCurrentSession({ renderBeforeBind: true });
		});
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(
			this.ui,
			this.settingsManager,
			(message) => this.showError(message),
			() => this.updateEditorBorderColor(),
		);
		this.bindPermissionApproval(this.session);
	}

	private bindPermissionApproval(session: AgentSession): void {
		session.setPermissionApprovalHandler((request) => this.requestPermissionApproval(session, request));
	}

	private async requestPermissionApproval(
		session: AgentSession,
		request: PermissionApprovalRequest,
	): Promise<PermissionApprovalDecision> {
		if (session !== this.session || request.signal?.aborted) throw new Error("The session changed before approval");
		const controller = new AbortController();
		this.permissionApprovalAbortController = controller;
		try {
			const view = formatPermissionApproval(request);
			const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
			const choice = await this.showExtensionSelector(
				`${view.title}\n${view.summary}\n${view.details}`,
				["Allow once", "Deny"],
				{ signal },
			);
			if (choice === "Allow once") return { decision: "allow" };
			if (choice === "Deny") return { decision: "deny", reason: "Denied by the user" };
			throw new Error("The approval dialog closed without a decision");
		} finally {
			if (this.permissionApprovalAbortController === controller) {
				this.permissionApprovalAbortController = undefined;
			}
		}
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = getBuiltinSlashCommands(this.sessionManager.getMode()).map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const loginCommand = slashCommands.find((command) => command.name === "login");
		if (loginCommand) {
			loginCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const providers = getLoginProviderCompletionOptions(this.getLoginProviderOptions());
				return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
					value: provider.id,
					label: provider.id,
					description: formatLoginProviderCompletionDescription(provider),
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Resolve verified bundled helpers (macOS/Windows) or system dependencies (Linux).
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands.
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Add header container as first child. Populate it after applying theme settings.
		// Keep loaded resources before chat so restored session messages never precede them.
		this.ui.addChild(this.headerContainer);
		this.ui.addChild(this.loadedResourcesContainer);

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;
		if (this.options.scheduleManager) {
			try {
				this.scheduleUnsubscribe = this.options.scheduleManager.subscribe((event) => {
					if (event.type !== "schedule/run-updated" || !event.run.unread) return;
					const label =
						event.run.status === "succeeded"
							? "completed"
							: event.run.status === "failed"
								? `failed: ${event.run.error?.message ?? "Unknown error"}`
								: event.run.status === "missed"
									? `missed: ${event.run.reason ? formatScheduleRunReason(event.run.reason) : "The scheduled time was missed"}`
									: event.run.status === "skipped"
										? `skipped: ${event.run.reason ? formatScheduleRunReason(event.run.reason) : "Another execution is running"}`
										: undefined;
					if (label)
						this.showStatus(`Scheduled task “${event.task.title}” ${label} (${event.task.unreadCount} unread)`);
				});
			} catch (error) {
				this.showWarning(error instanceof Error ? error.message : String(error));
			}
		}

		await this.themeController.applyFromSettings();

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image, file, or text"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
			);
			const onboarding = theme.fg(
				"dim",
				`Metis can explain its own features and look up its docs. Ask it how to use or extend Metis.`,
			);
			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
				() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput.text, { images: userInput.images });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (getMetisEnv("OFFLINE")) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Metis works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(this.restoreAttachmentMarkers(result.selectedText ?? ""));
							this.syncClipboardMarkers();
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(this.restoreAttachmentMarkers(result.editorText));
						this.syncClipboardMarkers();
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
	}

	private applyRuntimeSettings(): void {
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();
		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
			await this.bindCurrentSessionExtensions();
		} else {
			await this.bindCurrentSessionExtensions();
			this.subscribeToAgent();
		}
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					if (this.guardCompactionMutation()) return true;
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.statusContainer.clear();
		this.statusContainer.addChild(indicator);
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const hadActiveStatusIndicator = this.activeStatusIndicator !== undefined;
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.statusContainer.clear();
		if (hadActiveStatusIndicator && this.ui.getClearOnShrink()) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			this.showStatusIndicator(
				new WorkingStatusIndicator(
					this.ui,
					this.workingMessage ?? this.defaultWorkingMessage,
					this.workingIndicatorOptions,
				),
			);
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setIndicator(options);
		}
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setMessage(
				`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
			);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.activeStatusIndicator?.kind === "working") {
					this.activeStatusIndicator.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions & { secret?: boolean },
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, secret: opts?.secret },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;
			newEditor.onPaste = this.defaultEditor.onPaste;
			newEditor.onAtomicMarkerDeleted = this.defaultEditor.onAtomicMarkerDeleted;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}
		this.syncClipboardMarkers();

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.copy", () => void this.handleCopyCommand());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};
		this.defaultEditor.onAtomicMarkerDeleted = (marker: string) => this.removeClipboardAttachment(marker);

		// Handle clipboard paste (triggered on Ctrl+V). Images and local file paths
		// are attached directly; other clipboard text is inserted normally.
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
		this.defaultEditor.onPaste = (text) => this.attachPastedFiles(text);
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (image) {
				if (this.session.model && !this.session.model.input.includes("image")) {
					this.showWarning(
						`Current model ${this.session.model.id} does not support image input. Switch models first.`,
					);
					return;
				}
				const processed = await processImage(image.bytes, image.mimeType);
				if (!processed.ok) {
					this.showWarning(processed.message);
					return;
				}
				const imageId = ++this.clipboardImageCounter;
				this.pendingClipboardImages.set(imageId, {
					type: "image",
					data: processed.data,
					mimeType: processed.mimeType,
				});
				this.syncClipboardMarkers();
				this.editor.insertTextAtCursor?.(clipboardImagePlaceholder(imageId));
				this.ui.requestRender();
				return;
			}

			const text = await readClipboardText();
			if (text) {
				if (this.attachPastedFiles(text)) return;
				this.editor.insertTextAtCursor?.(text);
				this.ui.requestRender();
			}
		} catch {}
	}

	private takeClipboardInput(text: string): InteractiveUserInput {
		const images: ImageContent[] = [];
		const attachedIds = new Set<number>();
		let promptText = text.replace(CLIPBOARD_IMAGE_PLACEHOLDER_REGEX, (_placeholder, idText: string) => {
			const id = Number.parseInt(idText, 10);
			const image = this.pendingClipboardImages.get(id);
			if (image && !attachedIds.has(id)) {
				images.push(image);
				attachedIds.add(id);
			}
			return "";
		});
		const referencedFiles = new Set<number>();
		promptText = promptText.replace(FILE_ATTACHMENT_PLACEHOLDER_REGEX, (_placeholder) => {
			const match = FILE_ATTACHMENT_PLACEHOLDER_SINGLE.exec(_placeholder);
			if (!match) return "";
			const id = Number.parseInt(match[1]!, 10);
			const pending = this.pendingFileAttachments.get(id);
			if (!pending || referencedFiles.has(id)) return "";
			referencedFiles.add(id);
			return formatSessionAttachment(pending.attachment);
		});
		for (const [id, pending] of this.pendingFileAttachments) {
			if (!referencedFiles.has(id)) {
				removeSessionAttachment(this.runtimeHost.services.agentDir, pending.sessionId, pending.attachment.path);
			}
		}
		this.pendingClipboardImages.clear();
		this.clipboardImageCounter = 0;
		this.pendingFileAttachments.clear();
		this.fileAttachmentCounter = 0;
		this.syncClipboardMarkers();
		return {
			text: promptText.trim(),
			images: images.length > 0 ? images : undefined,
		};
	}

	private removeClipboardAttachment(marker: string): void {
		if (this.editor.getText().includes(marker)) return;
		const imageMatch = CLIPBOARD_IMAGE_PLACEHOLDER_SINGLE.exec(marker);
		if (imageMatch) {
			this.pendingClipboardImages.delete(Number.parseInt(imageMatch[1]!, 10));
			if (this.pendingClipboardImages.size === 0) this.clipboardImageCounter = 0;
		}
		const fileMatch = FILE_ATTACHMENT_PLACEHOLDER_SINGLE.exec(marker);
		if (fileMatch) {
			const id = Number.parseInt(fileMatch[1]!, 10);
			const pending = this.pendingFileAttachments.get(id);
			if (pending) {
				removeSessionAttachment(this.runtimeHost.services.agentDir, pending.sessionId, pending.attachment.path);
				this.pendingFileAttachments.delete(id);
			}
			if (this.pendingFileAttachments.size === 0) this.fileAttachmentCounter = 0;
		}
		this.syncClipboardMarkers();
	}

	private syncClipboardMarkers(): void {
		const markers = [
			...[...this.pendingClipboardImages.keys()].map(clipboardImagePlaceholder),
			...[...this.pendingFileAttachments.entries()].map(([id, pending]) =>
				fileAttachmentPlaceholder(id, pending.attachment.name),
			),
		];
		this.defaultEditor.setAtomicMarkers(markers);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAtomicMarkers?.(markers);
		}
	}

	private cleanupClipboardAttachments(): void {
		this.pendingClipboardImages.clear();
		this.clipboardImageCounter = 0;
		for (const pending of this.pendingFileAttachments.values()) {
			removeSessionAttachment(this.runtimeHost.services.agentDir, pending.sessionId, pending.attachment.path);
		}
		this.pendingFileAttachments.clear();
		this.fileAttachmentCounter = 0;
		this.syncClipboardMarkers();
	}

	private isAttachableFile(value: string): boolean {
		try {
			const metadata = fs.lstatSync(resolvePath(value, this.sessionManager.getCwd(), { trim: true }));
			return metadata.isFile() && !metadata.isSymbolicLink();
		} catch {
			return false;
		}
	}

	private droppedFilePaths(text: string): string[] | undefined {
		const directPaths = text
			.trim()
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (directPaths.length === 0 || directPaths.length > MAX_SESSION_ATTACHMENTS) return undefined;
		const normalizedPaths = directPaths.map((line) => {
			if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) {
				return line.slice(1, -1);
			}
			return process.platform === "win32" ? line : line.replace(/\\(.)/g, "$1");
		});
		if (normalizedPaths.every((filePath) => this.isAttachableFile(filePath))) return normalizedPaths;
		const parsedPaths = parsePastedPathList(text.trim());
		if (!parsedPaths || parsedPaths.length > MAX_SESSION_ATTACHMENTS) return undefined;
		return parsedPaths.every((filePath) => this.isAttachableFile(filePath)) ? parsedPaths : undefined;
	}

	private importFilePaths(paths: readonly string[]): SessionAttachment[] {
		return importSessionAttachments({
			agentDir: this.runtimeHost.services.agentDir,
			sessionId: this.sessionManager.getSessionId(),
			cwd: this.sessionManager.getCwd(),
			attachments: paths.map((filePath) => ({ path: filePath })),
		});
	}

	private attachFilePaths(paths: readonly string[]): void {
		if (this.pendingFileAttachments.size + paths.length > MAX_SESSION_ATTACHMENTS) {
			throw new Error(`Attachments are limited to ${MAX_SESSION_ATTACHMENTS} files per message`);
		}
		const sessionId = this.sessionManager.getSessionId();
		const markers = this.importFilePaths(paths).map((attachment) => {
			const id = ++this.fileAttachmentCounter;
			this.pendingFileAttachments.set(id, { attachment, sessionId });
			return fileAttachmentPlaceholder(id, attachment.name);
		});
		this.syncClipboardMarkers();
		this.editor.insertTextAtCursor?.(markers.join(" "));
		this.ui.requestRender();
	}

	private attachPastedFiles(text: string): boolean {
		const paths = this.droppedFilePaths(text);
		if (!paths) return false;
		try {
			this.attachFilePaths(paths);
		} catch (error) {
			this.showWarning(error instanceof Error ? error.message : String(error));
		}
		return true;
	}

	private routeCompactionInput(text: string, mode: "steer" | "followUp"): "not-compacting" | "handled" | "dispatch" {
		if (!this.session.isCompacting) return "not-compacting";
		if (text === "/memory" || (text.startsWith("/") && COMPACTION_SAFE_COMMANDS.has(text.slice(1)))) {
			return "dispatch";
		}

		const commandName = text.startsWith("/") ? text.slice(1).split(/\s+/, 1)[0] : undefined;
		const isBuiltIn = commandName ? BUILTIN_SLASH_COMMANDS.some((command) => command.name === commandName) : false;
		if (text.startsWith("!") || this.isExtensionCommand(text) || isBuiltIn) {
			this.showWarning(COMPACTION_WARNING);
			return "handled";
		}

		const input = this.takeClipboardInput(text);
		this.queueCompactionMessage(input.text, mode, input.images);
		return "handled";
	}

	private guardCompactionMutation(): boolean {
		if (!this.session.isCompacting) return false;
		this.showWarning(COMPACTION_WARNING);
		return true;
	}

	private guardSessionMutation(): boolean {
		if (this.guardCompactionMutation()) return true;
		if (!this.session.isStreaming) return false;
		this.showWarning("Wait for the current agent run to finish before changing the session");
		return true;
	}

	private getWorkspaceDirectoryCommandArgument(text: string, command: "/add-dir" | "/remove-dir"): string | undefined {
		if (!text.startsWith(`${command} `)) return undefined;
		const value = text.slice(command.length + 1).trim();
		if (!value) return undefined;
		const first = value[0];
		if ((first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1);
		return value;
	}

	private handleAddDirectoryCommand(inputPath: string | undefined): void {
		if (this.sessionManager.getMode() !== "code") {
			this.showWarning("Additional directories are only available in Code mode");
			return;
		}
		if (!inputPath) {
			this.showWarning("Usage: /add-dir <path>");
			return;
		}
		if (this.guardSessionMutation()) return;
		try {
			const result = this.sessionManager.addWorkspaceDirectory(inputPath);
			if (result.changed) this.session.refreshSystemPrompt();
			this.showStatus(
				result.changed
					? `Added working directory: ${result.path}`
					: `Working directory already added: ${result.path}`,
			);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleRemoveDirectoryCommand(inputPath: string | undefined): void {
		if (this.sessionManager.getMode() !== "code") {
			this.showWarning("Additional directories are only available in Code mode");
			return;
		}
		if (!inputPath) {
			this.showWarning("Usage: /remove-dir <path>");
			return;
		}
		if (this.guardSessionMutation()) return;
		try {
			const result = this.sessionManager.removeWorkspaceDirectory(inputPath);
			if (result.changed) this.session.refreshSystemPrompt();
			this.showStatus(
				result.changed
					? `Removed working directory: ${result.path}`
					: `Working directory was not added: ${result.path}`,
			);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleDirectoriesCommand(argument: string): void {
		if (this.sessionManager.getMode() !== "code") {
			this.showWarning("Additional directories are only available in Code mode");
			return;
		}
		if (argument) {
			this.showWarning("Usage: /dirs");
			return;
		}
		const [primary, ...additional] = this.sessionManager.getWorkspaceRoots();
		this.showStatus(
			["Working directories:", `- ${primary} (primary)`, ...additional.map((path) => `- ${path}`)].join("\n"),
		);
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;
			const compactionRoute = this.routeCompactionInput(text, "steer");
			if (compactionRoute === "handled") return;

			// Handle commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/permissions") {
				this.editor.setText("");
				this.showPermissionsSelector();
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text.startsWith("/login ")) {
				const providerRef = text.startsWith("/login ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleLoginCommand(providerRef);
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/add-dir" || text.startsWith("/add-dir ")) {
				const inputPath = this.getWorkspaceDirectoryCommandArgument(text, "/add-dir");
				this.editor.setText("");
				this.handleAddDirectoryCommand(inputPath);
				return;
			}
			if (text === "/remove-dir" || text.startsWith("/remove-dir ")) {
				const inputPath = this.getWorkspaceDirectoryCommandArgument(text, "/remove-dir");
				this.editor.setText("");
				this.handleRemoveDirectoryCommand(inputPath);
				return;
			}
			if (text === "/dirs" || text.startsWith("/dirs ")) {
				this.editor.setText("");
				this.handleDirectoriesCommand(text.slice("/dirs".length).trim());
				return;
			}
			if (text === "/new" || text.startsWith("/new ")) {
				this.editor.setText("");
				await this.handleNewSessionCommand(text);
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/memory" || text.startsWith("/memory ")) {
				const action = text.slice(7).trim();
				this.editor.setText("");
				this.handleMemoryCommand(action);
				return;
			}
			if (text === "/dream") {
				this.editor.setText("");
				this.handleDreamCommand();
				return;
			}
			if (text.startsWith("/dream ")) {
				this.showWarning("Usage: /dream");
				return;
			}
			if (text === "/schedule") {
				this.editor.setText("");
				await this.handleScheduleCommand();
				return;
			}
			if (text.startsWith("/schedule ")) {
				this.editor.setText("");
				this.showWarning("Usage: /schedule");
				return;
			}
			if (text === "/mcp") {
				this.editor.setText("");
				await this.handleMcpCommand();
				return;
			}
			if (text.startsWith("/mcp ")) {
				this.editor.setText("");
				this.showWarning("Use /mcp and choose an action from the menu.");
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.setText("");
				const input = this.takeClipboardInput(text);
				this.editor.addToHistory?.(formatSessionAttachmentDisplayText(input.text));
				await this.session.prompt(input.text, {
					streamingBehavior: "steer",
					images: input.images,
				});
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			const input = this.takeClipboardInput(text);
			if (this.onInputCallback) {
				this.onInputCallback(input);
			} else {
				this.pendingUserInputs.push(input);
			}
			this.editor.addToHistory?.(formatSessionAttachmentDisplayText(input.text));
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.workingVisible) {
					this.showStatusIndicator(
						new WorkingStatusIndicator(
							this.ui,
							this.workingMessage ?? this.defaultWorkingMessage,
							this.workingIndicatorOptions,
						),
					);
				} else {
					this.clearStatusIndicator();
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "entry_appended":
				if (event.entry.type === "custom") {
					this.addCustomEntryToChat(event.entry);
					this.ui.requestRender();
				}
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "thinking_selection_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
						this.maybeShowCacheMissNotice(this.streamingMessage);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				this.clearStatusIndicator("working");
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();

				this.ui.requestRender();
				break;

			case "agent_settled":
				await this.checkShutdownRequested();
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason));
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				this.clearStatusIndicator("compaction");
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.clearStatusIndicator("retry");
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return formatSessionAttachmentDisplayText(textBlocks.map((c) => (c as { text: string }).text).join(""));
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache-miss notices are not persisted; re-derive them from the full entry
		// list and re-inject them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRegistry)
			: new Map<AssistantMessage, CacheMiss>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom") {
				return [entry];
			}
			return sessionEntryToContextMessages(entry);
		});
		this.renderSessionItems(items, options);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRegistry);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		let label = "Cache miss";
		if (miss.modelChanged) {
			label = "Cache miss after model switch";
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		}
		const text = theme.fg("warning", `${label}: ${reBilled}`);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
	}

	renderInitialMessages(): void {
		const entries = this.sessionManager.buildContextEntries();
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart Metis.`,
				),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<InteractiveUserInput> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (input: InteractiveUserInput) => {
				this.onInputCallback = undefined;
				resolve(input);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		this.renderSessionEntries(this.sessionManager.buildContextEntries());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stop();
		const resumeCommand = formatResumeCommand(this.sessionManager);
		await this.runtimeHost.dispose();

		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		this.cleanupClipboardAttachments();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		this.cleanupClipboardAttachments();
		console.error("Metis exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in Metis) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		const compactionRoute = this.routeCompactionInput(text, "followUp");
		if (compactionRoute === "handled") return;
		if (compactionRoute === "dispatch") {
			await this.editor.onSubmit?.(text);
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.setText("");
			const input = this.takeClipboardInput(text);
			this.editor.addToHistory?.(formatSessionAttachmentDisplayText(input.text));
			await this.session.prompt(input.text, {
				streamingBehavior: "followUp",
				images: input.images,
			});
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.getThinkingSelection() === "ultra" ? "max" : this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		if (this.guardCompactionMutation()) return;
		const newLevel = this.session.cycleThinkingSelection();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(newLevel === "ultra" ? "Thinking: Ultra · multi-agent" : `Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		if (this.guardCompactionMutation()) return;
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			for (const child of container.children) {
				if (isExpandable(child)) {
					child.setExpanded(expanded);
				}
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set externalEditor in settings.json or $VISUAL/$EDITOR.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `metis-editor-${Date.now()}.metis.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.cleanupClipboardAttachments();
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update --extensions`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${formatSessionAttachmentDisplayText(message)}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${formatSessionAttachmentDisplayText(message)}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.map((message) => this.restoreAttachmentMarkers(message)).join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.syncClipboardMarkers();
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private restoreAttachmentMarkers(text: string): string {
		const sessionId = this.sessionManager.getSessionId();
		return replaceSessionAttachmentReferences(text, (attachments) =>
			attachments
				.map((attachment) => {
					const id = ++this.fileAttachmentCounter;
					this.pendingFileAttachments.set(id, { attachment, sessionId });
					return fileAttachmentPlaceholder(id, attachment.name);
				})
				.join(" "),
		);
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.compactionQueuedMessages.push({ text, mode, images });
		this.editor.addToHistory?.(formatSessionAttachmentDisplayText(text));
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text, message.images);
					} else {
						await this.session.steer(message.text, message.images);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text, { images: firstPrompt.images }).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text, message.images);
				} else {
					await this.session.steer(message.text, message.images);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		if (this.guardCompactionMutation()) return;
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingSelection: this.session.getThinkingSelection(),
					availableThinkingSelections: this.session.getAvailableThinkingSelections(),
					currentTheme: this.settingsManager.getThemeSetting() || "dark",
					terminalTheme: this.themeController.getTerminalTheme(),
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					enableProviderAttribution: this.settingsManager.getEnableProviderAttribution(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					outputPad: this.settingsManager.getOutputPad(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					webSearchEnabled: this.settingsManager.getWebSearchSettings().enabled,
					webSearchProvider: this.settingsManager.getWebSearchSettings().provider,
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onThinkingSelectionChange: (selection) => {
						this.session.setThinkingSelection(selection);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeSetting) => {
						this.settingsManager.setTheme(themeSetting);
						void this.themeController.applyFromSettings();
					},
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onShowCacheMissNoticesChange: (shown) => {
						this.settingsManager.setShowCacheMissNotices(shown);
						this.rebuildChatFromMessages();
					},
					onEnableProviderAttributionChange: (enabled) => {
						this.settingsManager.setEnableProviderAttribution(enabled);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onOutputPadChange: (padding) => {
						this.settingsManager.setOutputPad(padding);
						this.outputPad = padding;
						if (this.streamingComponent || this.session.isStreaming) {
							for (const child of this.chatContainer.children) {
								if (child instanceof AssistantMessageComponent || child instanceof UserMessageComponent) {
									child.setOutputPad(padding);
								}
							}
							if (this.streamingComponent) {
								this.streamingComponent.setOutputPad(padding);
							}
							this.ui.requestRender();
							return;
						}
						this.rebuildChatFromMessages();
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
						if (!enabled && !this.activeStatusIndicator) {
							this.statusContainer.clear();
						}
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onWebSearchEnabledChange: (enabled) => this.session.setWebSearchEnabled(enabled),
					onWebSearchProviderChange: (provider) => {
						void this.showApiKeyLoginDialog(
							webSearchCredentialId(provider),
							WEB_SEARCH_PROVIDER_INFO[provider].label,
							`Configure ${WEB_SEARCH_PROVIDER_INFO[provider].label}`,
						).then((saved) => {
							if (!saved) return;
							this.session.setWebSearchProvider(provider);
							this.session.setWebSearchEnabled(true);
						});
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private showPermissionsSelector(): void {
		if (this.guardSessionMutation()) return;
		this.showSelector((done) => {
			const selector = new PermissionsSelectorComponent(
				this.sessionManager.getPermissionSettings(),
				(settings) => {
					this.sessionManager.setPermissionSettings(settings);
					done();
					this.footer.invalidate();
					this.showStatus(`Permissions: ${settings.mode}`);
					this.ui.requestRender();
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private showTrustSelector(): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart Metis for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		if (this.guardCompactionMutation()) return;
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		if (this.guardCompactionMutation()) return;
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: formatSessionAttachmentDisplayText(m.text) })),
				async (entryId) => {
					done();
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.ui.requestRender();
							return;
						}

						this.editor.setText(this.restoreAttachmentMarkers(result.selectedText ?? ""));
						this.syncClipboardMarkers();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		if (this.guardCompactionMutation()) return;
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and status indicator if summarizing
					let showingSummaryIndicator = false;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
						showingSummaryIndicator = true;
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(this.restoreAttachmentMarkers(result.editorText));
							this.syncClipboardMarkers();
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (showingSummaryIndicator) {
							this.clearStatusIndicator("branchSummary");
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			selector.onCopy = async (text) => {
				if (!text) {
					this.showError("Selected entry has no text to copy");
					return;
				}
				try {
					await copyToClipboard(text);
					this.showStatus("Copied selected message to clipboard");
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		if (this.guardCompactionMutation()) return;
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				(onProgress) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						if (SessionManager.isScheduledSession(sessionFilePath)) {
							this.showWarning("Scheduled execution sessions are read-only");
							return;
						}
						const currentPath = this.sessionManager.getSessionFile();
						if (currentPath && canonicalizePath(currentPath) === canonicalizePath(sessionFilePath)) {
							this.sessionManager.appendSessionInfo(next);
							return;
						}

						const mgr = SessionManager.open(sessionFilePath);
						try {
							mgr.appendSessionInfo(next);
						} finally {
							mgr.close();
						}
					},
					showRenameHint: true,
					keybindings: this.keybindings,
					agentDir: this.runtimeHost.services.agentDir,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.clearStatusIndicator();
		try {
			if (SessionManager.isScheduledSession(sessionPath)) {
				const view = readScheduledSessionView(sessionPath);
				await this.showExtensionSelector(
					`Scheduled execution\nTask instructions: ${view.instruction}\n\nResult:\n${view.result}`,
					[],
				);
				return { cancelled: false };
			}
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: AuthSelectorProvider["authType"]): AuthSelectorProvider[] {
		return listLoginProviderOptions(this.session.modelRegistry, authType);
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		return listLogoutProviderOptions(this.session.modelRegistry);
	}

	private findLoginProviderOptions(providerRef: string): AuthSelectorProvider[] {
		return findLoginProviderOptions(this.session.modelRegistry, providerRef);
	}

	private async handleLoginCommand(providerRef?: string): Promise<void> {
		if (!providerRef) {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.findLoginProviderOptions(providerRef);
		if (providerOptions.length === 1) {
			await this.startProviderLogin(providerOptions[0]!);
			return;
		}

		if (providerOptions.length > 1) {
			const providerIds = new Set(providerOptions.map((provider) => provider.id));
			if (providerIds.size === 1) {
				this.showLoginAuthTypeSelector(providerOptions);
				return;
			}
		}

		this.showLoginProviderSelector(undefined, providerRef);
	}

	private async startProviderLogin(providerOption: AuthSelectorProvider): Promise<void> {
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name);
		} else {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
		}
	}

	private showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		const availableAuthTypes = providerOptions
			? new Set(providerOptions.map((provider) => provider.authType))
			: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
		const options: string[] = [];
		if (availableAuthTypes.has("oauth")) {
			options.push(subscriptionLabel);
		}
		if (availableAuthTypes.has("api_key")) {
			options.push(apiKeyLabel);
		}

		if (options.length === 0) {
			this.showStatus("No login methods available.");
			return;
		}

		if (providerOptions && options.length === 1) {
			const providerOption = providerOptions[0];
			if (providerOption) {
				void this.startProviderLogin(providerOption);
			}
			return;
		}

		const title = providerOptions?.[0]
			? `Select authentication method for ${providerOptions[0].name}:`
			: "Select authentication method:";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					if (providerOptions) {
						const providerOption = providerOptions.find((provider) => provider.authType === authType);
						if (providerOption) {
							void this.startProviderLogin(providerOption);
						}
						return;
					}
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType?: AuthSelectorProvider["authType"], initialSearchInput?: string): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			const message =
				authType === "oauth"
					? "No subscription providers available."
					: authType === "api_key"
						? "No API key providers available."
						: "No login providers available.";
			this.showStatus(message);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId, selectedAuthType) => {
					done();

					const providerOption = providerOptions.find(
						(provider) => provider.id === providerId && provider.authType === selectedAuthType,
					);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption);
				},
				() => {
					done();
					if (authType) {
						this.showLoginAuthTypeSelector();
					} else {
						this.ui.requestRender();
					}
				},
				(providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						const searchProvider = webSearchProviderFromCredentialId(providerOption.id);
						if (searchProvider) {
							this.showStatus(`Removed stored API key for ${WEB_SEARCH_PROVIDER_INFO[searchProvider].label}.`);
							return;
						}
						this.session.modelRegistry.refresh();
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
			}
		}
	}

	private async showApiKeyLoginDialog(
		providerId: string,
		providerName: string,
		titleOverride?: string,
	): Promise<boolean> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
			titleOverride,
		);

		if (providerId === "amazon-bedrock") {
			dialog.showDetails([
				theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
				theme.fg("muted", "See:"),
				theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
			]);
		}

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:", undefined, { secret: true })).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
			const searchProvider = webSearchProviderFromCredentialId(providerId);
			if (searchProvider) {
				restoreEditor();
				this.showStatus(
					`Saved API key for ${WEB_SEARCH_PROVIDER_INFO[searchProvider].label}. Credentials saved to ${getAuthPath()}`,
				);
				return true;
			}

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
			return true;
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
			return false;
		}
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			dialog.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onDeviceCode: (info) => {
					dialog.showDeviceCode(info);
					dialog.showWaiting("Waiting for authentication...");
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private handleMemoryCommand(action: string): void {
		if (action && action !== "on" && action !== "off") {
			this.showWarning("Usage: /memory [on|off]");
			return;
		}

		if (action) {
			const enabled = action === "on";
			this.settingsManager.setAutoMemoryEnabled(enabled);
			this.session.refreshSystemPrompt();
			this.showStatus(`Long-term memory ${enabled ? "enabled" : "disabled"}`);
			return;
		}

		const snapshot = this.session.getAutoMemorySnapshot();
		if (!snapshot) {
			this.showWarning("Long-term memory is unavailable because the agent directory is not configured.");
			return;
		}

		const state = (index: (typeof snapshot)["global"]): string => {
			if (index.error) return theme.fg("warning", `unavailable: ${index.error}`);
			if (!index.exists) return theme.fg("muted", "not created");
			return index.truncated ? theme.fg("warning", "loaded (truncated)") : theme.fg("success", "loaded");
		};
		let info = `${theme.bold("Long-term memory")} ${
			this.settingsManager.getAutoMemoryEnabled() ? theme.fg("success", "on") : theme.fg("muted", "off")
		}\n`;
		info += `${theme.fg("dim", "Global:")} ${snapshot.global.indexPath} ${state(snapshot.global)}\n`;
		info += `${theme.fg("dim", "Project:")} ${snapshot.project.indexPath} ${state(snapshot.project)}\n`;
		info += theme.fg("dim", "Use /reload after editing an index outside Metis.");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleDreamCommand(): void {
		const snapshot = this.session.getMemoryExtractStatus(10);
		const lines = [
			`${theme.bold("Memory extract")} ${snapshot.enabled ? theme.fg("success", "on") : theme.fg("muted", "off")}`,
		];
		if (snapshot.active) {
			const elapsed = Math.max(0, Date.now() - new Date(snapshot.active.startedAt).getTime());
			lines.push(
				`${theme.fg("warning", "running")} · ${snapshot.active.extractMode} · ${snapshot.active.trigger} · ${formatMemoryExtractDuration(elapsed)} · ${snapshot.active.cwd}`,
			);
		} else {
			lines.push(theme.fg("dim", "idle"));
		}
		lines.push("", theme.bold("Recent runs"));
		if (snapshot.recent.length === 0) lines.push(theme.fg("dim", "No extract history yet"));
		else for (const record of snapshot.recent) lines.push(formatMemoryExtractHistoryLine(record));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private getMcpDefinition(name: string): { scope: SettingsScope; server: McpServerSettings } | undefined {
		const project = this.settingsManager.getProjectSettings().mcpServers?.[name];
		if (project) return { scope: "project", server: project };
		const global = this.settingsManager.getGlobalSettings().mcpServers?.[name];
		return global ? { scope: "global", server: global } : undefined;
	}

	private async persistMcpDefinition(
		scope: SettingsScope,
		name: string,
		server: McpServerSettings,
		reload = true,
	): Promise<void> {
		resolveMcpServerSettings(name, server, process.cwd(), process.env);
		this.settingsManager.setMcpServer(scope, name, server);
		await this.settingsManager.flush();
		const errors = this.settingsManager.drainErrors();
		if (errors.length > 0) throw errors[0]!.error;
		if (reload) await this.session.reload();
	}

	private mcpStatusRow(status: McpServerStatus): string {
		return `${status.name} · ${status.state} · ${status.transport} · ${status.toolCount} tools`;
	}

	private showMcpDetails(status: McpServerStatus): void {
		const lines = [
			theme.bold(status.name),
			`${status.state} · ${status.transport} · ${status.toolCount} tools · ${status.resourceCount} resources · ${status.resourceTemplateCount} resource templates · ${status.promptCount} prompts`,
		];
		if (status.serverInfo) lines.push(`${status.serverInfo.name}/${status.serverInfo.version}`);
		if (status.capabilities.length > 0) lines.push(`Capabilities: ${status.capabilities.join(", ")}`);
		if (status.lastError) lines.push(theme.fg("error", status.lastError));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private async askScheduleValue(title: string, pattern: RegExp, hint: string): Promise<string | undefined> {
		while (true) {
			const value = (await this.showExtensionInput(`${title}\n${hint}`))?.trim();
			if (value === undefined) return undefined;
			if (pattern.test(value)) return value;
			this.showWarning(`Invalid format: ${hint}`);
		}
	}

	private async askScheduleSpec(): Promise<ScheduleInputSpec | undefined> {
		const recurrence = await this.showExtensionSelector("Recurrence", [
			"Once",
			"Daily",
			"Weekly",
			"Monthly",
			"Interval",
		]);
		if (!recurrence) return undefined;
		const askTime = () =>
			this.askScheduleValue("Run time", /^(?:[01]\d|2[0-3]):[0-5]\d$/, "Enter HH:mm, for example 09:30");
		let schedule: ScheduleInputSpec | undefined;
		if (recurrence === "Once") {
			const date = await this.askScheduleValue("Run date", /^\d{4}-\d{2}-\d{2}$/, "Enter YYYY-MM-DD");
			if (!date) return undefined;
			const time = await askTime();
			if (!time) return undefined;
			schedule = { kind: "once", date, time };
		} else if (recurrence === "Daily") {
			const time = await askTime();
			if (!time) return undefined;
			schedule = { kind: "daily", time };
		} else if (recurrence === "Weekly") {
			const selected = new Set<number>();
			while (true) {
				const remaining = SCHEDULE_WEEKDAYS.map((label, index) => ({ label, day: index + 1 })).filter(
					({ day }) => !selected.has(day),
				);
				const choice = await this.showExtensionSelector(
					`Select weekdays${selected.size ? ` (selected: ${[...selected].map((day) => SCHEDULE_WEEKDAYS[day - 1]).join(", ")})` : ""}`,
					[...remaining.map(({ label }) => label), ...(selected.size ? ["Done"] : [])],
				);
				if (!choice) return undefined;
				if (choice === "Done") break;
				const day = remaining.find(({ label }) => label === choice)?.day;
				if (day) selected.add(day);
			}
			const time = await askTime();
			if (!time) return undefined;
			schedule = { kind: "weekly", weekdays: [...selected].sort((a, b) => a - b), time };
		} else if (recurrence === "Monthly") {
			const value = await this.askScheduleValue(
				"Day of month",
				/^(?:[1-9]|[12]\d|3[01])$/,
				"Enter an integer from 1 to 31",
			);
			if (!value) return undefined;
			const time = await askTime();
			if (!time) return undefined;
			schedule = { kind: "monthly", day: Number(value), time };
		} else {
			const value = await this.askScheduleValue(
				"Run interval",
				/^(?:[1-9]\d{0,3}|10000)$/,
				"Enter an integer from 1 to 10000",
			);
			if (!value || Number(value) > 10_000) return undefined;
			const unit = await this.showExtensionSelector("Interval unit", ["Minutes", "Hours"]);
			if (!unit) return undefined;
			const startDate = await this.askScheduleValue("Start date", /^\d{4}-\d{2}-\d{2}$/, "Enter YYYY-MM-DD");
			if (!startDate) return undefined;
			const startTime = await askTime();
			if (!startTime) return undefined;
			schedule = {
				kind: "interval",
				every: Number(value),
				unit: unit === "Minutes" ? "minute" : "hour",
				startDate,
				startTime,
			};
		}
		try {
			return validateScheduleInputSpec(schedule);
		} catch (error) {
			this.showWarning(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}

	private async createScheduleTask(manager: ScheduleManager): Promise<void> {
		const name = (await this.showExtensionInput("Task name"))?.trim();
		if (!name) return;
		const description = (await this.showExtensionInput("Description (optional)"))?.trim() || undefined;
		const instruction = (await this.showExtensionEditor("Task instructions"))?.trim();
		if (!instruction) return;
		const schedule = await this.askScheduleSpec();
		if (!schedule) return;
		const model = this.session.model;
		if (!model) {
			this.showWarning("Configure a model before creating a scheduled task");
			return;
		}
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const target = resolveScheduleCreateTarget({
			mode: this.sessionManager.getMode(),
			cwdOrigin: this.sessionManager.getCwdOrigin(),
			cwd: this.sessionManager.getCwd(),
		});
		if (!target) {
			this.showWarning("Scheduled tasks are only available in Chat mode");
			return;
		}
		const confirmation = await this.showExtensionSelector(
			`Create task\nName: ${name}\nInstructions: ${instruction}\nModel: ${model.provider}/${model.id}\nSchedule: ${formatScheduleSpec(
				schedule.kind === "interval"
					? { ...schedule, startAt: `${schedule.startDate} ${schedule.startTime}` }
					: schedule,
			)}\nTime zone: ${timezone}\nExecution directory: ${target.workspace === "fixed" ? target.cwd : "task default directory"}`,
			["Create"],
		);
		if (confirmation !== "Create") return;
		const task = await manager.create({
			id: randomUUID(),
			name,
			description,
			instruction,
			model: { provider: model.provider, modelId: model.id },
			schedule,
			timezone,
			target,
		});
		this.showStatus(`Created scheduled task “${task.title}”. Next run: ${task.nextRunAt ?? "none"}`);
	}

	private async showScheduleRun(manager: ScheduleManager, task: ScheduleTask, run: ScheduleRun): Promise<void> {
		if (run.unread) run = await manager.markRunRead(task.id, run.id);
		let result =
			run.resultPreview ??
			run.error?.message ??
			(run.reason ? formatScheduleRunReason(run.reason) : undefined) ??
			"No result";
		if (run.sessionFile) {
			try {
				const sessionFile = fs.realpathSync(run.sessionFile);
				const sessionRoot = fs.realpathSync(getDefaultSessionDir(task.target.cwd, manager.agentDir));
				if (!isPathInside(sessionRoot, sessionFile))
					throw new Error("Scheduled session is outside its task directory");
				const session = SessionManager.openReadOnly(sessionFile);
				const marker = session.getHeader()?.scheduled;
				if (marker?.taskId !== task.id || marker.runId !== run.id) {
					throw new Error("Scheduled session identity does not match its run");
				}
				const assistant = session
					.getBranch()
					.flatMap(sessionEntryToContextMessages)
					.filter((message) => message.role === "assistant")
					.at(-1);
				if (assistant) result = scheduleMessageText(assistant);
			} catch {
				// The run summary remains useful if its immutable session cannot be opened.
			}
		}
		await this.showExtensionSelector(
			`Execution result · ${task.title}\nTask instructions: ${run.snapshot.instruction}\nStatus: ${formatScheduleRunStatus(run.status)}\nTime: ${run.completedAt ?? run.createdAt}\n\nResult:\n${result}`,
			[],
		);
	}

	private async showScheduleRuns(manager: ScheduleManager, task: ScheduleTask): Promise<void> {
		let beforeRunId: string | undefined;
		while (true) {
			const page = await manager.listRuns(task.id, { beforeRunId, limit: 20 });
			const labels = new Map<string, ScheduleRun>();
			for (const [index, run] of page.runs.entries()) {
				labels.set(
					`${index + 1}. ${run.unread ? "● " : ""}${formatScheduleRunStatus(run.status)} · ${run.completedAt ?? run.createdAt}`,
					run,
				);
			}
			const choice = await this.showExtensionSelector(`Execution history · ${task.title}`, [
				...labels.keys(),
				...(page.nextBeforeRunId ? ["Next page"] : []),
			]);
			if (!choice) return;
			if (choice === "Next page") {
				beforeRunId = page.nextBeforeRunId ?? undefined;
				continue;
			}
			const run = labels.get(choice);
			if (run) await this.showScheduleRun(manager, task, run);
		}
	}

	private async showScheduleTask(manager: ScheduleManager, taskId: string): Promise<void> {
		while (true) {
			const task = await manager.get(taskId);
			const editable = task.status !== "completed" && task.status !== "deleting";
			const statusAction = task.status === "paused" ? "Resume" : task.status === "active" ? "Pause" : undefined;
			const action = await this.showExtensionSelector(
				`${task.title}\nInstructions: ${task.instruction}\nSchedule: ${formatScheduleSpec(task.schedule)}\nStatus: ${formatScheduleTaskStatus(task.status)}\nNext run: ${task.nextRunAt ?? "none"}`,
				[
					"View execution history",
					...(editable ? ["Edit instructions", "Edit schedule"] : []),
					...(statusAction ? [statusAction] : []),
					"Run now",
					"Delete",
				],
			);
			if (!action) return;
			if (action === "View execution history") {
				await this.showScheduleRuns(manager, task);
			} else if (action === "Edit instructions") {
				const instruction = (await this.showExtensionEditor("Task instructions", task.instruction))?.trim();
				if (instruction) await manager.update(task.id, { instruction });
			} else if (action === "Edit schedule") {
				const schedule = await this.askScheduleSpec();
				if (schedule) await manager.update(task.id, { schedule });
			} else if (action === "Pause") {
				await manager.pause(task.id);
			} else if (action === "Resume") {
				await manager.resume(task.id);
			} else if (action === "Run now") {
				await manager.runNow(task.id, randomUUID());
				this.showStatus(`Scheduled task “${task.title}” was queued to run`);
			} else if (action === "Delete") {
				const choice = await this.showExtensionSelector(
					`Delete “${task.title}”?\nThe task-owned directory is always removed. A user-selected project is never changed.`,
					["Delete task only", "Delete task and generated sessions"],
				);
				if (choice) {
					await manager.delete(task.id, { deleteSessions: choice === "Delete task and generated sessions" });
					this.showStatus(`Deleted scheduled task “${task.title}”`);
					return;
				}
			}
		}
	}

	private async showScheduleTasks(manager: ScheduleManager): Promise<void> {
		let afterTaskId: string | undefined;
		while (true) {
			const page = await manager.list({ afterTaskId, limit: 50 });
			const labels = new Map<string, string>();
			for (const [index, task] of page.tasks.entries()) {
				const label = `${index + 1}. ${task.unreadCount ? `●${task.unreadCount} ` : ""}${task.title} · ${formatScheduleTaskStatus(task.status)} · ${formatScheduleSpec(task.schedule)} · ${task.nextRunAt ?? "No next run"}`;
				labels.set(label, task.id);
			}
			const choice = await this.showExtensionSelector(
				labels.size ? "Scheduled tasks" : "Scheduled tasks\nNo scheduled tasks",
				[...labels.keys(), ...(page.nextAfterTaskId ? ["Next page"] : [])],
			);
			if (!choice) return;
			if (choice === "Next page") {
				afterTaskId = page.nextAfterTaskId ?? undefined;
				continue;
			}
			const taskId = labels.get(choice);
			if (taskId) await this.showScheduleTask(manager, taskId);
		}
	}

	private async showScheduleHistory(manager: ScheduleManager): Promise<void> {
		let afterTaskId: string | undefined;
		while (true) {
			const page = await manager.list({ afterTaskId, limit: 50, withRunsOnly: true });
			const labels = new Map<string, ScheduleTask>();
			for (const [index, task] of page.tasks.entries()) {
				if (!task.lastRun) continue;
				const label = `${index + 1}. ${task.unreadCount ? `●${task.unreadCount} ` : ""}${task.title} · ${formatScheduleRunStatus(task.lastRun.status)} · ${task.lastRun.completedAt ?? task.lastRun.createdAt}`;
				labels.set(label, task);
			}
			const choice = await this.showExtensionSelector(
				labels.size ? "Execution history" : "Execution history\nNo execution history",
				[...labels.keys(), ...(page.nextAfterTaskId ? ["Next page"] : [])],
			);
			if (!choice) return;
			if (choice === "Next page") {
				afterTaskId = page.nextAfterTaskId ?? undefined;
				continue;
			}
			const task = labels.get(choice);
			if (task) await this.showScheduleRuns(manager, task);
		}
	}

	private async handleScheduleCommand(): Promise<void> {
		if (this.guardSessionMutation()) return;
		if (this.sessionManager.getMode() !== "chat") {
			this.showWarning("Scheduled tasks are only available in Chat mode");
			return;
		}
		const manager = this.options.scheduleManager;
		if (!manager) {
			this.showWarning("Scheduled tasks are not enabled in this process");
			return;
		}
		try {
			while (true) {
				const choice = await this.showExtensionSelector("Schedule", [
					"Create task",
					"Scheduled tasks",
					"Execution history",
				]);
				if (!choice) return;
				if (choice === "Create task") {
					await this.createScheduleTask(manager);
				} else if (choice === "Scheduled tasks") await this.showScheduleTasks(manager);
				else if (choice === "Execution history") await this.showScheduleHistory(manager);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleMcpCommand(): Promise<void> {
		await this.showMcpManager();
	}

	private async showMcpManager(): Promise<void> {
		while (true) {
			const statuses = this.session.getMcpStatus();
			const rows = new Map(statuses.map((status) => [this.mcpStatusRow(status), status.name]));
			const selected = await this.showExtensionSelector("MCP servers", ["Add server", ...rows.keys(), "Close"]);
			if (!selected || selected === "Close") return;
			if (selected === "Add server") {
				if (!this.guardSessionMutation()) await this.showMcpAdd();
				continue;
			}
			const name = rows.get(selected);
			if (name) await this.showMcpServerMenu(name);
		}
	}

	private async showMcpAdd(): Promise<void> {
		let step: "scope" | "name" | "transport" = "scope";
		let scope: SettingsScope = "global";
		let name = "";
		while (true) {
			if (step === "scope") {
				const scopes = ["Personal", ...(this.settingsManager.isProjectTrusted() ? ["Project"] : [])];
				const selected = await this.showExtensionSelector("Add MCP server · Scope", scopes);
				if (!selected) return;
				scope = selected === "Project" ? "project" : "global";
				step = "name";
				continue;
			}
			if (step === "name") {
				const entered = await this.showExtensionInput("Add MCP server · Server name", name || undefined);
				if (entered === undefined) {
					step = "scope";
					continue;
				}
				name = entered.trim();
				if (!name) {
					this.showWarning("MCP server name must not be empty");
					continue;
				}
				step = "transport";
				continue;
			}

			const transport = await this.showExtensionSelector("Add MCP server · Transport", [
				"Local command (stdio)",
				"Remote URL (HTTP)",
			]);
			if (!transport) {
				step = "name";
				continue;
			}
			const server = await this.promptMcpServer(transport === "Local command (stdio)" ? "stdio" : "http");
			if (!server) continue;

			const definitions =
				scope === "global"
					? this.settingsManager.getGlobalSettings().mcpServers
					: this.settingsManager.getProjectSettings().mcpServers;
			if (definitions?.[name]) {
				const replace = await this.showExtensionConfirm(
					"Replace MCP server?",
					`A ${scope === "global" ? "personal" : "project"} server named "${name}" already exists.`,
				);
				if (!replace) continue;
			}

			try {
				await this.persistMcpDefinition(scope, name, server);
				await this.handleMcpPostAdd(name);
				return;
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private async promptMcpServer(transport: "stdio" | "http"): Promise<McpServerSettings | undefined> {
		if (transport === "http") {
			const url = await this.showExtensionInput("Add MCP server · URL", "https://example.com/mcp");
			return url === undefined ? undefined : { url: url.trim() };
		}
		let command = "";
		while (true) {
			const entered = await this.showExtensionInput("Add MCP server · Executable", command || "npx");
			if (entered === undefined) return undefined;
			command = entered.trim();
			const args = await this.showExtensionInput("Add MCP server · Arguments", "-y @scope/server");
			if (args !== undefined) return { command, args: parseCommandArgs(args) };
		}
	}

	private async handleMcpPostAdd(name: string): Promise<void> {
		const status = this.session.getMcpStatus().find((item) => item.name === name);
		if (!status) {
			this.showStatus(`Added MCP server "${name}"`);
			return;
		}
		if (status.state === "connected") {
			this.showStatus(`Connected MCP server "${name}"`);
			return;
		}
		if (status.state === "auth_required") {
			await this.showMcpAuthenticationMenu(name);
			return;
		}
		if (status.lastError) this.showError(status.lastError);
	}

	private async showMcpServerMenu(name: string): Promise<void> {
		while (true) {
			const status = this.session.getMcpStatus().find((item) => item.name === name);
			if (!status || !this.getMcpDefinition(name)) return;
			const stored = this.session.hasMcpCredential(name);
			const actions = ["Details", "Authentication", "Restart", ...(stored ? ["Sign out"] : []), "Remove", "Back"];
			const selected = await this.showExtensionSelector(`MCP server · ${name}`, actions);
			if (!selected || selected === "Back") return;
			if (selected === "Details") {
				this.showMcpDetails(status);
				continue;
			}
			if (this.guardSessionMutation()) continue;
			try {
				if (selected === "Authentication") await this.showMcpAuthenticationMenu(name);
				else if (selected === "Restart") {
					await this.session.restartMcpServers(name);
					this.showStatus(`Restarted MCP server "${name}"`);
				} else if (selected === "Sign out") {
					await this.session.logoutMcpServer(name);
					this.showStatus(`Signed out MCP server "${name}"`);
				} else if (selected === "Remove" && (await this.removeMcpServer(name))) return;
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private validEnvironmentName(value: string): boolean {
		return Boolean(value) && !value.includes("=") && !value.includes("\0");
	}

	private showMcpConnectionResult(name: string, connectedMessage: string): void {
		const status = this.session.getMcpStatus().find((item) => item.name === name);
		if (status?.state === "connected") this.showStatus(connectedMessage);
		else if (status?.state === "auth_required") this.showWarning(`Authentication failed for MCP server "${name}"`);
		else if (status?.lastError) this.showError(status.lastError);
		else this.showWarning(`MCP server "${name}" is ${status?.state ?? "unavailable"}`);
	}

	private async showMcpAuthenticationMenu(name: string): Promise<void> {
		while (true) {
			const definition = this.getMcpDefinition(name);
			if (!definition) return;
			const http = "url" in definition.server;
			const selected = await this.showExtensionSelector(
				`MCP authentication · ${name}`,
				http
					? ["Enter token", "Use environment variable", "No authentication", "Back"]
					: ["Set environment variable", "No authentication", "Back"],
			);
			if (!selected || selected === "Back") return;

			try {
				if (selected === "Enter token" && http) {
					const token = await this.showExtensionInput("Access token", undefined, { secret: true });
					if (token === undefined) continue;
					if (!token) {
						this.showWarning("Access token must not be empty");
						continue;
					}
					const { bearerTokenEnvVar: _bearerTokenEnvVar, ...server } = definition.server as McpHttpServerSettings;
					await this.persistMcpDefinition(definition.scope, name, server, false);
					await this.session.setMcpSecret(name, { bearerToken: token });
					this.showMcpConnectionResult(name, `Updated authentication for MCP server "${name}"`);
					return;
				}
				if (selected === "Use environment variable" && http) {
					const envName = (await this.showExtensionInput("Environment variable name", "MCP_TOKEN"))?.trim();
					if (envName === undefined) continue;
					if (!this.validEnvironmentName(envName)) {
						this.showWarning("Environment variable name must not be empty or contain =");
						continue;
					}
					await this.persistMcpDefinition(
						definition.scope,
						name,
						{
							...(definition.server as McpHttpServerSettings),
							bearerTokenEnvVar: envName,
						},
						false,
					);
					await this.session.logoutMcpServer(name);
					if (process.env[envName] === undefined) {
						this.showWarning(`Environment variable ${envName} is not available. Restart Metis after setting it.`);
					} else this.showMcpConnectionResult(name, `Updated authentication for MCP server "${name}"`);
					return;
				}
				if (selected === "Set environment variable" && !http) {
					const updated = await this.configureMcpStdioEnvironment(
						name,
						definition.scope,
						definition.server as McpStdioServerSettings,
					);
					if (updated) return;
					continue;
				}
				if (selected === "No authentication") {
					const server = http
						? (({ bearerTokenEnvVar: _bearerTokenEnvVar, ...rest }) => rest)(
								definition.server as McpHttpServerSettings,
							)
						: { ...(definition.server as McpStdioServerSettings), envVars: undefined };
					await this.persistMcpDefinition(definition.scope, name, server, false);
					await this.session.logoutMcpServer(name);
					this.showMcpConnectionResult(name, `Cleared authentication for MCP server "${name}"`);
					return;
				}
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private async configureMcpStdioEnvironment(
		name: string,
		scope: SettingsScope,
		server: McpStdioServerSettings,
	): Promise<boolean> {
		while (true) {
			const envName = (await this.showExtensionInput("Environment variable name", "MCP_TOKEN"))?.trim();
			if (envName === undefined) return false;
			if (!this.validEnvironmentName(envName)) {
				this.showWarning("Environment variable name must not be empty or contain =");
				continue;
			}
			while (true) {
				const source = await this.showExtensionSelector(`Environment value · ${envName}`, [
					"Enter value",
					"Use existing environment variable",
					"Back",
				]);
				if (!source || source === "Back") break;
				if (source === "Enter value") {
					const value = await this.showExtensionInput(`Value for ${envName}`, undefined, { secret: true });
					if (value === undefined) continue;
					if (!value) {
						this.showWarning("Environment value must not be empty");
						continue;
					}
					const literal = { ...(server.env ?? {}) };
					delete literal[envName];
					await this.persistMcpDefinition(
						scope,
						name,
						{
							...server,
							env: Object.keys(literal).length > 0 ? literal : undefined,
							envVars: server.envVars?.filter((item) => item !== envName),
						},
						false,
					);
					const existing = this.session.getMcpSecretEnvironment(name);
					await this.session.setMcpSecret(name, { env: { ...existing, [envName]: value } });
					this.showMcpConnectionResult(name, `Updated authentication for MCP server "${name}"`);
					return true;
				}

				const remaining = this.session.getMcpSecretEnvironment(name);
				delete remaining[envName];
				const literal = { ...(server.env ?? {}) };
				delete literal[envName];
				const envVars = [...new Set([...(server.envVars ?? []), envName])];
				await this.persistMcpDefinition(
					scope,
					name,
					{ ...server, env: Object.keys(literal).length > 0 ? literal : undefined, envVars },
					false,
				);
				if (Object.keys(remaining).length > 0) await this.session.setMcpSecret(name, { env: remaining });
				else await this.session.logoutMcpServer(name);
				if (process.env[envName] === undefined) {
					this.showWarning(`Environment variable ${envName} is not available. Restart Metis after setting it.`);
				} else this.showMcpConnectionResult(name, `Updated authentication for MCP server "${name}"`);
				return true;
			}
		}
	}

	private async removeMcpServer(name: string): Promise<boolean> {
		const global = this.settingsManager.getGlobalSettings().mcpServers?.[name];
		const project = this.settingsManager.getProjectSettings().mcpServers?.[name];
		let scope: SettingsScope;
		if (global && project) {
			const selected = await this.showExtensionSelector(`Remove MCP server · ${name}`, [
				"Project override",
				"Personal definition",
				"Back",
			]);
			if (!selected || selected === "Back") return false;
			scope = selected === "Project override" ? "project" : "global";
		} else if (project) scope = "project";
		else if (global) scope = "global";
		else return false;

		const confirmed = await this.showExtensionConfirm(
			"Remove MCP server?",
			`Remove the ${scope === "global" ? "personal" : "project"} definition for "${name}" and its stored credential?`,
		);
		if (!confirmed) return false;
		if (!this.settingsManager.removeMcpServer(scope, name)) return false;
		await this.settingsManager.flush();
		const errors = this.settingsManager.drainErrors();
		if (errors.length > 0) throw errors[0]!.error;
		this.session.deleteMcpCredential(name);
		await this.session.reload();
		this.showStatus(`Removed MCP server "${name}"`);
		return true;
	}

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(
				theme.fg(
					"muted",
					"Reloading keybindings, extensions, skills, prompts, themes, context files, memory, and MCP servers...",
				),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			await this.themeController.applyFromSettings();
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			const clearOnShrink = this.settingsManager.getClearOnShrink();
			this.ui.setClearOnShrink(clearOnShrink);
			if (!clearOnShrink && !this.activeStatusIndicator) {
				this.statusContainer.clear();
			}
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus(
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, context files, memory, and MCP servers; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, context files, memory, and MCP servers",
			);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			this.clearStatusIndicator();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();
		const entries = this.sessionManager.getEntries();
		const cacheWaste = computeCacheWaste(entries, this.session.modelRegistry);

		// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
		// resolves to a concrete responseModel), sorted by cost descending.
		const perModelMap = new Map<string, { key: string; cost: number; tokens: number }>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			const usage = message.usage;
			const key = `${message.provider}/${message.responseModel ?? message.model}`;
			let bucket = perModelMap.get(key);
			if (!bucket) {
				bucket = { key, cost: 0, tokens: 0 };
				perModelMap.set(key, bucket);
			}
			bucket.cost += usage.cost.total;
			bucket.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
		const perModel = Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost);

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n`;
		info += `${theme.fg("dim", "Mode:")} ${stats.mode}\n`;
		info += `${theme.fg("dim", "Workspace:")} ${stats.cwd} (${stats.cwdOrigin})\n`;
		info += `${theme.fg("dim", "Permissions:")} ${stats.permissionMode}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		// "Input" is the full prompt volume. With cache activity, split it into
		// cached (served from cache) vs uncached (everything else) - the only
		// provider-independent split. Cache writes, where reported, are a detail
		// of the uncached portion.
		const { input, cacheRead, cacheWrite } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
		if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
			const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
			info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
			const written =
				cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
			info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
		}
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
			if (perModel.length > 1) {
				for (const entry of perModel) {
					info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
				}
			}
			if (cacheWaste.missedTokens > 0) {
				const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
				const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
				info +=
					cacheWaste.missedCost >= 0.0001
						? `\n${theme.fg("dim", "Cache Re-billed:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
						: `\n${theme.fg("dim", "Cache Re-billed:")} ${detail}`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const copyMessage = this.getAppKeyDisplay("app.message.copy");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image, local file, or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleNewSessionCommand(text: string): Promise<void> {
		const value = text.slice("/new".length).trim();
		if (value !== "" && !isAgentMode(value)) {
			this.showError("Usage: /new [chat|code]");
			return;
		}
		if (this.guardSessionMutation()) return;
		let mode: AgentMode | undefined = value || undefined;
		if (!mode) {
			const currentMode = this.sessionManager.getMode();
			const choices = currentMode === "chat" ? ["Chat", "Code"] : ["Code", "Chat"];
			const selected = await this.showExtensionSelector("New session mode", choices);
			if (!selected) return;
			mode = selected.toLowerCase() as AgentMode;
		}

		const terminalCwd = this.runtimeHost.terminalCwd;
		const managed = "Metis managed workspace";
		const terminal = `Terminal working directory (${terminalCwd})`;
		const other = "Other directory";
		const workspace = await this.showExtensionSelector(
			`${mode === "chat" ? "Chat" : "Code"} workspace`,
			mode === "chat" ? [managed, terminal, other] : [terminal, other],
		);
		if (!workspace) return;

		let cwd: string | undefined;
		if (workspace === terminal) {
			cwd = terminalCwd;
		} else if (workspace === other) {
			const input = await this.showExtensionInput("Directory", terminalCwd);
			if (!input) return;
			const resolved = resolvePath(input, terminalCwd);
			try {
				if (!fs.statSync(resolved).isDirectory()) throw new Error("Not a directory");
				cwd = canonicalizePath(resolved);
			} catch {
				this.showError(`Directory does not exist: ${resolved}`);
				return;
			}
		}
		await this.handleClearCommand(mode, cwd);
	}

	private async handleClearCommand(mode?: AgentMode, cwd?: string): Promise<void> {
		if (this.guardSessionMutation()) return;
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession(mode ? { mode, cwd } : undefined);
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`${theme.fg("accent", `✓ New ${this.sessionManager.getMode()} session started`)}`, 1, 1),
			);
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(): void {
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		this.cleanupClipboardAttachments();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		this.scheduleUnsubscribe?.();
		this.scheduleUnsubscribe = undefined;
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}
