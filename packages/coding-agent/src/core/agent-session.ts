/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentQueueIdentity,
	AgentState,
	AgentTool,
	BeforeQueueCommitContext,
	BeforeToolExecuteContext,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@arcmind/agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@arcmind/ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	streamSimple,
} from "@arcmind/ai/compat";
import { getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizeActionPath, isPathInside, resolvePath } from "../utils/paths.ts";
import { getShellConfig } from "../utils/shell.ts";
import { sleep } from "../utils/sleep.ts";
import type { AgentMode } from "./agent-mode.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { McpSecretCredential } from "./auth-storage.ts";
import { type AutoMemorySnapshot, loadAutoMemory } from "./auto-memory.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { readBoundedUtf8FileSync } from "./bounded-text-file.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { externalizeLargeToolOutput, type PersistedToolOutput } from "./large-tool-output.ts";
import { createMcpToolDefinitions, type McpManager, type McpServerStatus } from "./mcp/index.ts";
import {
	type DreamActiveRun,
	type DreamHistoryRecord,
	type DreamStatusSnapshot,
	type DreamTrigger,
	readDreamHistory,
	runMemoryDream,
} from "./memory-dream.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { PermissionMode } from "./permission-mode.ts";
import {
	type ClassifiedAction,
	classifyAction,
	PermissionPolicy,
	PermissionReviewer,
	type PermissionReviewerStream,
	type RequestPermissionApproval,
	type SandboxGrant,
	type ToolProvenance,
} from "./permission-policy.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import {
	type DurablePromptInput,
	deriveBatchedTurnId,
	MAX_DURABLE_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGES,
	MAX_DURABLE_PROMPT_TEXT_BYTES,
	MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES,
	type RuntimeAssistantMessageEvidence,
	type RuntimeRequestIdentity,
	validateRuntimeAssistantMessageEvidence,
	validateRuntimeToolResultMessageEvidence,
} from "./runtime-recovery.ts";
import { appendSyntheticRuntimeToolResult } from "./runtime-recovery-materializer.ts";
import { SandboxRuntimeCoordinator } from "./sandbox-runtime.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { CwdOrigin } from "./session-workspace.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { canUseUltra, getHighestSupportedThinkingLevel, type ThinkingSelection } from "./thinking-selection.ts";
import { createToolResultMicrocompactor } from "./tool-result-microcompaction.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import type { ToolSubprocessExecutor } from "./tools/subprocess.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { resolveWebSearchApiKey, WEB_SEARCH_PROVIDER_INFO, type WebSearchProvider } from "./web-search-config.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "thinking_selection_changed";
			selection: ThinkingSelection;
			actualThinkingLevel: ThinkingLevel;
			subagentsEnabled: boolean;
	  }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface ChildCapabilityScope {
	/** Project roots enforced for sandbox-aware builtin reads. */
	readonly readPaths: readonly string[];
	/** Project roots enforced for sandbox-aware builtin writes. */
	readonly writePaths: readonly string[];
	/** Parent workspace regions hidden from sandboxed child processes except for readPaths. */
	readonly workspaceRoots: readonly string[];
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** ArcMind agent directory used for global and project memory. */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingSelection }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** MCP manager. A successfully constructed session owns and disposes it. */
	mcpManager?: McpManager;
	/** Initial active built-in tool names. Primary default: [read, grep, bash, edit, write, web_fetch, update_plan] */
	initialActiveToolNames?: string[];
	/** Whether settings may activate default built-ins omitted by noTools. Default: true. */
	defaultBuiltinToolsEnabled?: boolean;
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Request a one-action approval from the active frontend. Missing UI fails closed. */
	requestPermissionApproval?: RequestPermissionApproval;
	/** Test/custom runtime seam; production uses the current session model. */
	permissionReviewerStream?: PermissionReviewerStream;
	/** Test/custom runtime seam for SRT orchestration. */
	sandboxRuntime?: SandboxRuntimeCoordinator;
	/** Explicit Windows provisioning consent shown before SRT's one-time UAC setup. */
	requestWindowsSandboxSetup?: () => Promise<boolean>;
	/** Host capability: only persisted primary AgentSessionRuntime instances set this. */
	ultraAvailable?: boolean;
	/** Host-owned prompt suffix used for runtime coordination profiles. */
	additionalSystemPrompt?: string | (() => string | undefined);
	/** Include automatic memory context and dream writes. Defaults to true. */
	includeAutoMemory?: boolean;
	/** Project filesystem capability for a child's sandbox-aware builtin tools. */
	childCapabilityScope?: ChildCapabilityScope;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	mode: AgentMode;
	cwd: string;
	cwdOrigin: CwdOrigin;
	permissionMode: PermissionMode;
	reviewerEnabled: boolean;
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface AuthorizedPermissionAction {
	readonly action: ClassifiedAction;
	readonly grant: SandboxGrant;
	readonly bypassSandbox: boolean;
	readonly cwd: string;
}

export interface UserBashAuthorization {
	readonly actionId: string;
	readonly command: string;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const MAX_DURABLE_TURN_OPERATIONS = 256;
const IMMEDIATE_EXTERNALIZATION_BUILTINS = new Set(["web_fetch", "web_search"]);

// ============================================================================
// AgentSession Class
// ============================================================================

interface AgentEventPersistenceScope {
	owner: object;
	active: boolean;
}

interface DurablePromptExecutionScope {
	readonly owner: AgentSession;
	readonly turnId: string;
	readonly input: DurablePromptInput;
	active: boolean;
}

class DurableMessageValidationError extends Error {
	constructor(cause: unknown) {
		super("Rejected invalid durable message evidence", { cause });
		this.name = "DurableMessageValidationError";
	}
}

interface ActiveDurableTurn {
	readonly turnId: string;
	readonly operations: DurableOperationMetadata[];
	readonly consumedQueueItemIds: string[];
}

interface DurableOperationMetadata {
	readonly identity: RuntimeRequestIdentity;
	readonly input: DurablePromptInput;
	readonly kind: "turn" | "steer";
	residentPayloadBytes: number;
}

interface DurableQueueMetadata {
	readonly operation: DurableOperationMetadata;
	readonly queue: "steer" | "follow_up";
}

function durablePromptResidentPayloadBytes(input: DurablePromptInput, text = input.text): number {
	return (
		Buffer.byteLength(text, "utf8") +
		(input.images ?? []).reduce((total, image) => total + 4 * Math.ceil(image.size / 3), 0)
	);
}

const agentEventPersistenceContext = new AsyncLocalStorage<AgentEventPersistenceScope>();
const durablePromptExecutionContext = new AsyncLocalStorage<DurablePromptExecutionScope>();

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private readonly _toolOutputDir: string;
	private readonly _ephemeralToolOutputDir: string | undefined;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingSelection }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _isAgentSettling = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;
	private readonly _inFlightEventPersistence = new Set<Promise<void>>();
	private _eventPersistenceFailure: unknown;
	private _durableTurn?: ActiveDurableTurn;
	private readonly _durableStartedTools = new Map<string, string>();
	private readonly _durableToolResults = new Set<string>();
	private readonly _durableCompletedTools = new Set<string>();
	private readonly _durableToolCalls = new Map<string, string>();
	private readonly _durablePendingToolCalls = new Map<string, string>();
	private readonly _durableQueues = new Map<string, DurableQueueMetadata>();
	private _durableResidentPayloadBytes = 0;
	private _durableTerminalEvidence: "completed" | "interrupted" | undefined;
	private _durableOperationTurnListener?: (operationId: string, turnId: string) => void;
	private _runtimeTeardownRequested = false;
	private _stopCurrentRunAfterAbort = false;
	private _durableRecoveryRequired = false;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Host-owned durable events awaiting the next provider request boundary. */
	private readonly _pendingBackgroundMessages = new Map<string, CustomMessage>();
	private readonly _backgroundMessageKeys = new Set<string>();
	private _stagedBackgroundMessages: readonly [string, CustomMessage][] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _activeDream: DreamActiveRun | undefined;
	private _dreamPromise: Promise<DreamHistoryRecord> | undefined;
	private _memoryDreamRunner = runMemoryDream;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir?: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _defaultBuiltinToolsEnabled: boolean;
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _disposeCoreComplete = false;
	private _resourceLoaderDisposed = false;
	private _sessionManagerClosed = false;
	private readonly _mcpManager?: McpManager;
	private _unsubscribeMcpCatalog?: () => void;
	private _mcpManagerDisposed = false;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;
	private readonly _permissionPolicy: PermissionPolicy;
	private _requestPermissionApproval?: RequestPermissionApproval;
	private readonly _permissionGrants = new Map<string, AuthorizedPermissionAction>();
	private readonly _permissionDenials = new Map<string, string>();
	private readonly _sandboxRuntime: SandboxRuntimeCoordinator;
	private _runtimeShellCommandPrefix?: string;
	private readonly _ultraAvailable: boolean;
	private readonly _includeAutoMemory: boolean;
	private readonly _childCapabilityScope?: ChildCapabilityScope;
	private _additionalSystemPrompt?: string | (() => string | undefined);
	private readonly _trustedControlToolNames = new Set<string>();

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		const persistedToolOutputDir = this.sessionManager.getToolOutputDir();
		this._ephemeralToolOutputDir = persistedToolOutputDir
			? undefined
			: join(tmpdir(), "arcmind-tool-results", this.sessionManager.getSessionId());
		this._toolOutputDir = persistedToolOutputDir ?? this._ephemeralToolOutputDir!;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir;
		this._modelRegistry = config.modelRegistry;
		this._mcpManager = config.mcpManager;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._defaultBuiltinToolsEnabled = config.defaultBuiltinToolsEnabled !== false;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._ultraAvailable = canUseUltra({
			hostAllowsUltra: config.ultraAvailable === true,
			persisted: this.sessionManager.isPersisted(),
			mode: this.sessionManager.getMode(),
			isSubagent: this.sessionManager.getHeader()?.subagent !== undefined,
		});
		this._additionalSystemPrompt = config.additionalSystemPrompt;
		this._includeAutoMemory = config.includeAutoMemory !== false;
		this._childCapabilityScope = config.childCapabilityScope;
		if (this.sessionManager.getSubagentsEnabled() && !this._ultraAvailable) {
			throw new Error("Ultra sessions require AgentSessionRuntime");
		}
		const reviewerStream = config.permissionReviewerStream ?? ((request) => this._streamPermissionReview(request));
		this._permissionPolicy = new PermissionPolicy(
			new PermissionReviewer(reviewerStream),
			config.requestPermissionApproval,
		);
		this._requestPermissionApproval = config.requestPermissionApproval;
		this._sandboxRuntime =
			config.sandboxRuntime ??
			new SandboxRuntimeCoordinator({
				agentDir: this._agentDir ?? getAgentDir(),
				requestWindowsSetup: config.requestWindowsSandboxSetup,
			});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installBackgroundMessageHook();
		this._installToolResultMicrocompactionHook();
		this._installAgentDurabilityHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._unsubscribeMcpCatalog = this._mcpManager?.subscribeCatalog(() => {
			this._refreshToolRegistry({ activeToolNames: this.getActiveToolNames() });
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setPermissionApprovalHandler(handler?: RequestPermissionApproval): void {
		this._requestPermissionApproval = handler;
		this._permissionPolicy.setRequestApproval(handler);
	}

	/** Forward a child approval through the frontend currently attached to this session. */
	requestPermissionApproval(request: Parameters<RequestPermissionApproval>[0]): ReturnType<RequestPermissionApproval> {
		const handler = this._requestPermissionApproval;
		if (!handler) return Promise.resolve({ decision: "deny", reason: "No interactive session owner is available" });
		return handler(request);
	}

	setWindowsSandboxSetupHandler(handler?: () => Promise<boolean>): void {
		this._sandboxRuntime.setWindowsSetupRequester(handler);
	}

	/** Install runtime-owned control tools and bypass user-action approval for them. */
	installHostTools(definitions: readonly ToolDefinition[]): void {
		const active = new Set(this.getActiveToolNames());
		for (const definition of definitions) {
			const existing = this._customTools.findIndex((candidate) => candidate.name === definition.name);
			if (existing < 0) this._customTools.push(definition);
			else this._customTools[existing] = definition;
			this._trustedControlToolNames.add(definition.name);
			this._allowedToolNames?.add(definition.name);
			active.add(definition.name);
		}
		this._refreshToolRegistry({ activeToolNames: [...active] });
	}

	setHostSystemPrompt(additional?: string | (() => string | undefined)): void {
		this._additionalSystemPrompt = additional;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/**
	 * Persist a host event without interrupting, steering, or starting a model turn.
	 * The event is added to the first provider request whose context includes it.
	 */
	enqueueBackgroundCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		dedupeKey: string,
	): void {
		if (this._runtimeTeardownRequested) throw new Error("The agent session is tearing down");
		if (!dedupeKey) throw new Error("Background message dedupe key must be non-empty");
		if (this._backgroundMessageKeys.has(dedupeKey)) {
			throw new Error(`Background message dedupe key was reused: ${dedupeKey}`);
		}
		if (this._pendingBackgroundMessages.size >= 256) throw new Error("Background message mailbox is full");
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._backgroundMessageKeys.add(dedupeKey);
		this._pendingBackgroundMessages.set(dedupeKey, appMessage);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	hasPendingBackgroundMessage(dedupeKey: string): boolean {
		return this._pendingBackgroundMessages.has(dedupeKey);
	}

	private _installBackgroundMessageHook(): void {
		const transformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			this._stagedBackgroundMessages = [...this._pendingBackgroundMessages.entries()];
			const withPending =
				this._stagedBackgroundMessages.length === 0
					? messages
					: [...messages, ...this._stagedBackgroundMessages.map(([, message]) => message)];
			return transformContext ? transformContext(withPending, signal) : withPending;
		};
	}

	private _installToolResultMicrocompactionHook(): void {
		const transformContext = this.agent.transformContext;
		const microcompact = createToolResultMicrocompactor({
			outputDir: this._toolOutputDir,
			isBuiltinTool: (toolName) => {
				if (this._baseToolsOverride) return false;
				const active = this._toolDefinitions.get(toolName)?.definition;
				const builtin = this._baseToolDefinitions.get(toolName);
				return active !== undefined && active === builtin;
			},
		});
		this.agent.transformContext = async (messages, signal) => {
			const transformed = transformContext ? await transformContext(messages, signal) : messages;
			return microcompact(transformed, signal);
		};
	}

	private _commitStagedBackgroundMessages(): void {
		for (const [key, message] of this._stagedBackgroundMessages) {
			if (this._pendingBackgroundMessages.get(key) !== message) continue;
			this.agent.state.messages.push(message);
			this._pendingBackgroundMessages.delete(key);
		}
		this._stagedBackgroundMessages = [];
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers, env: result.env };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers, env: result.env } : {};
	}

	private async _streamPermissionReview(request: Parameters<PermissionReviewerStream>[0]): Promise<string> {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
		const reasoning = clampThinkingLevel(model, request.reasoning);
		const response = await this.agent.streamFn(
			model,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
			},
			{
				apiKey,
				headers,
				env,
				signal: request.signal,
				maxTokens: request.maxTokens,
				reasoning: reasoning === "off" ? undefined : reasoning,
			},
		);
		const message = await response.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? "Permission review failed");
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("");
	}

	private _permissionUserMessages(): string[] {
		const messages: string[] = [];
		for (const message of this.agent.state.messages) {
			if (message.role !== "user") continue;
			const text = this._getUserMessageText(message);
			if (text) messages.push(text);
		}
		return messages;
	}

	private _toolProvenance(toolName: string): ToolProvenance {
		const source = this._toolDefinitions.get(toolName)?.sourceInfo.source.toLowerCase();
		if (source === "builtin") return "builtin";
		if (source === "sdk") return "sdk";
		if (source === "mcp" || source?.startsWith("mcp:")) return "mcp";
		return "extension";
	}

	private _withPermissionGuard(tool: AgentTool): AgentTool {
		return {
			...tool,
			execute: async (toolCallId, args, signal, onUpdate) => {
				if (this._trustedControlToolNames.has(tool.name)) {
					return tool.execute(toolCallId, args, signal, onUpdate);
				}
				const denial = this._permissionDenials.get(toolCallId);
				if (denial) throw new Error(denial);
				const authorization = this._permissionGrants.get(toolCallId);
				if (!authorization) {
					throw new Error(`Missing one-action permission grant for ${tool.name}`);
				}
				if (tool.name === "web_search" && this._toolProvenance(tool.name) === "builtin") {
					const target =
						WEB_SEARCH_PROVIDER_INFO[this.settingsManager.getWebSearchSettings().provider].networkTarget;
					if (
						!authorization.grant.networkTargets.some(
							(value) => value.host === target.host && value.port === target.port,
						)
					) {
						throw new Error("web_search provider changed after permission approval; retry the search");
					}
				}
				return tool.execute(toolCallId, args, signal, onUpdate);
			},
		};
	}

	private _appendPermissionAudit(
		action: ClassifiedAction,
		source: "user" | "reviewer",
		decision: "allow" | "ask" | "deny",
		reason: string,
	): void {
		this.sessionManager.appendPermissionDecision({
			actionId: action.actionId,
			toolName: action.toolName,
			source,
			decision,
			reason,
		});
	}

	private async _authorizePermissionAction(input: {
		actionId: string;
		toolName: string;
		provenance: ToolProvenance;
		args: unknown;
		actionSource: "assistant" | "user-bash";
		effectiveCommand?: string;
		cwd?: string;
		signal?: AbortSignal;
	}): Promise<AuthorizedPermissionAction> {
		if (this._permissionGrants.has(input.actionId)) {
			throw new Error(`Permission action ID was reused: ${input.actionId}`);
		}
		const cwd = input.cwd ?? this.sessionManager.getCwd();
		let action = classifyAction({
			actionId: input.actionId,
			toolName: input.toolName,
			provenance: input.provenance,
			args: input.args,
			cwd,
			mcpAnnotations: input.provenance === "mcp" ? this._mcpManager?.getToolAnnotations(input.toolName) : undefined,
			builtinNetworkTargets:
				input.provenance === "builtin" && input.toolName === "web_search"
					? [WEB_SEARCH_PROVIDER_INFO[this.settingsManager.getWebSearchSettings().provider].networkTarget]
					: undefined,
		});
		if (input.effectiveCommand !== undefined) action = { ...action, command: input.effectiveCommand };
		const childScope = input.provenance === "builtin" ? this._childCapabilityScope : undefined;
		const isWrite = action.risks.some(
			(risk) => risk === "workspace-write" || risk === "outside-write" || risk === "destructive",
		);
		if (childScope && action.paths.length > 0) {
			const roots = isWrite ? childScope.writePaths : childScope.readPaths;
			const deniedPath = action.paths.find((path) => !roots.some((root) => isPathInside(root, path)));
			if (deniedPath) {
				throw new Error(`Subagent ${isWrite ? "write" : "read"} path is outside its assigned roots: ${deniedPath}`);
			}
		}
		const settings = this.sessionManager.getPermissionSettings();
		const authorization = await this._permissionPolicy.authorize({
			settings,
			action,
			actionSource: input.actionSource,
			args:
				input.effectiveCommand === undefined
					? input.args
					: { ...(input.args as Record<string, unknown>), command: input.effectiveCommand },
			userMessages: this._permissionUserMessages(),
			cwd,
			signal: input.signal,
		});
		if (authorization.reviewerDecision) {
			this._appendPermissionAudit(
				action,
				"reviewer",
				authorization.reviewerDecision.decision,
				authorization.reviewerDecision.reason,
			);
		}
		if (authorization.source === "user") {
			this._appendPermissionAudit(action, "user", authorization.decision, authorization.reason);
		}
		if (authorization.decision === "deny") {
			throw new Error(`Permission denied for ${input.toolName}: ${authorization.reason}`);
		}
		const grant: SandboxGrant = childScope
			? {
					actionId: authorization.grant.actionId,
					sandbox: action.sandbox === "none" ? "exact" : action.sandbox,
					denyReadPaths: childScope.workspaceRoots,
					capabilityReadPaths: childScope.readPaths,
					capabilityWritePaths: isWrite ? childScope.writePaths : [],
					readPaths: authorization.grant.readPaths,
					writePaths: [],
					networkTargets: authorization.grant.networkTargets,
					fullOnce: false,
				}
			: authorization.grant;
		const authorized = {
			action,
			grant,
			bypassSandbox: childScope === undefined && (settings.mode === "full" || authorization.grant.fullOnce),
			cwd,
		} satisfies AuthorizedPermissionAction;
		this._permissionGrants.set(input.actionId, authorized);
		return authorized;
	}

	private _takePermissionAction(actionId: string | undefined, toolName: string): AuthorizedPermissionAction {
		if (!actionId) throw new Error(`Missing one-action permission grant for ${toolName}`);
		const authorized = this._permissionGrants.get(actionId);
		if (!authorized || authorized.action.toolName !== toolName || authorized.grant.actionId !== actionId) {
			throw new Error(`Invalid or expired one-action permission grant for ${toolName}`);
		}
		this._permissionGrants.delete(actionId);
		return authorized;
	}

	private _createPermissionBashOperations(shellPath?: string, trustedOperations?: BashOperations): BashOperations {
		const local = createLocalBashOperations({ shellPath });
		return {
			exec: async (command, cwd, options) => {
				const authorized = this._takePermissionAction(options.actionId, "bash");
				if (authorized.action.command !== command) {
					throw new Error("Bash command changed after permission approval");
				}
				if (
					canonicalizeActionPath(cwd, authorized.cwd) !== canonicalizeActionPath(authorized.cwd, authorized.cwd)
				) {
					throw new Error("Bash working directory changed after permission approval");
				}
				if (trustedOperations) return trustedOperations.exec(command, cwd, options);
				if (authorized.bypassSandbox) return local.exec(command, cwd, options);
				return this._sandboxRuntime.execute({
					command,
					shell: getShellConfig(shellPath).shell,
					cwd,
					grant: authorized.grant,
					signal: options.signal,
					timeout: options.timeout,
					onData: options.onData,
				});
			},
		};
	}

	private _createToolSubprocessExecutor(toolName: "grep" | "find", shellPath?: string): ToolSubprocessExecutor {
		return {
			execute: async (input, run) => {
				const authorized = this._takePermissionAction(input.actionId, toolName);
				if (
					canonicalizeActionPath(input.cwd, authorized.cwd) !==
					canonicalizeActionPath(authorized.cwd, authorized.cwd)
				) {
					throw new Error(`${toolName} working directory changed after permission approval`);
				}
				if (authorized.bypassSandbox) {
					return run({ argv: [input.executable, ...input.args] });
				}
				return this._sandboxRuntime.executeArgvWith(
					{
						executable: input.executable,
						args: input.args,
						cwd: input.cwd,
						grant: authorized.grant,
						shell: getShellConfig(shellPath).shell,
						signal: input.signal,
						onData: () => {},
					},
					({ argv, env, signal }) => run({ argv, env, signal }),
				);
			},
		};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	private _installAgentDurabilityHooks(): void {
		this.agent.installMandatoryRuntimeHooks({
			beforeRunStart: () => this._assertDurablePromptExecutionOwner(),
			beforeQueueCommit: async (context) => {
				try {
					this._commitDurableQueueTurn(context);
				} catch (error) {
					if (context.items.some((item) => item.operationId !== undefined)) this._durableRecoveryRequired = true;
					throw error;
				}
			},
			beforeQueueClear: (context) => {
				if (context.items.some((item) => item.operationId !== undefined)) {
					throw new Error("Durable queued prompts cannot be cleared before they are consumed or recovered");
				}
			},
			beforeProviderRequest: async () => {
				this._commitStagedBackgroundMessages();
				this._markDurableProviderEpoch();
			},
			beforeToolExecute: async (context, signal) => {
				const provenance = this._toolProvenance(context.toolCall.name);
				const args =
					typeof context.args === "object" && context.args !== null
						? (context.args as Record<string, unknown>)
						: {};
				const command =
					provenance === "builtin" && context.toolCall.name === "bash" && typeof args.command === "string"
						? this._runtimeShellCommandPrefix
							? `${this._runtimeShellCommandPrefix}\n${args.command}`
							: args.command
						: undefined;
				try {
					if (!this._trustedControlToolNames.has(context.toolCall.name)) {
						await this._authorizePermissionAction({
							actionId: context.toolCall.id,
							toolName: context.toolCall.name,
							provenance,
							args: context.args,
							actionSource: "assistant",
							effectiveCommand: command,
							cwd: this._cwd,
							signal,
						});
					}
				} catch (error) {
					this._permissionGrants.delete(context.toolCall.id);
					this._permissionDenials.set(
						context.toolCall.id,
						error instanceof Error ? error.message : `Permission denied for ${context.toolCall.name}`,
					);
				}
				let started = false;
				try {
					const turn = this._durableTurn;
					if (!turn) return;
					const expectedToolName = this._durablePendingToolCalls.get(context.toolCall.id);
					if (expectedToolName === undefined) {
						throw new Error(`Durable tool call is not pending: ${context.toolCall.id}`);
					}
					if (expectedToolName !== context.toolCall.name) {
						throw new Error(`Durable tool call name changed for ${context.toolCall.id}`);
					}
					if (this._durableStartedTools.has(context.toolCall.id)) {
						throw new Error(`Durable tool call already started: ${context.toolCall.id}`);
					}
					this.sessionManager.appendRuntimeControl({
						type: "runtime_tool",
						turnId: turn.turnId,
						toolCallId: context.toolCall.id,
						toolName: context.toolCall.name,
						state: "started",
					});
					started = true;
					this._durableStartedTools.set(context.toolCall.id, context.toolCall.name);
				} catch (error) {
					this._permissionGrants.delete(context.toolCall.id);
					this._permissionDenials.delete(context.toolCall.id);
					try {
						this._repairRejectedDurableTool(context, started);
					} catch (repairError) {
						throw new AggregateError(
							[error, repairError],
							"Failed to mark and structurally repair a rejected tool call",
						);
					}
					throw error;
				}
			},
		});
	}

	private _commitDurableQueueTurn(context: BeforeQueueCommitContext): void {
		if (this._durableRecoveryRequired) {
			throw new Error("The durable prompt queue must be recovered before running more work");
		}
		if (this._runtimeTeardownRequested || this._stopCurrentRunAfterAbort) {
			throw new Error("The durable agent run was stopped before its queued work could be consumed");
		}
		const durableItems = context.items.filter(
			(item): item is typeof item & { operationId: string } => item.operationId !== undefined,
		);
		if (durableItems.length === 0) {
			if (context.items.length > 0) this._markDurableProviderEpoch();
			return;
		}

		const metadata: DurableQueueMetadata[] = [];
		for (const item of durableItems) {
			const queue = this._durableQueues.get(item.queueItemId);
			if (!queue || queue.operation.identity.operationId !== item.operationId || queue.queue !== context.queue) {
				throw new Error(`Queue item is not durably enqueued: ${item.queueItemId}`);
			}
			metadata.push(queue);
		}
		let hydratedImages: Array<ImageContent[] | undefined>;
		try {
			hydratedImages = metadata.map(({ operation }) =>
				operation.input.images?.length
					? this.sessionManager.resolveDurableImageRefs(operation.input.images)
					: undefined,
			);
		} catch (error) {
			this._durableRecoveryRequired = true;
			throw error;
		}
		const hydratedContent: Array<Array<TextContent | ImageContent> | undefined> = [];
		for (let index = 0; index < durableItems.length; index += 1) {
			const images = hydratedImages[index];
			if (!images?.length) {
				hydratedContent.push(undefined);
				continue;
			}
			const message = durableItems[index]!.message;
			if (message.role !== "user") throw new Error("Durable queue item is not a user message");
			const textContent =
				typeof message.content === "string"
					? [{ type: "text" as const, text: message.content }]
					: message.content.filter((content) => content.type !== "image");
			hydratedContent.push([...textContent, ...images]);
		}
		const applyHydratedContent = () => {
			for (let index = 0; index < hydratedContent.length; index += 1) {
				const content = hydratedContent[index];
				if (!content) continue;
				const message = durableItems[index]!.message;
				if (message.role === "user") message.content = content;
			}
		};

		const operations = metadata.map((item) => item.operation);
		const operationIds = operations.map((operation) => operation.identity.operationId);
		const queueItemIds = durableItems.map((item) => item.queueItemId);
		const current = this._durableTurn;
		if (!current) {
			const turnId = deriveBatchedTurnId(queueItemIds);
			this.sessionManager.appendRuntimeControl({
				type: "runtime_turn",
				turnId,
				operationIds,
				state: "started",
				consumedQueueItemIds: queueItemIds,
			});
			applyHydratedContent();
			this._durableTurn = { turnId, operations: [...operations], consumedQueueItemIds: [...queueItemIds] };
			for (const operation of operations) {
				this._durableOperationTurnListener?.(operation.identity.operationId, turnId);
			}
			for (const id of queueItemIds) this._durableQueues.delete(id);
			this._durableTerminalEvidence = undefined;
			return;
		}

		if (queueItemIds.some((id) => current.consumedQueueItemIds.includes(id))) {
			throw new Error("A durable queue item was offered for consumption more than once");
		}
		const nextOperationIds = [
			...current.operations.map((operation) => operation.identity.operationId),
			...operationIds,
		];
		const nextQueueItemIds = [...current.consumedQueueItemIds, ...queueItemIds];
		this.sessionManager.appendRuntimeControl({
			type: "runtime_turn",
			turnId: current.turnId,
			operationIds: nextOperationIds,
			state: "started",
			consumedQueueItemIds: nextQueueItemIds,
		});
		applyHydratedContent();
		current.operations.push(...operations);
		current.consumedQueueItemIds.push(...queueItemIds);
		for (const operation of operations) {
			this._durableOperationTurnListener?.(operation.identity.operationId, current.turnId);
		}
		for (const id of queueItemIds) this._durableQueues.delete(id);
		this._durableTerminalEvidence = undefined;
	}

	private _markDurableProviderEpoch(): void {
		if (this._durableRecoveryRequired) {
			throw new Error("The durable prompt queue must be recovered before starting another provider request");
		}
		if (this._runtimeTeardownRequested || this._stopCurrentRunAfterAbort) {
			throw new Error("The durable agent run was stopped before its next provider request");
		}
		const turn = this._durableTurn;
		if (!turn) return;
		if (this._durablePendingToolCalls.size > 0) {
			throw new Error(`Runtime turn ${turn.turnId} cannot start a provider request with unresolved tool calls`);
		}
		this.sessionManager.appendRuntimeControl({
			type: "runtime_turn",
			turnId: turn.turnId,
			operationIds: turn.operations.map((operation) => operation.identity.operationId),
			state: "started",
			consumedQueueItemIds: turn.consumedQueueItemIds,
		});
		this._durableTerminalEvidence = undefined;
	}

	private _repairRejectedDurableTool(context: BeforeToolExecuteContext, started: boolean): void {
		const turn = this._durableTurn;
		if (!turn || !this._durablePendingToolCalls.has(context.toolCall.id)) return;
		if (started) {
			this.sessionManager.appendRuntimeControl({
				type: "runtime_tool",
				turnId: turn.turnId,
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				state: "interrupted",
			});
			this._durableCompletedTools.add(context.toolCall.id);
		}
		const message = appendSyntheticRuntimeToolResult(
			this.sessionManager,
			turn.turnId,
			context.toolCall.id,
			context.toolCall.name,
		);
		this.agent.state.messages.push(message);
		this._durablePendingToolCalls.delete(context.toolCall.id);
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || this._isAgentSettling || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentSettling = true;
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._isAgentSettling = false;
			this._stopCurrentRunAfterAbort = false;
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal event implementation. The subscription wrapper below tracks durable message writes. */
	private async _processAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type === "tool_execution_end") {
			this._permissionGrants.delete(event.toolCallId);
			this._permissionDenials.delete(event.toolCallId);
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		let toolOutput: PersistedToolOutput | undefined;
		if (
			event.type === "message_end" &&
			event.message.role === "toolResult" &&
			(this._toolDefinitions.get(event.message.toolName)?.sourceInfo.source !== "builtin" ||
				IMMEDIATE_EXTERNALIZATION_BUILTINS.has(event.message.toolName))
		) {
			try {
				const externalized = await externalizeLargeToolOutput(event.message.content, this._toolOutputDir);
				if (externalized) {
					event.message.content = externalized.content;
					toolOutput = externalized.toolOutput;
				}
			} catch {
				// Preserve the original result when the complete output could not be saved.
			}
		}

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			let durableAssistantEvidence: RuntimeAssistantMessageEvidence | undefined;
			if (this._durableTurn && (event.message.role === "assistant" || event.message.role === "toolResult")) {
				try {
					if (event.message.role === "assistant") {
						this._repairPendingDurableToolCallsBeforeAssistant(event.message);
						durableAssistantEvidence = this._validateDurableAssistantToolCalls(event.message);
					} else {
						this._validateDurableToolResult(event.message);
					}
				} catch (error) {
					this._discardUnpersistedAgentMessage(event.message);
					throw new DurableMessageValidationError(error);
				}
			}
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(
					event.message,
					event.message.role === "toolResult" ? toolOutput : undefined,
					this._durableTurn?.turnId,
				);
				if (event.message.role === "user" && this._durableTurn) {
					this._durableTerminalEvidence = undefined;
				} else if (event.message.role === "assistant" && this._durableTurn) {
					if (!durableAssistantEvidence) throw new Error("Missing validated durable assistant evidence");
					for (const call of durableAssistantEvidence.toolCalls) {
						this._durableToolCalls.set(call.toolCallId, call.toolName);
						this._durablePendingToolCalls.set(call.toolCallId, call.toolName);
					}
					this._durableTerminalEvidence = durableAssistantEvidence.outcome;
				} else if (event.message.role === "toolResult" && this._durableTurn) {
					this._durablePendingToolCalls.delete(event.message.toolCallId);
					this._durableToolResults.add(event.message.toolCallId);
					const toolName = this._durableStartedTools.get(event.message.toolCallId);
					if (toolName !== undefined) {
						this.sessionManager.appendRuntimeControl({
							type: "runtime_tool",
							turnId: this._durableTurn.turnId,
							toolCallId: event.message.toolCallId,
							toolName,
							state: "completed",
						});
						this._durableCompletedTools.add(event.message.toolCallId);
					}
				}
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	}

	private _validateDurableAssistantToolCalls(message: AssistantMessage): RuntimeAssistantMessageEvidence {
		const evidence = validateRuntimeAssistantMessageEvidence(message);
		const calls = new Set<string>();
		for (const call of evidence.toolCalls) {
			if (this._durableToolCalls.has(call.toolCallId) || calls.has(call.toolCallId)) {
				throw new Error(`Durable tool call ID was reused in one turn: ${call.toolCallId}`);
			}
			calls.add(call.toolCallId);
		}
		return evidence;
	}

	private _validateDurableToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const evidence = validateRuntimeToolResultMessageEvidence(message);
		const expectedToolName = this._durablePendingToolCalls.get(evidence.toolCallId);
		if (expectedToolName === undefined) {
			throw new Error(`Durable tool result has no pending tool call: ${evidence.toolCallId}`);
		}
		if (expectedToolName !== evidence.toolName) {
			throw new Error(`Durable tool result name changed for ${evidence.toolCallId}`);
		}
	}

	private _discardUnpersistedAgentMessage(message: AgentMessage): void {
		const index = this.agent.state.messages.lastIndexOf(message);
		if (index !== -1) this.agent.state.messages.splice(index, 1);
	}

	private _repairPendingDurableToolCallsBeforeAssistant(nextAssistant: AssistantMessage): void {
		const turn = this._durableTurn;
		if (!turn || this._durablePendingToolCalls.size === 0) return;
		for (const [toolCallId, toolName] of this._durablePendingToolCalls) {
			if (this._durableStartedTools.has(toolCallId)) {
				throw new Error(`Assistant advanced while durable tool call remained active: ${toolCallId}`);
			}
			const message = appendSyntheticRuntimeToolResult(this.sessionManager, turn.turnId, toolCallId, toolName);
			const currentIndex = this.agent.state.messages.lastIndexOf(nextAssistant);
			if (currentIndex === -1) this.agent.state.messages.push(message);
			else this.agent.state.messages.splice(currentIndex, 0, message);
			this._durablePendingToolCalls.delete(toolCallId);
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect. */
	private _handleAgentEvent = (event: AgentEvent): Promise<void> => {
		const scope: AgentEventPersistenceScope = { owner: this, active: true };
		const task = agentEventPersistenceContext.run(scope, async () => {
			try {
				await this._processAgentEvent(event);
			} finally {
				scope.active = false;
			}
		});
		if (event.type !== "message_end") return task;

		this._inFlightEventPersistence.add(task);
		void task.then(
			() => this._inFlightEventPersistence.delete(task),
			(error) => {
				this._inFlightEventPersistence.delete(task);
				if (!(error instanceof DurableMessageValidationError)) this._eventPersistenceFailure ??= error;
			},
		);
		return task;
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._dispose(false);
	}

	/** @internal Runtime lifecycle entry after accepted work and recovery have drained. */
	disposeFromRuntime(): void {
		this._dispose(true);
	}

	private _dispose(runtimeOwned: boolean): void {
		if (
			!this._disposeCoreComplete &&
			!runtimeOwned &&
			(this._durableTurn !== undefined ||
				this._durableQueues.size > 0 ||
				this._durableRecoveryRequired ||
				this._runtimeTeardownRequested ||
				this._eventPersistenceFailure !== undefined)
		) {
			throw new Error(
				"Cannot directly dispose a runtime-owned durable session; dispose its AgentSessionRuntime instead",
			);
		}
		if (
			!this._disposeCoreComplete &&
			(this._isAgentRunActive || this._isAgentSettling || this._inFlightEventPersistence.size > 0)
		) {
			throw new Error(
				"Cannot dispose an active agent session; await abortAndDrainAgentEventPersistence() before disposing",
			);
		}
		const errors: unknown[] = [];
		if (!this._disposeCoreComplete) {
			try {
				try {
					this.abortRetry();
					this.abortCompaction();
					this.abortBranchSummary();
					this.abortBash();
					this.agent.abort();
				} catch {
					// Continue invalidating the session even if an abort hook throws.
				}

				this._extensionRunner.invalidate(
					"This extension ctx is stale after session replacement or reload. Do not use a captured arcmind or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
				);
				this._disconnectFromAgent();
				this._eventListeners = [];
				cleanupSessionResources(this.sessionId);
				if (this._ephemeralToolOutputDir) {
					rmSync(this._ephemeralToolOutputDir, { recursive: true, force: true });
				}
				this._disposeCoreComplete = true;
			} catch (error) {
				errors.push(error);
			}
		}

		if (!this._resourceLoaderDisposed) {
			try {
				this._resourceLoader.dispose?.();
				this._resourceLoaderDisposed = true;
			} catch (error) {
				errors.push(error);
			}
		}

		if (!this._mcpManagerDisposed) {
			try {
				this._unsubscribeMcpCatalog?.();
				this._unsubscribeMcpCatalog = undefined;
				this._mcpManager?.dispose();
				this._mcpManagerDisposed = true;
			} catch (error) {
				errors.push(error);
			}
		}

		if (!this._sessionManagerClosed) {
			try {
				// Release the cross-process writer lease only after agent and extension activity stops.
				this.sessionManager.close();
				this._sessionManagerClosed = true;
			} catch (error) {
				errors.push(error);
			}
		}

		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) {
			throw new AggregateError(errors, "Failed to dispose agent session");
		}
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		// Preserve the public event contract: agent_settled observers see the
		// provider run as idle. Lifecycle waits and disposal additionally guard
		// _isAgentSettling so the writer lease cannot be released mid-callback.
		return !this._isAgentRunActive;
	}

	/** Durable direct admission stays active across async prompt preflight and settlement. */
	get activeDurableTurnId(): string | undefined {
		return this._durableTurn?.turnId;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	getAutoMemorySnapshot(): AutoMemorySnapshot | undefined {
		return this._agentDir ? loadAutoMemory(this._agentDir, this._cwd) : undefined;
	}

	getDreamStatus(limit = 10): DreamStatusSnapshot {
		return {
			enabled: this._includeAutoMemory && this.settingsManager.getAutoMemoryEnabled(),
			active: this._activeDream ? { ...this._activeDream } : undefined,
			recent: this._agentDir ? readDreamHistory(this._agentDir, limit) : [],
		};
	}

	async waitForDream(): Promise<void> {
		await this._dreamPromise?.catch(() => undefined);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	private _canActivateWebSearch(): boolean {
		return this._allowedToolNames ? this._allowedToolNames.has("web_search") : this._defaultBuiltinToolsEnabled;
	}

	setWebSearchEnabled(enabled: boolean): void {
		this.settingsManager.setWebSearchEnabled(enabled);
		const names = new Set(this.getActiveToolNames());
		if (enabled && this._canActivateWebSearch() && this._toolRegistry.has("web_search")) names.add("web_search");
		else names.delete("web_search");
		this.setActiveToolsByName([...names]);
	}

	setWebSearchProvider(provider: WebSearchProvider): void {
		this.settingsManager.setWebSearchProvider(provider);
	}

	getMcpStatus(): McpServerStatus[] {
		return this._mcpManager?.getStatus() ?? [];
	}

	getMcpSecretEnvironment(name: string): Record<string, string> {
		return this._mcpManager?.getSecretEnvironment(name) ?? {};
	}

	logoutMcpServer(name: string): Promise<void> {
		if (!this._mcpManager) return Promise.reject(new Error("MCP is not available in this session"));
		return this._mcpManager.logout(name);
	}

	setMcpSecret(name: string, credential: Omit<McpSecretCredential, "type">): Promise<void> {
		if (!this._mcpManager) return Promise.reject(new Error("MCP is not available in this session"));
		return this._mcpManager.setSecret(name, credential);
	}

	deleteMcpCredential(name: string): void {
		this._mcpManager?.deleteCredential(name);
	}

	restartMcpServers(name?: string): Promise<void> {
		if (!this._mcpManager) return Promise.reject(new Error("MCP is not available in this session"));
		return this._mcpManager.restart(name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Re-read memory indexes and rebuild the current base system prompt. */
	refreshSystemPrompt(): void {
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current immutable session classification mode. */
	get mode(): AgentMode {
		return this.sessionManager.getMode();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingSelection }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingSelection }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
		const autoMemory =
			this._includeAutoMemory && this.settingsManager.getAutoMemoryEnabled()
				? this.getAutoMemorySnapshot()
				: undefined;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			autoMemory,
		};
		const base = buildSystemPrompt(this._baseSystemPromptOptions);
		const additional =
			typeof this._additionalSystemPrompt === "function"
				? this._additionalSystemPrompt()
				: this._additionalSystemPrompt;
		return additional?.trim() ? `${base}\n\n${additional.trim()}` : base;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/** Validate an app-server prompt without retaining provider-ready image payloads. */
	prepareDurablePrompt(input: DurablePromptInput): void {
		if (!this.sessionManager.isPersisted()) {
			throw new Error("Durable prompt submission requires a persisted session");
		}
		if (!this.settingsManager.isProjectTrusted()) {
			throw new Error("Project is not trusted");
		}
		if (this._durableRecoveryRequired) {
			throw new Error("The durable prompt queue must be recovered before accepting more work");
		}
		if (!this.model) throw new Error(formatNoModelSelectedMessage());
		if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}
		if (input.text.startsWith("/")) this._throwIfExtensionCommand(input.text);
		if (input.images?.length) this.sessionManager.validateDurableImageRefs(input.images);
	}

	assertDurablePromptCapacity(input: DurablePromptInput): void {
		const reserved = (this._durableTurn?.operations.length ?? 0) + this._durableQueues.size;
		if (reserved >= MAX_DURABLE_TURN_OPERATIONS) {
			throw new Error(`A durable runtime turn cannot contain more than ${MAX_DURABLE_TURN_OPERATIONS} operations`);
		}
		if (
			this._durableResidentPayloadBytes + durablePromptResidentPayloadBytes(input) >
			MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES
		) {
			throw new Error(
				`Durable runtime turn payloads cannot exceed ${MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES} resident bytes`,
			);
		}
	}

	setDurableOperationTurnListener(listener?: (operationId: string, turnId: string) => void): void {
		this._durableOperationTurnListener = listener;
	}

	/** Persist the authoritative direct-turn start before provider work is scheduled. */
	beginDurableDirectTurn(identity: RuntimeRequestIdentity, input: DurablePromptInput): void {
		if (this._durableTurn) throw new Error("A durable runtime turn is already active");
		const residentPayloadBytes = durablePromptResidentPayloadBytes(input);
		this.sessionManager.appendRuntimeControl({
			type: "runtime_turn",
			turnId: identity.turnId,
			operationIds: [identity.operationId],
			state: "started",
			consumedQueueItemIds: [],
		});
		this._durableTurn = {
			turnId: identity.turnId,
			operations: [{ identity, input, kind: "turn", residentPayloadBytes }],
			consumedQueueItemIds: [],
		};
		this._durableResidentPayloadBytes += residentPayloadBytes;
		this._durableOperationTurnListener?.(identity.operationId, identity.turnId);
		this._durableTerminalEvidence = undefined;
	}

	/** Queue one already-accepted prompt with its durable identity. */
	enqueueAcceptedDurablePrompt(
		input: DurablePromptInput,
		identity: RuntimeRequestIdentity,
		behavior: "steer" | "followUp",
	): void {
		let text = this._expandSkillCommand(input.text, true);
		text = expandPromptTemplate(text, [...this.promptTemplates], MAX_DURABLE_PROMPT_TEXT_BYTES);
		const textBytes = Buffer.byteLength(text, "utf8");
		if (textBytes > MAX_DURABLE_PROMPT_TEXT_BYTES) {
			throw new Error(`Expanded durable prompt cannot exceed ${MAX_DURABLE_PROMPT_TEXT_BYTES} UTF-8 bytes`);
		}
		const queue = behavior === "followUp" ? "follow_up" : "steer";
		if (this._durableQueues.has(identity.queueItemId)) {
			throw new Error(`Durable queue item is already enqueued: ${identity.queueItemId}`);
		}
		const residentPayloadBytes = durablePromptResidentPayloadBytes(input, text);
		if (this._durableResidentPayloadBytes + residentPayloadBytes > MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES) {
			throw new Error(
				`Durable runtime turn payloads cannot exceed ${MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES} resident bytes`,
			);
		}
		this._durableQueues.set(identity.queueItemId, {
			operation: { identity, input, kind: "steer", residentPayloadBytes },
			queue,
		});
		this._durableResidentPayloadBytes += residentPayloadBytes;
		try {
			const queueIdentity = { operationId: identity.operationId, queueItemId: identity.queueItemId };
			if (behavior === "followUp") this._enqueueFollowUp(text, undefined, queueIdentity);
			else this._enqueueSteer(text, undefined, queueIdentity);
		} catch (error) {
			this._durableQueues.delete(identity.queueItemId);
			this._durableResidentPayloadBytes -= residentPayloadBytes;
			throw error;
		}
	}

	/** Execute accepted work; final durable markers settle before this promise. */
	async runAcceptedDurablePrompt(turnId: string, input: DurablePromptInput): Promise<void> {
		const context: DurablePromptExecutionScope = { owner: this, turnId, input, active: true };
		try {
			if (this._runtimeTeardownRequested) throw new Error("The agent session is tearing down");
			const images = input.images?.length ? this.sessionManager.resolveDurableImageRefs(input.images) : undefined;
			await durablePromptExecutionContext.run(context, () => this.prompt(input.text, { images }));
		} finally {
			context.active = false;
			if (!this._isAgentRunActive && this._durableTurn?.turnId === turnId) this._finishDurableTurn();
		}
	}

	private _finishDurableTurn(): void {
		const turn = this._durableTurn;
		if (!turn) return;

		for (const [toolCallId, toolName] of this._durableStartedTools) {
			if (this._durableCompletedTools.has(toolCallId)) continue;
			if (this._durableToolResults.has(toolCallId)) {
				this.sessionManager.appendRuntimeControl({
					type: "runtime_tool",
					turnId: turn.turnId,
					toolCallId,
					toolName,
					state: "completed",
				});
				this._durableCompletedTools.add(toolCallId);
				continue;
			}
			this.sessionManager.appendRuntimeControl({
				type: "runtime_tool",
				turnId: turn.turnId,
				toolCallId,
				toolName,
				state: "interrupted",
			});
			const message = appendSyntheticRuntimeToolResult(this.sessionManager, turn.turnId, toolCallId, toolName);
			this.agent.state.messages.push(message);
			this._durablePendingToolCalls.delete(toolCallId);
		}
		for (const [toolCallId, toolName] of this._durablePendingToolCalls) {
			const message = appendSyntheticRuntimeToolResult(this.sessionManager, turn.turnId, toolCallId, toolName);
			this.agent.state.messages.push(message);
		}

		const state =
			this._durableTerminalEvidence === "completed" && this._durablePendingToolCalls.size === 0
				? "completed"
				: "interrupted";
		const operationIds = turn.operations.map((operation) => operation.identity.operationId);
		this.sessionManager.appendRuntimeControl({
			type: "runtime_turn",
			turnId: turn.turnId,
			operationIds,
			state,
			consumedQueueItemIds: turn.consumedQueueItemIds,
		});
		for (const operation of turn.operations) {
			this.sessionManager.appendRuntimeControl({
				type: "runtime_operation",
				operationId: operation.identity.operationId,
				requestId: operation.identity.requestId,
				requestHash: operation.identity.requestHash,
				kind: operation.kind,
				state,
				turnId: turn.turnId,
				...(state === "interrupted"
					? { error: { code: "RUNTIME_INTERRUPTED", message: "The operation did not complete." } }
					: {}),
			});
		}
		this._durableResidentPayloadBytes -= turn.operations.reduce(
			(total, operation) => total + operation.residentPayloadBytes,
			0,
		);
		if (this._durableQueues.size > 0) this._durableRecoveryRequired = true;
		this._durableTurn = undefined;
		this._durableStartedTools.clear();
		this._durableToolResults.clear();
		this._durableCompletedTools.clear();
		this._durableToolCalls.clear();
		this._durablePendingToolCalls.clear();
		this._durableTerminalEvidence = undefined;
	}

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		const errors: unknown[] = [];
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} catch (error) {
			errors.push(error);
		}
		this._systemPromptOverride = undefined;
		try {
			this._flushPendingBashMessages();
		} catch (error) {
			errors.push(error);
		}
		try {
			this._finishDurableTurn();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this._emitAgentSettled();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to run and settle the durable agent turn");
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		if (this._runtimeTeardownRequested || this._stopCurrentRunAfterAbort || this._durableRecoveryRequired)
			return false;
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via arcmind.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		this._assertDurablePromptExecutionOwner();
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			if (expandPromptTemplates && text.startsWith("/") && this.isCompacting) {
				const spaceIndex = text.indexOf(" ");
				const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
				if (this._extensionRunner.getCommand(commandName)) {
					throw new Error("Wait for compaction to finish before running extension commands");
				}
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via arcmind.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				const durableScope = durablePromptExecutionContext.getStore();
				const durableExpansion = durableScope?.owner === this && durableScope.active;
				expandedText = this._expandSkillCommand(expandedText, durableExpansion);
				expandedText = expandPromptTemplate(
					expandedText,
					[...this.promptTemplates],
					durableExpansion ? MAX_DURABLE_PROMPT_TEXT_BYTES : undefined,
				);
			}
			this._accountActiveDurablePromptPayload(expandedText, currentImages);

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string, failOnReadError = false): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readBoundedUtf8FileSync(skill.filePath, MAX_DURABLE_PROMPT_TEXT_BYTES);
			const body = stripFrontmatter(content).trim();
			const prefix = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n`;
			const suffix = "\n</skill>";
			if (
				failOnReadError &&
				Buffer.byteLength(prefix, "utf8") +
					Buffer.byteLength(body, "utf8") +
					Buffer.byteLength(suffix, "utf8") +
					(args ? Buffer.byteLength(args, "utf8") + 2 : 0) >
					MAX_DURABLE_PROMPT_TEXT_BYTES
			) {
				throw new Error(`Expanded durable prompt cannot exceed ${MAX_DURABLE_PROMPT_TEXT_BYTES} UTF-8 bytes`);
			}
			const skillBlock = `${prefix}${body}${suffix}`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			if (failOnReadError) throw err;
			return text; // Return original on error
		}
	}

	private _accountActiveDurablePromptPayload(text: string, images: ImageContent[] | undefined): void {
		const scope = durablePromptExecutionContext.getStore();
		if (scope?.owner !== this || !scope.active) return;
		const textBytes = Buffer.byteLength(text, "utf8");
		if (textBytes > MAX_DURABLE_PROMPT_TEXT_BYTES) {
			throw new Error(`Expanded durable prompt cannot exceed ${MAX_DURABLE_PROMPT_TEXT_BYTES} UTF-8 bytes`);
		}
		if ((images?.length ?? 0) > MAX_DURABLE_PROMPT_IMAGES) {
			throw new Error(`Expanded durable prompts support at most ${MAX_DURABLE_PROMPT_IMAGES} images`);
		}
		const maxImagePayloadBytes = 4 * Math.ceil(MAX_DURABLE_IMAGE_BYTES / 3);
		let imagePayloadBytes = 0;
		for (const image of images ?? []) {
			if (typeof image.data !== "string" || image.data.length > maxImagePayloadBytes) {
				throw new Error(`Expanded durable prompt image payload cannot exceed ${maxImagePayloadBytes} bytes`);
			}
			imagePayloadBytes += image.data.length;
		}
		const maxImagePayloadTotal = 4 * Math.ceil(MAX_DURABLE_PROMPT_IMAGE_BYTES / 3);
		if (imagePayloadBytes > maxImagePayloadTotal) {
			throw new Error(`Expanded durable prompt image payloads cannot exceed ${maxImagePayloadTotal} total bytes`);
		}
		const turn = this._durableTurn;
		const operation = turn?.operations.find((item) => item.input === scope.input);
		if (!operation) throw new Error(`Durable runtime turn ${scope.turnId} lost its accepted operation`);
		const residentPayloadBytes = textBytes + imagePayloadBytes;
		const nextTotal = this._durableResidentPayloadBytes - operation.residentPayloadBytes + residentPayloadBytes;
		if (nextTotal > MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES) {
			if (this._durableQueues.size > 0) this._durableRecoveryRequired = true;
			throw new Error(
				`Durable runtime turn payloads cannot exceed ${MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES} resident bytes`,
			);
		}
		this._durableResidentPayloadBytes = nextTotal;
		operation.residentPayloadBytes = residentPayloadBytes;
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		this._assertDurablePromptExecutionOwner();
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		this._assertDurablePromptExecutionOwner();
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._enqueueSteer(text, images);
	}

	private _enqueueSteer(text: string, images?: ImageContent[], identity?: AgentQueueIdentity): void {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({ role: "user", content, timestamp: Date.now() }, identity);
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._enqueueFollowUp(text, images);
	}

	private _enqueueFollowUp(text: string, images?: ImageContent[], identity?: AgentQueueIdentity): void {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({ role: "user", content, timestamp: Date.now() }, identity);
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		this._assertDurablePromptExecutionOwner();
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	private _assertDurablePromptExecutionOwner(): void {
		if (this._runtimeTeardownRequested) throw new Error("The agent session is tearing down");
		if (this._durableRecoveryRequired) {
			throw new Error("The durable prompt queue must be recovered before running more work");
		}
		const turnId = this._durableTurn?.turnId;
		if (turnId === undefined) return;
		const context = durablePromptExecutionContext.getStore();
		if (context?.owner === this && context.turnId === turnId && context.active) return;
		throw new Error("A durable app-server prompt has already been admitted for this session");
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this.agent.clearAllQueues();
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/** @internal Runtime lifecycle guard against awaiting its own agent-event task. */
	assertCanDrainAgentEventPersistence(): void {
		const scope = agentEventPersistenceContext.getStore();
		if (scope?.owner === this && scope.active) {
			throw new Error(
				"Session lifecycle changes cannot be awaited from an agent event handler before message persistence completes",
			);
		}
	}

	private async _drainAgentEventPersistence(): Promise<void> {
		const errors: unknown[] = this._eventPersistenceFailure === undefined ? [] : [this._eventPersistenceFailure];
		this._eventPersistenceFailure = undefined;
		while (this._inFlightEventPersistence.size > 0) {
			const tasks = [...this._inFlightEventPersistence];
			const results = await Promise.allSettled(tasks);
			for (let index = 0; index < results.length; index++) {
				this._inFlightEventPersistence.delete(tasks[index]!);
				const result = results[index]!;
				if (result.status === "rejected" && !errors.includes(result.reason)) {
					errors.push(result.reason);
				}
			}
		}
		this._eventPersistenceFailure = undefined;
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to persist agent events");
	}

	/** Permanently stop new provider work before runtime-owned teardown begins. */
	beginRuntimeTeardown(): void {
		this._runtimeTeardownRequested = true;
		this._stopCurrentRunAfterAbort = true;
	}

	/** Abort the active turn and keep the session lease until all durable event writes settle. */
	async abortAndDrainAgentEventPersistence(): Promise<void> {
		this.assertCanDrainAgentEventPersistence();
		if (this._durableQueues.size > 0) this._durableRecoveryRequired = true;
		this._stopCurrentRunAfterAbort = true;
		this.abortRetry();
		this.agent.abort();
		const results = await Promise.allSettled([this.waitForIdle(), this._drainAgentEventPersistence()]);
		const errors = results
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		try {
			// A final pass covers persistence tasks emitted while the active turn was aborting.
			await this._drainAgentEventPersistence();
		} catch (error) {
			if (!errors.includes(error)) errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to abort and persist the active agent turn");
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		if (this._durableQueues.size > 0) this._durableRecoveryRequired = true;
		// Preserve the long-standing CLI behavior where aborting a non-durable
		// provider response can still deliver an already queued steer/follow-up.
		// Durable turns stop instead: queued durable work must be recovered, never
		// consumed by a fresh provider request after an abort.
		if (this._durableTurn) this._stopCurrentRunAfterAbort = true;
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle && !this._isAgentSettling) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingSelection = this.getThinkingSelection();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingSelection(thinkingSelection);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingSelection = next.thinkingLevel ?? this.getThinkingSelection();

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingSelection(thinkingSelection);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingSelection = this.getThinkingSelection();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingSelection(thinkingSelection);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (!this.sessionManager.getSubagentsEnabled() && (this.supportsThinking() || effectiveLevel !== "off")) {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/** User-facing composite selection; provider requests continue to use thinkingLevel. */
	getThinkingSelection(): ThinkingSelection {
		return this.sessionManager.getSubagentsEnabled() ? "ultra" : this.thinkingLevel;
	}

	getAvailableThinkingSelections(): ThinkingSelection[] {
		const selections: ThinkingSelection[] = this.getAvailableThinkingLevels();
		if (this._ultraAvailable) selections.push("ultra");
		return selections;
	}

	setThinkingSelection(selection: ThinkingSelection): void {
		if (selection !== "ultra") {
			if (this.sessionManager.getSubagentsEnabled()) this.sessionManager.setSubagentsEnabled(false);
			this.setThinkingLevel(selection);
			this.settingsManager.setDefaultThinkingLevel(selection);
			this._emit({
				type: "thinking_selection_changed",
				selection,
				actualThinkingLevel: this.thinkingLevel,
				subagentsEnabled: false,
			});
			return;
		}
		if (!this._ultraAvailable || !this.sessionManager.isPersisted() || this.sessionManager.getHeader()?.subagent) {
			throw new Error("Ultra requires a persisted primary Code AgentSessionRuntime");
		}
		if (!this.sessionManager.getSubagentsEnabled()) this.sessionManager.setSubagentsEnabled(true);
		const actual = getHighestSupportedThinkingLevel(this.model);
		this.setThinkingLevel(actual);
		this.settingsManager.setDefaultThinkingLevel("ultra");
		this._emit({
			type: "thinking_selection_changed",
			selection: "ultra",
			actualThinkingLevel: actual,
			subagentsEnabled: true,
		});
	}

	cycleThinkingSelection(): ThinkingSelection | undefined {
		const selections = this.getAvailableThinkingSelections();
		if (selections.length === 0) return undefined;
		const current = selections.indexOf(this.getThinkingSelection());
		const next = selections[(current + 1) % selections.length];
		this.setThinkingSelection(next);
		return next;
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private async _compactWithDream<T>(
		preparation: CompactionPreparation,
		reason: DreamTrigger,
		signal: AbortSignal,
		compactWork: () => Promise<T>,
	): Promise<T> {
		signal.throwIfAborted();
		if (!this._includeAutoMemory || !this._agentDir || !this.settingsManager.getAutoMemoryEnabled() || !this.model) {
			return compactWork();
		}

		const active: DreamActiveRun = {
			id: randomUUID(),
			sessionId: this.sessionId,
			project: this._cwd,
			trigger: reason,
			startedAt: new Date().toISOString(),
		};
		this._activeDream = active;
		const agentDir = this._agentDir;
		const cwd = this._cwd;
		const model = this.model;
		const thinkingLevel = this.thinkingLevel;
		const streamFn = this.agent.streamFn;
		const getApiKey = this.agent.getApiKey;
		const transport = this.agent.transport;
		const thinkingBudgets = this.agent.thinkingBudgets;
		const maxRetryDelayMs = this.agent.maxRetryDelayMs;
		const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const dreamPromise = Promise.resolve().then(() =>
			this._memoryDreamRunner({
				...active,
				agentDir,
				cwd,
				model,
				thinkingLevel,
				streamFn,
				...(getApiKey ? { getApiKey } : {}),
				transport,
				...(thinkingBudgets ? { thinkingBudgets } : {}),
				...(maxRetryDelayMs !== undefined ? { maxRetryDelayMs } : {}),
				messages,
				signal,
			}),
		);
		const trackedDream = dreamPromise
			.then((dream) => {
				if (dream.status === "success" || dream.reason === "Memory changed while Dream was running") {
					this.refreshSystemPrompt();
				}
				return dream;
			})
			.finally(() => {
				if (this._activeDream?.id === active.id) this._activeDream = undefined;
			});
		void trackedDream.catch(() => undefined);
		this._dreamPromise = trackedDream;

		try {
			return await compactWork();
		} finally {
			try {
				await trackedDream;
			} catch {
				// Dream must never replace the Compact result.
			} finally {
				if (this._dreamPromise === trackedDream) this._dreamPromise = undefined;
			}
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		if (this.isCompacting) throw new Error("Compaction already in progress");
		this._compactionAbortController = new AbortController();
		this._disconnectFromAgent();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			await this.abort();
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const generated = await this._compactWithDream(
				preparation,
				"manual",
				this._compactionAbortController.signal,
				async () => {
					if (extensionCompaction) return extensionCompaction;
					return compact(
						preparation,
						this.model!,
						apiKey,
						headers,
						customInstructions,
						this._compactionAbortController!.signal,
						this.thinkingLevel,
						this.agent.streamFn,
						env,
					);
				},
			);
			const { summary, firstKeptEntryId, tokensBefore, details } = generated;

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error, or reported usage exceeded
		// the configured window. A successful response over the configured window should compact
		// but must not retry: the assistant answer already completed and agent.continue() cannot
		// continue from an assistant message.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (this.agent.streamFn === streamSimple) {
				const authResult = await this._modelRegistry.getApiKeyAndHeaders(this.model);
				if (!authResult.ok || !authResult.apiKey) {
					return false;
				}
				apiKey = authResult.apiKey;
				headers = authResult.headers;
				env = authResult.env;
			} else {
				({ apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model));
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._autoCompactionAbortController = new AbortController();
			started = true;
			this._emit({ type: "compaction_start", reason });

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			const generated = await this._compactWithDream(
				preparation,
				reason,
				this._autoCompactionAbortController.signal,
				async () => {
					if (extensionCompaction) return extensionCompaction;
					return compact(
						preparation,
						this.model!,
						apiKey,
						headers,
						undefined,
						this._autoCompactionAbortController!.signal,
						this.thinkingLevel,
						this.agent.streamFn,
						env,
					);
				},
			);
			const { summary, firstKeptEntryId, tokensBefore, details } = generated;

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				const aborted =
					this._autoCompactionAbortController?.signal.aborted === true ||
					(error instanceof Error && error.name === "AbortError");
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage: aborted
						? undefined
						: reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerExtensionProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterExtensionProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			this._trustedControlToolNames.has(name) ||
			((!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name));

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const baseToolSource = this._baseToolsOverride ? "sdk" : "builtin";
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const mcpTools = this._mcpManager
			? createMcpToolDefinitions(this._mcpManager, this)
			: { direct: [], deferred: [] };
		const directMcpTools = mcpTools.direct.filter((definition) => isAllowedTool(definition.name));
		const deferredMcpTools = mcpTools.deferred.filter(({ definition }) => isAllowedTool(definition.name));
		const deferredMcpNames = new Set(deferredMcpTools.map(({ definition }) => definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<${baseToolSource}:${name}>`, { source: baseToolSource }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		for (const definition of directMcpTools) {
			definitionRegistry.set(definition.name, {
				definition: definition as ToolDefinition,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
			});
		}
		for (const { definition, serverName } of deferredMcpTools) {
			definitionRegistry.set(definition.name, {
				definition: definition as ToolDefinition,
				sourceInfo: createSyntheticSourceInfo(`<mcp:${serverName}:${definition.name}>`, {
					source: `mcp:${serverName}`,
				}),
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<${baseToolSource}:${definition.name}>`, {
						source: baseToolSource,
					}),
				})),
			runner,
		);
		const wrappedDirectMcpTools = wrapRegisteredTools(
			directMcpTools.map((definition) => ({
				definition: definition as ToolDefinition,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
			})),
			runner,
		);
		const wrappedDeferredMcpTools = wrapRegisteredTools(
			deferredMcpTools.map(({ definition, serverName }) => ({
				definition: definition as ToolDefinition,
				sourceInfo: createSyntheticSourceInfo(`<mcp:${serverName}:${definition.name}>`, {
					source: `mcp:${serverName}`,
				}),
			})),
			runner,
		);

		const toolRegistry = new Map(
			wrappedBuiltInTools.map((tool) => {
				const guarded = this._withPermissionGuard(tool);
				return [guarded.name, guarded] as const;
			}),
		);
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			const guarded = this._withPermissionGuard(tool);
			toolRegistry.set(guarded.name, guarded);
		}
		for (const tool of [...wrappedDirectMcpTools, ...wrappedDeferredMcpTools]) {
			const guarded = this._withPermissionGuard(tool);
			toolRegistry.set(guarded.name, guarded);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName) && !deferredMcpNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		for (const tool of wrappedDirectMcpTools) nextActiveToolNames.push(tool.name);

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		this._runtimeShellCommandPrefix = shellCommandPrefix;
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						operations: this._createPermissionBashOperations(shellPath),
						outputDir: this._toolOutputDir,
					},
					grep: { subprocess: this._createToolSubprocessExecutor("grep", shellPath) },
					find: { subprocess: this._createToolSubprocessExecutor("find", shellPath) },
					webSearch: {
						getSettings: () => this.settingsManager.getWebSearchSettings(),
						getApiKey: (provider) => resolveWebSearchApiKey(this._modelRegistry.authStorage, provider),
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: [
					"read",
					"grep",
					"bash",
					"edit",
					"write",
					"web_fetch",
					...(this.settingsManager.getWebSearchSettings().enabled && this._canActivateWebSearch()
						? ["web_search"]
						: []),
					...(this.sessionManager.getHeader()?.subagent ? [] : ["update_plan"]),
				];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		const globallyEnabledToolNames = this.settingsManager.getWebSearchSettings().enabled
			? baseActiveToolNames
			: baseActiveToolNames.filter((name) => name !== "web_search");
		this._refreshToolRegistry({
			activeToolNames: globallyEnabledToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		await this._mcpManager?.reload();
		this.syncQueueModesFromSettings();
		this._modelRegistry.resetExtensionProviders();
		this._refreshCurrentModelFromRegistry();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async authorizeUserBash(command: string): Promise<UserBashAuthorization> {
		const prefix = this.settingsManager.getShellCommandPrefix();
		const effectiveCommand = prefix ? `${prefix}\n${command}` : command;
		const actionId = `user-bash:${randomUUID()}`;
		await this._authorizePermissionAction({
			actionId,
			toolName: "bash",
			provenance: "builtin",
			args: { command },
			actionSource: "user-bash",
			effectiveCommand,
		});
		return { actionId, command };
	}

	cancelUserBashAuthorization(authorization: UserBashAuthorization): void {
		const pending = this._permissionGrants.get(authorization.actionId);
		if (pending?.action.toolName === "bash") this._permissionGrants.delete(authorization.actionId);
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			operations?: BashOperations;
			authorization?: UserBashAuthorization;
		},
	): Promise<BashResult> {
		if (this.isCompacting) throw new Error("Wait for compaction to finish before running bash");

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
		const authorization = options?.authorization ?? (await this.authorizeUserBash(command));
		if (authorization.command !== command) {
			this.cancelUserBashAuthorization(authorization);
			throw new Error("Bash command changed after permission approval");
		}
		this._bashAbortController = new AbortController();

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				this._createPermissionBashOperations(shellPath, options?.operations),
				{
					actionId: authorization.actionId,
					onChunk,
					signal: this._bashAbortController.signal,
					outputDir: this._toolOutputDir,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.cancelUserBashAuthorization(authorization);
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				const usage = assistantMsg.usage;
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalCost += usage.cost.total;
			}
		}

		return {
			mode: this.mode,
			cwd: this.sessionManager.getCwd(),
			cwdOrigin: this.sessionManager.getCwdOrigin(),
			permissionMode: this.sessionManager.getPermissionSettings().mode,
			reviewerEnabled: this.sessionManager.getPermissionSettings().reviewerEnabled,
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
			mode: this.sessionManager.getMode(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
