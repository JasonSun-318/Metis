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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentQueueIdentity,
	AgentState,
	AgentTool,
	BeforeProviderRequestContext,
	BeforeQueueCommitContext,
	BeforeToolExecuteContext,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@metis/agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent, Tool } from "@metis/ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	estimateMessageTokens,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	streamSimple,
} from "@metis/ai/compat";
import { getProjectConfigDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizeActionPath, isPathInside, resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import type { AgentMode } from "./agent-mode.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	type AutoMemorySnapshot,
	getAutoMemoryRoot,
	getGlobalMemoryDirectory,
	getProjectMemoryDirectory,
	loadAutoMemory,
} from "./auto-memory.ts";
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
import {
	estimateContextUsageBreakdown,
	FIXED_CONTEXT_USAGE_CATEGORIES,
	mergeContextUsageBreakdown,
	reconcileContextUsageBreakdown,
	reconcileContextUsageBreakdownWithFixed,
} from "./context-usage-breakdown.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ContextUsageBreakdownItem,
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
import {
	buildGoalContinuationPrompt,
	buildGoalObjectiveUpdatedPrompt,
	clearThreadGoal,
	isActiveGoalStatus,
	isGoalUsageLimitError,
	readThreadGoal,
	type ThreadGoalStatus,
	validateGoalObjective,
	writeThreadGoal,
} from "./goal/index.ts";
import type { ThreadGoal } from "./goal/types.ts";
import {
	buildInteractiveBashReadOnlyRoots,
	createInteractiveBashBoundary,
	type InteractiveBashBoundary,
} from "./interactive-bash-boundary.ts";
import { externalizeLargeToolOutput, type PersistedToolOutput } from "./large-tool-output.ts";
import { createMcpToolDefinitions, type McpManager } from "./mcp/index.ts";
import { embeddingConfigKey, embedTexts as embedMemoryTexts } from "./memory/memory-embedder.ts";
import { collectMemoryEvidenceBatch, serializeExtractEvidence } from "./memory/memory-evidence.ts";
import {
	awaitWithAbort,
	type MemoryExtractStatusSnapshot,
	type RunMemoryExtractOptions,
} from "./memory/memory-extract.ts";
import { memoryProjectIdentity } from "./memory/memory-project.ts";
import { MEMORY_EMBEDDING_CREDENTIAL_ID } from "./memory/memory-service-settings.ts";
import { MemorySettingsTransaction } from "./memory/memory-settings-transaction.ts";
import type { MemoryHealth } from "./memory/memory-types.ts";
import { type SessionMemoryExtractInput, SessionMemoryRuntime } from "./memory/session-memory-runtime.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { isPermissionMode, narrowPermissionMode, type PermissionMode } from "./permission-mode.ts";
import type { RequestPermissionApproval } from "./permission-policy.ts";
import { PLAN_MODE_SYSTEM_PROMPT, planVisibleToolNames, projectPlanContext } from "./plan-mode.ts";
import type { CollaborationMode, PlanRef, StoredPlan } from "./plan-state.ts";
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
import {
	clearSessionAttachmentNonFiles,
	clearSessionWorkDir,
	createSessionWorkDir,
	getOwnedSessionAttachmentDir,
	getOwnedSessionWorkDirs,
	getSessionAttachmentDir,
} from "./session-attachments.ts";
import { SessionDeliveredArtifacts } from "./session-delivered-artifacts.ts";
import { createSessionId } from "./session-id.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionHeader } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionManager } from "./session-manager.ts";
import type { CwdOrigin } from "./session-workspace.ts";
import { type SettingsManager, VISION_PROVIDER_ID } from "./settings-manager.ts";
import { SKILL_USAGE_CUSTOM_TYPE, type SkillUsageRecord } from "./skills.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { buildAgentMailboxContent } from "./subagents/prompts.ts";
import { utf8Length } from "./subagents/trace.ts";
import {
	AGENT_TOOL_NAMES,
	type AgentMailboxTerminalEvent,
	MAX_AGENT_MAILBOX_DELIVERY_EVENTS,
	MAX_AGENT_MAILBOX_DELIVERY_UTF8_BYTES,
	MAX_AGENT_MAILBOX_PENDING_EVENTS,
} from "./subagents/types.ts";
import { createSubmitPlanToolDefinition } from "./submit-plan.ts";
import { type BuildSystemPromptOptions, buildSystemPromptWithParts, type SystemPromptPart } from "./system-prompt.ts";
import { canUseUltra, getHighestSupportedThinkingLevel, type ThinkingSelection } from "./thinking-selection.ts";
import { ToolAuthorizationRuntime } from "./tool-authorization-runtime.ts";
import { createToolResultMicrocompactor } from "./tool-result-microcompaction.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createDescribeImageToolDefinition } from "./tools/describe-image.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { resolveReadPathAsync } from "./tools/path-utils.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { UNATTENDED_TOOL_NAMES, type UnattendedExecutionProfile } from "./unattended-execution.ts";
import { resolveWebSearchApiKey, WEB_SEARCH_PROVIDER_INFO, type WebSearchProvider } from "./web-search-config.ts";

export { type ParsedSkillBlock, parseSkillBlock } from "./skills.ts";

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
			ultraSelected: boolean;
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
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "goal_changed"; goal: ThreadGoal | null }
	| { type: "plan_changed"; entryIds: readonly string[] }
	| { type: "collaboration_mode_changed"; collaborationMode: CollaborationMode };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

interface PreparedContextUsageSnapshot {
	readonly configurationFingerprint: string;
	readonly breakdown: readonly ContextUsageBreakdownItem[];
}

interface ReportedContextUsageSnapshot extends PreparedContextUsageSnapshot {
	readonly assistant: AssistantMessage;
	readonly tokens: number;
}

interface ContextUsageCalibration {
	readonly configurationFingerprint: string;
	readonly fixedBreakdown: readonly ContextUsageBreakdownItem[];
}

const AGENT_CONTEXT_TOOL_NAMES = new Set<string>(AGENT_TOOL_NAMES);

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Metis agent directory used for global and project memory. */
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
	/** Initial active built-in tool names. Primary default: [read, grep, bash, edit, write, web_fetch, set_tasks] */
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
	/** Host capability: only persisted primary AgentSessionRuntime instances set this. */
	ultraAvailable?: boolean;
	/** Host-owned prompt suffix used for runtime coordination profiles. */
	additionalSystemPrompt?: string | (() => string | undefined);
	/** Include automatic memory context and dream writes. Defaults to true. */
	includeAutoMemory?: boolean;
	/** Host-owned monotonic upper bound for a child session. */
	permissionModeCeiling?: () => PermissionMode;
	/** Host-owned workspace write ceiling independent of permission mode. */
	workspaceWritePolicy?: "inherit" | "deny";
	/** Internal execution boundary override used by runtime tests. */
	interactiveBashBoundary?: InteractiveBashBoundary;
	/** Host-only fail-closed profile for unattended runs. Never derive from user or model input. */
	unattendedExecution?: UnattendedExecutionProfile;
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
const IMMEDIATE_EXTERNALIZATION_BUILTINS = new Set([
	"web_fetch",
	"web_search",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
]);

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
	readonly kind: "turn" | "steer" | "next_turn";
	residentPayloadBytes: number;
}

interface DurableQueueMetadata {
	readonly operation: DurableOperationMetadata;
	readonly queue: "steer" | "follow_up";
}

interface PendingAgentMailboxEvent {
	readonly event: AgentMailboxTerminalEvent;
}

interface ActiveAgentMailboxDelivery {
	readonly deliveryId: string;
	readonly eventIds: readonly string[];
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
	readonly deliveredArtifacts: SessionDeliveredArtifacts | undefined;
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
	private readonly _durableTerminalStates = new Map<string, "completed" | "interrupted">();
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
	private readonly _knownAgentMailboxEventIds = new Set<string>();
	private readonly _pendingAgentMailboxEvents = new Map<string, PendingAgentMailboxEvent>();
	private _stagedAgentMailboxEventIds: readonly string[] = [];
	private _activeAgentMailboxDelivery?: ActiveAgentMailboxDelivery;
	private _requestedAgentMailboxEventIds?: ReadonlySet<string>;

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private readonly _memoryRuntime: SessionMemoryRuntime;
	private readonly _memorySettingsTransaction: MemorySettingsTransaction;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];
	private _activeWorkDir: string | undefined;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _skillRefreshGeneration = 0;
	private _skillRefreshPromise?: Promise<ReturnType<ResourceLoader["getSkills"]>>;
	private _skillFullRefreshRequested = false;
	private readonly _pendingSkillPaths = new Map<string, "project" | "user">();
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
	private _mcpToolNames = new Set<string>();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptParts: readonly SystemPromptPart[] = [];
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;
	private readonly _toolAuthorization: ToolAuthorizationRuntime;
	private readonly _interactiveBashBoundary?: InteractiveBashBoundary;
	private _runtimeShellCommandPrefix?: string;
	private readonly _ultraAvailable: boolean;
	private readonly _includeAutoMemory: boolean;
	private _autoMemoryRetrieved: Array<{ scope: "global" | "project"; text: string }> = [];
	private readonly _permissionModeCeiling?: () => PermissionMode;
	private readonly _workspaceWritePolicy: "inherit" | "deny";
	private readonly _unattendedExecution?: UnattendedExecutionProfile;
	private _additionalSystemPrompt?: string | (() => string | undefined);
	private _preparedContextUsage: PreparedContextUsageSnapshot | undefined;
	private _reportedContextUsage: ReportedContextUsageSnapshot | undefined;
	private _contextUsageCalibration: ContextUsageCalibration | undefined;
	private readonly _trustedControlTools = new Map<string, ToolDefinition>();
	private _configuredActiveToolNames: string[] = [];
	private _collaborationModeGuard?: (collaborationMode: CollaborationMode) => void | Promise<void>;

	constructor(config: AgentSessionConfig) {
		if (config.unattendedExecution) {
			if (config.interactiveBashBoundary) {
				throw new TypeError("Unattended execution cannot use an interactive Bash boundary");
			}
			if (config.sessionManager.getHeader()?.agent) {
				throw new TypeError("Unattended execution cannot run as an agent");
			}
			if (config.baseToolsOverride) throw new TypeError("Unattended execution cannot override built-in tools");
			if (config.mcpManager) throw new TypeError("Unattended execution cannot use MCP tools");
			if (config.customTools?.length) throw new TypeError("Unattended execution cannot use custom tools");
			if (config.resourceLoader.getExtensions().extensions.length > 0) {
				throw new TypeError("Unattended execution cannot load extensions");
			}
			if (!config.unattendedExecution.workspaceRoots.some((root) => isPathInside(root, config.cwd))) {
				throw new TypeError("Unattended execution cwd must be inside its workspace roots");
			}
		}
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this._restoreAgentMailbox();
		const persistedToolOutputDir = this.sessionManager.getToolOutputDir();
		this._ephemeralToolOutputDir = persistedToolOutputDir
			? undefined
			: join(tmpdir(), "metis-tool-results", this.sessionManager.getSessionId());
		this._toolOutputDir = persistedToolOutputDir ?? this._ephemeralToolOutputDir!;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.unattendedExecution ? [] : (config.customTools ?? []);
		this._cwd = config.cwd;
		this._agentDir = config.agentDir;
		this.deliveredArtifacts = config.agentDir
			? new SessionDeliveredArtifacts(config.agentDir, this.sessionManager)
			: undefined;
		this._modelRegistry = config.modelRegistry;
		this._mcpManager = config.unattendedExecution ? undefined : config.mcpManager;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.unattendedExecution
			? [...UNATTENDED_TOOL_NAMES]
			: config.initialActiveToolNames;
		this._defaultBuiltinToolsEnabled = config.unattendedExecution
			? false
			: config.defaultBuiltinToolsEnabled !== false;
		this._allowedToolNames = config.unattendedExecution
			? new Set(UNATTENDED_TOOL_NAMES)
			: config.allowedToolNames
				? new Set(config.allowedToolNames)
				: undefined;
		this._excludedToolNames = config.unattendedExecution
			? undefined
			: config.excludedToolNames
				? new Set(config.excludedToolNames)
				: undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._ultraAvailable = canUseUltra({
			hostAllowsUltra: config.ultraAvailable === true,
			persisted: this.sessionManager.isPersisted(),
			mode: this.sessionManager.getMode(),
			isAgent: this.sessionManager.getHeader()?.agent !== undefined,
		});
		this._additionalSystemPrompt = config.additionalSystemPrompt;
		this._includeAutoMemory = config.includeAutoMemory !== false;
		this._permissionModeCeiling = config.permissionModeCeiling;
		this._workspaceWritePolicy = config.workspaceWritePolicy ?? "inherit";
		this._unattendedExecution = config.unattendedExecution;
		if (this.sessionManager.getUltraSelected() && !this._ultraAvailable) {
			throw new Error("Ultra sessions require AgentSessionRuntime");
		}
		this._interactiveBashBoundary = config.unattendedExecution
			? undefined
			: (config.interactiveBashBoundary ??
				createInteractiveBashBoundary({
					hostOperations: {
						exec: (command, cwd, options) =>
							createLocalBashOperations({ shellPath: this.settingsManager.getShellPath() }).exec(
								command,
								cwd,
								options,
							),
					},
					context: () => {
						const sessionId = this.sessionManager.getSessionId();
						const attachmentDir = this._agentDir
							? getOwnedSessionAttachmentDir(this._agentDir, sessionId)
							: undefined;
						const workDirs = this._agentDir ? getOwnedSessionWorkDirs(this._agentDir, sessionId) : [];
						const activeWorkDir =
							this._activeWorkDir && workDirs.includes(this._activeWorkDir) ? this._activeWorkDir : undefined;
						const memoryRoot = this._agentDir ? getAutoMemoryRoot(this._agentDir) : undefined;
						const memoryReadRoots = this._agentDir
							? [
									getGlobalMemoryDirectory(this._agentDir),
									getProjectMemoryDirectory(
										this._agentDir,
										memoryProjectIdentity(this.sessionManager.getCwd()).projectKey,
									),
								]
							: [];
						return {
							cwd: this.sessionManager.getCwd(),
							workspaceRoots: this.sessionManager.getWorkspaceRoots(),
							workspaceReadOnly:
								this.sessionManager.getCollaborationMode() === "plan" || this._workspaceWritePolicy === "deny",
							readOnlyRoots: buildInteractiveBashReadOnlyRoots({
								attachmentDir,
								memoryReadRoots,
							}),
							writeRoots: activeWorkDir ? [activeWorkDir] : [],
							protectedRoots: memoryRoot ? [memoryRoot] : [],
							shellPath: this.settingsManager.getShellPath(),
						};
					},
				}));
		this._toolAuthorization = new ToolAuthorizationRuntime({
			agentDir: this._agentDir,
			sessionManager: this.sessionManager,
			cwd: () => this._cwd,
			readOnlyRoots: () => this.resourceLoader.getSkills().skills.map((skill) => skill.baseDir),
			toolSource: (toolName) => this._toolDefinitions.get(toolName)?.sourceInfo.source,
			mcpAnnotations: (toolName) => this._mcpManager?.getToolAnnotations(toolName),
			webSearchNetworkTarget: () =>
				WEB_SEARCH_PROVIDER_INFO[this.settingsManager.getWebSearchSettings().provider].networkTarget,
			isTrustedControlTool: (toolName) => this._isTrustedControlTool(toolName),
			runtimeShellCommandPrefix: () => this._runtimeShellCommandPrefix,
			permissionModeCeiling: this._permissionModeCeiling,
			workspaceWritePolicy: this._workspaceWritePolicy,
			unattendedExecution: this._unattendedExecution,
			bashBoundary: this._interactiveBashBoundary,
			requestApproval: config.requestPermissionApproval,
		});
		this._memorySettingsTransaction = new MemorySettingsTransaction({
			...(this._agentDir ? { agentDir: this._agentDir } : {}),
			authStorage: this._modelRegistry.authStorage,
			settingsManager: this.settingsManager,
		});
		this._memoryRuntime = new SessionMemoryRuntime({
			agentDir: this._agentDir,
			cwd: () => this._cwd,
			sessionId: () => this.sessionId,
			mode: () => this.mode,
			enabled: () => this._includeAutoMemory && this.settingsManager.getAutoMemoryEnabled(),
			engine: () => this.settingsManager.getMemoryEngine(),
			hasModel: () => this.model !== undefined,
			lastUserText: () => this._lastUserMessageText(),
			collectEvidence: (cursorEntryId) => collectMemoryEvidenceBatch(this.sessionManager.getBranch(), cursorEntryId),
			createExtractOptions: (input) => this._createMemoryExtractOptions(input),
			refreshPrompt: () => this.refreshSystemPrompt(),
			applyRetrieved: (memories) => {
				this._autoMemoryRetrieved = [...memories];
			},
			getEmbeddingSettings: () => this.settingsManager.getEmbeddingSettings(),
			getRerankSettings: () => this.settingsManager.getRerankSettings(),
			getCredential: (id) =>
				this._modelRegistry.authStorage.getApiKey(id, {
					includeFallback: false,
				}),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentMailboxHook();
		this._installPlanContextHook();
		this._installToolResultMicrocompactionHook();
		this._installAgentDurabilityHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._unsubscribeMcpCatalog = this._mcpManager?.subscribeCatalog(() => {
			this._refreshToolRegistry({ activeToolNames: this.getConfiguredActiveToolNames() });
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		if (!isPermissionMode(mode)) throw new TypeError("Invalid permission mode");
		if (this._permissionModeCeiling && narrowPermissionMode(mode, this._permissionModeCeiling()) !== mode) {
			throw new Error("Permission mode cannot exceed the parent session");
		}
		const current = this.sessionManager.getPermissionSettings().mode;
		if (current === mode) return;
		if (mode === "full" && current !== "full") await this._interactiveBashBoundary?.reset();
		this.sessionManager.setPermissionSettings({ mode });
	}

	async disposeInteractiveExecution(): Promise<void> {
		await this._interactiveBashBoundary?.dispose();
	}

	setPermissionApprovalHandler(handler?: RequestPermissionApproval): void {
		this._toolAuthorization.setApprovalHandler(handler);
	}

	setCollaborationModeGuard(guard?: (collaborationMode: CollaborationMode) => void | Promise<void>): void {
		this._collaborationModeGuard = guard;
	}

	/** Forward a child approval through the frontend currently attached to this session. */
	requestPermissionApproval(request: Parameters<RequestPermissionApproval>[0]): ReturnType<RequestPermissionApproval> {
		return this._toolAuthorization.requestApproval(request);
	}

	/** Install runtime-owned tools; only explicitly named no-host controls bypass approval. */
	installHostTools(
		definitions: readonly ToolDefinition<any, any, any>[],
		options?: { readonly automaticPermissionToolNames?: readonly string[] },
	): void {
		if (this._unattendedExecution) throw new Error("Unattended execution cannot install host tools");
		const active = new Set(this.getConfiguredActiveToolNames());
		const automatic = new Set(options?.automaticPermissionToolNames);
		for (const definition of definitions) {
			const existing = this._customTools.findIndex((candidate) => candidate.name === definition.name);
			if (existing < 0) this._customTools.push(definition);
			else this._customTools[existing] = definition;
			if (automatic.has(definition.name)) this._trustedControlTools.set(definition.name, definition);
			else this._trustedControlTools.delete(definition.name);
			this._allowedToolNames?.add(definition.name);
			active.add(definition.name);
		}
		this._refreshToolRegistry({ activeToolNames: [...active] });
	}

	removeHostTools(names: readonly string[]): void {
		if (this._unattendedExecution) throw new Error("Unattended execution cannot remove host tools");
		const removed = new Set(names);
		this._customTools = this._customTools.filter(({ name }) => !removed.has(name));
		for (const name of removed) {
			this._trustedControlTools.delete(name);
			this._allowedToolNames?.delete(name);
		}
		this._refreshToolRegistry({
			activeToolNames: this.getConfiguredActiveToolNames().filter((name) => !removed.has(name)),
		});
	}

	private _isTrustedControlTool(name: string): boolean {
		const trusted = this._trustedControlTools.get(name);
		return trusted !== undefined && this._toolDefinitions.get(name)?.definition === trusted;
	}

	setHostSystemPrompt(additional?: string | (() => string | undefined)): void {
		this._additionalSystemPrompt = additional;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getConfiguredActiveToolNames());
		this.agent.state.systemPrompt = this._effectiveSystemPrompt();
	}

	private _restoreAgentMailbox(): void {
		const startedDeliveries = new Set<string>();
		const deliveredEventIds = new Set<string>();
		for (const entry of this.sessionManager.getDurableJournalSnapshot()) {
			if (entry.type === "agent_mailbox_event") {
				this._knownAgentMailboxEventIds.add(entry.event.eventId);
				if (!this._pendingAgentMailboxEvents.has(entry.event.eventId)) {
					this._pendingAgentMailboxEvents.set(entry.event.eventId, { event: entry.event });
				}
				continue;
			}
			if (entry.type === "agent_mailbox_delivery") {
				const key = `${entry.deliveryId}\n${JSON.stringify(entry.eventIds)}`;
				if (entry.state === "started") startedDeliveries.add(key);
				else if (startedDeliveries.has(key)) {
					for (const eventId of entry.eventIds) deliveredEventIds.add(eventId);
				}
				continue;
			}
			if (entry.type !== "custom_message" || entry.customType !== "agent_mailbox") continue;
			const details = entry.details;
			if (typeof details !== "object" || details === null || !("eventId" in details)) continue;
			if (typeof details.eventId === "string") this._knownAgentMailboxEventIds.add(details.eventId);
		}
		for (const eventId of deliveredEventIds) this._pendingAgentMailboxEvents.delete(eventId);
	}

	enqueueAgentMailboxEvent(event: AgentMailboxTerminalEvent): boolean {
		if (this._runtimeTeardownRequested) throw new Error("The agent session is tearing down");
		if (this._knownAgentMailboxEventIds.has(event.eventId)) {
			return this._pendingAgentMailboxEvents.has(event.eventId);
		}
		if (this._pendingAgentMailboxEvents.size >= MAX_AGENT_MAILBOX_PENDING_EVENTS) {
			throw new Error("Agent mailbox is full");
		}
		this.sessionManager.appendAgentControl({ type: "agent_mailbox_event", event });
		this._knownAgentMailboxEventIds.add(event.eventId);
		this._pendingAgentMailboxEvents.set(event.eventId, { event });
		return true;
	}

	hasAgentMailboxEvent(eventId: string): boolean {
		return this._knownAgentMailboxEventIds.has(eventId);
	}

	getPendingAgentMailboxEventIds(): readonly string[] {
		return [...this._pendingAgentMailboxEvents.keys()];
	}

	private _agentMailboxDeliveryBatch(eventIds: Iterable<string>): readonly string[] {
		const batch: string[] = [];
		let bytes = 0;
		for (const eventId of new Set(eventIds)) {
			const pending = this._pendingAgentMailboxEvents.get(eventId);
			if (!pending) continue;
			const eventBytes = buildAgentMailboxContent(pending.event).reduce(
				(total, block) => total + utf8Length(block.text),
				0,
			);
			if (batch.length > 0 && bytes + eventBytes > MAX_AGENT_MAILBOX_DELIVERY_UTF8_BYTES) break;
			batch.push(eventId);
			bytes += eventBytes;
			if (batch.length >= MAX_AGENT_MAILBOX_DELIVERY_EVENTS) break;
		}
		return batch;
	}

	stageAgentMailboxDelivery(eventIds: readonly string[]): readonly string[] {
		const pending = this._agentMailboxDeliveryBatch(eventIds);
		if (pending.length === 0) return [];
		if (this._activeAgentMailboxDelivery) throw new Error("An agent mailbox delivery is already active");
		const deliveryId = createSessionId();
		this.sessionManager.appendAgentControl({
			type: "agent_mailbox_delivery",
			deliveryId,
			eventIds: pending,
			state: "started",
		});
		this._activeAgentMailboxDelivery = { deliveryId, eventIds: pending };
		return pending;
	}

	async continueAgentMailbox(eventIds?: readonly string[]): Promise<boolean> {
		const requested = eventIds ?? this.getPendingAgentMailboxEventIds();
		const pending = this._agentMailboxDeliveryBatch(requested);
		if (this._runtimeTeardownRequested || pending.length === 0 || !this.isIdle || this._isAgentSettling) return false;
		this._requestedAgentMailboxEventIds = new Set(pending);
		try {
			await this._runAgentPrompt({
				role: "custom",
				customType: "agent_continuation",
				content: [
					{
						type: "text",
						text: "<agent_notification>One or more background agents have completed. Review the pending result events, integrate what is relevant, and continue your task without repeating completed work.</agent_notification>",
					},
				],
				display: false,
				timestamp: Date.now(),
			});
			return true;
		} finally {
			this._requestedAgentMailboxEventIds = undefined;
		}
	}

	private _currentBranchAgentMailboxEventIds(): Set<string> {
		const eventIds = new Set<string>();
		for (const entry of this.sessionManager.buildContextEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== "agent_mailbox") continue;
			const details = entry.details;
			if (typeof details !== "object" || details === null || !("eventId" in details)) continue;
			if (typeof details.eventId === "string") eventIds.add(details.eventId);
		}
		return eventIds;
	}

	private _agentMailboxMessage(event: AgentMailboxTerminalEvent): CustomMessage<AgentMailboxTerminalEvent> {
		return {
			role: "custom",
			customType: "agent_mailbox",
			content: buildAgentMailboxContent(event),
			display: true,
			details: event,
			timestamp: Date.now(),
		};
	}

	private _installAgentMailboxHook(): void {
		const transformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const requested = this._requestedAgentMailboxEventIds ?? this._pendingAgentMailboxEvents.keys();
			this._stagedAgentMailboxEventIds = this._agentMailboxDeliveryBatch(requested);
			const visible = this._currentBranchAgentMailboxEventIds();
			const pendingMessages = this._stagedAgentMailboxEventIds
				.filter((eventId) => !visible.has(eventId))
				.map((eventId) => this._agentMailboxMessage(this._pendingAgentMailboxEvents.get(eventId)!.event));
			const withPending = pendingMessages.length === 0 ? messages : [...messages, ...pendingMessages];
			return transformContext ? transformContext(withPending, signal) : withPending;
		};
	}

	private _installPlanContextHook(): void {
		const transformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = transformContext ? await transformContext(messages, signal) : messages;
			return projectPlanContext(transformed, {
				collaborationMode: this.sessionManager.getCollaborationMode(),
				currentPlan: this.sessionManager.getPlanState().currentPlan,
				executionPlan: this._currentDurablePlanExecution(),
			});
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

	private _commitStagedAgentMailboxDelivery(): void {
		const eventIds = this._stagedAgentMailboxEventIds.filter((eventId) =>
			this._pendingAgentMailboxEvents.has(eventId),
		);
		this._stagedAgentMailboxEventIds = [];
		if (eventIds.length === 0) return;
		if (this._activeAgentMailboxDelivery) throw new Error("An agent mailbox delivery is already active");
		const visibleEventIds = this._currentBranchAgentMailboxEventIds();

		for (const eventId of eventIds) {
			if (visibleEventIds.has(eventId)) continue;
			const message = this._agentMailboxMessage(this._pendingAgentMailboxEvents.get(eventId)!.event);
			this.agent.state.messages.push(message);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			visibleEventIds.add(eventId);
		}

		const deliveryId = createSessionId();
		this.sessionManager.appendAgentControl({
			type: "agent_mailbox_delivery",
			deliveryId,
			eventIds,
			state: "started",
		});
		this._activeAgentMailboxDelivery = { deliveryId, eventIds };
	}

	private _completeAgentMailboxDelivery(): void {
		const active = this._activeAgentMailboxDelivery;
		if (!active) return;
		this.sessionManager.appendAgentControl({
			type: "agent_mailbox_delivery",
			deliveryId: active.deliveryId,
			eventIds: active.eventIds,
			state: "completed",
		});
		for (const eventId of active.eventIds) this._pendingAgentMailboxEvents.delete(eventId);
		this._activeAgentMailboxDelivery = undefined;
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

	private _isBuiltinTool(toolName: string): boolean {
		return this._toolDefinitions.get(toolName)?.sourceInfo.source.toLowerCase() === "builtin";
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
			if (toolCall.name === "read" && this._isBuiltinTool(toolCall.name)) {
				await this._recordSkillRead(args, isError);
			}
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
					})
				: undefined;
			const skillRefreshMessage =
				!isError && this._isBuiltinTool(toolCall.name) && (toolCall.name === "write" || toolCall.name === "edit")
					? await this._refreshSkillAfterFileMutation(args)
					: undefined;

			if (!hookResult && !skillRefreshMessage) {
				return undefined;
			}

			return {
				content: skillRefreshMessage
					? [...(hookResult?.content ?? result.content), { type: "text", text: skillRefreshMessage }]
					: hookResult?.content,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
			};
		};
	}

	private async _refreshSkillAfterFileMutation(args: unknown): Promise<string | undefined> {
		if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
		const path = (args as Record<string, unknown>).path;
		if (typeof path !== "string") return undefined;

		const target = canonicalizeActionPath(path, this._cwd);
		if (basename(target) !== "SKILL.md") return undefined;
		const projectRoot = canonicalizeActionPath(join(getProjectConfigDir(this._cwd), "skills"), this._cwd);
		const userRoot = this._agentDir ? canonicalizeActionPath(join(this._agentDir, "skills"), this._cwd) : undefined;
		const scope = isPathInside(projectRoot, target)
			? "project"
			: userRoot && isPathInside(userRoot, target)
				? "user"
				: undefined;
		if (!scope) return undefined;
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			return `The file was written, but the project Skill at ${target} was not loaded because the project is not trusted.`;
		}

		try {
			let refreshed = await this.refreshSkills({ path: target, scope });
			const findSkill = () =>
				refreshed.skills.find((candidate) => canonicalizeActionPath(candidate.filePath, this._cwd) === target);
			let skill = findSkill();
			if (
				!skill &&
				refreshed.diagnostics.some(
					(diagnostic) =>
						diagnostic.type === "collision" &&
						[diagnostic.collision?.winnerPath, diagnostic.collision?.loserPath].some(
							(path) => path && canonicalizeActionPath(path, this._cwd) === target,
						),
				)
			) {
				refreshed = await this.refreshSkills();
				skill = findSkill();
			}
			const skillDir = dirname(target);
			const diagnostics = refreshed.diagnostics.filter((diagnostic) => {
				const paths = [diagnostic.path, diagnostic.collision?.winnerPath, diagnostic.collision?.loserPath].filter(
					(candidate): candidate is string => typeof candidate === "string",
				);
				return paths.some((candidate) => isPathInside(skillDir, canonicalizeActionPath(candidate, this._cwd)));
			});
			const lines = skill
				? [
						`Loaded ${scope} Skill "${skill.name}" (${skill.disableModelInvocation ? "manual only" : "automatic invocation"}).`,
					]
				: [`The file was written, but the ${scope} Skill at ${target} was not loaded.`];
			for (const diagnostic of diagnostics) {
				lines.push(`${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
			}
			return lines.join("\n");
		} catch (error) {
			return `The file was written, but Skill reload failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private _recordSkillUsage(name: string, trigger: SkillUsageRecord["trigger"]): void {
		this.sessionManager.appendCustomEntry(SKILL_USAGE_CUSTOM_TYPE, { name, trigger } satisfies SkillUsageRecord);
	}

	private async _recordSkillRead(args: unknown, isError: boolean): Promise<void> {
		if (isError || typeof args !== "object" || args === null || Array.isArray(args)) return;
		const path = (args as Record<string, unknown>).path;
		if (typeof path !== "string") return;
		let absolutePath: string;
		try {
			absolutePath = await resolveReadPathAsync(path, this._cwd);
		} catch {
			return;
		}
		const skill = this.resourceLoader
			.getSkills()
			.skills.find((candidate) => resolve(candidate.filePath) === resolve(absolutePath));
		if (skill) this._recordSkillUsage(skill.name, "read");
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
			beforeProviderRequest: async (prepared) => {
				this._commitStagedAgentMailboxDelivery();
				this._markDurableProviderEpoch();
				this._capturePreparedContextUsage(prepared);
			},
			beforeToolExecute: (context, signal) =>
				this._toolAuthorization.beforeToolExecute(
					{
						actionId: context.toolCall.id,
						toolName: context.toolCall.name,
						args: context.args,
					},
					signal,
					() => {
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
				),
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
					systemPrompt: this._effectiveSystemPrompt(),
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
			this.deliveredArtifacts?.rollbackAll();
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
			this._toolAuthorization.clear(event.toolCallId);
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

		const deliveryMessage =
			event.type === "message_end" &&
			event.message.role === "toolResult" &&
			event.message.toolName === "deliver_file"
				? event.message
				: undefined;
		const durableDelivery = deliveryMessage?.isError === false;
		if (deliveryMessage && !durableDelivery) this.deliveredArtifacts?.rollback(deliveryMessage.toolCallId);

		// Successful delivery completion is published only after its journal fact is durable.
		if (!durableDelivery) {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			if (this._eventPersistenceFailure !== undefined) {
				this._discardUnpersistedAgentMessage(event.message);
				if (deliveryMessage) this.deliveredArtifacts?.rollback(deliveryMessage.toolCallId);
				throw this._eventPersistenceFailure;
			}
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
					if (deliveryMessage) this.deliveredArtifacts?.rollback(deliveryMessage.toolCallId);
					throw new DurableMessageValidationError(error);
				}
			}
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				try {
					this.sessionManager.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
					);
				} catch (error) {
					this._discardUnpersistedAgentMessage(event.message);
					throw error;
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				try {
					this.sessionManager.appendMessage(
						event.message,
						event.message.role === "toolResult" ? toolOutput : undefined,
						this._durableTurn?.turnId,
					);
				} catch (error) {
					this._discardUnpersistedAgentMessage(event.message);
					if (deliveryMessage) this.deliveredArtifacts?.rollback(deliveryMessage.toolCallId);
					throw error;
				}
				if (durableDelivery) {
					this.deliveredArtifacts?.commitToolResult(deliveryMessage);
					this._emit(event);
				}
				if (
					event.message.role === "assistant" ||
					(event.message.role === "toolResult" && event.message.toolName === "wait_agents")
				) {
					this._completeAgentMailboxDelivery();
				}
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
				this._captureReportedContextUsage(event.message);

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
		void this._memoryRuntime.dispose();
		this._interactiveBashBoundary?.forceDispose();
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
				this.deliveredArtifacts?.rollbackAll();
				this._toolAuthorization.dispose();

				this._extensionRunner.invalidate(
					"This extension ctx is stale after session replacement or reload. Do not use a captured metis or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
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

	getMemoryExtractStatus(limit = 10): MemoryExtractStatusSnapshot {
		const snapshot = this._memoryRuntime.snapshot(limit);
		return {
			enabled: snapshot.enabled,
			...(snapshot.active ? { active: snapshot.active } : {}),
			recent: snapshot.recent,
		};
	}

	getMemoryHealth(): MemoryHealth[] {
		return [...this._memoryRuntime.snapshot().health];
	}

	async waitForMemoryExtract(): Promise<void> {
		await this._memoryRuntime.waitForExtract();
	}

	async disposeMemoryRuntime(): Promise<void> {
		await this._memoryRuntime.dispose();
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

	/** Active tools that a persisted child runtime can reconstruct from project resources. */
	getDelegatableToolNames(writePolicy: "inherit" | "deny" = "inherit"): string[] {
		return this.getActiveToolNames().filter((name) => {
			const source = this._toolDefinitions.get(name)?.sourceInfo.source;
			if (source === "sdk") return false;
			return writePolicy === "inherit" || (source === "builtin" && !this._mcpToolNames.has(name));
		});
	}

	getConfiguredActiveToolNames(): string[] {
		return [...this._configuredActiveToolNames];
	}

	async setCollaborationMode(collaborationMode: CollaborationMode): Promise<void> {
		if (this.sessionManager.getHeader()?.agent || this.sessionManager.getHeader()?.scheduled) {
			throw new Error("Plan mode is unavailable for this session");
		}
		if (this.isStreaming || this.isCompacting) throw new Error("Cannot change Plan mode during active work");
		await this._collaborationModeGuard?.(collaborationMode);
		await this._persistCollaborationMode(collaborationMode);
	}

	submitPlan(input: { readonly title: string; readonly markdown: string }): StoredPlan {
		const previous = this.sessionManager.getPlanState().currentPlan;
		const plan = this.sessionManager.submitPlan(input);
		this._emit({ type: "plan_changed", entryIds: [...(previous ? [previous.entryId] : []), plan.entryId] });
		return plan;
	}

	async cancelPlan(ref: PlanRef): Promise<StoredPlan> {
		if (this.isStreaming || this.isCompacting) throw new Error("Cannot cancel a plan during active work");
		const plan = this.sessionManager.cancelPlan(ref);
		this._emit({ type: "plan_changed", entryIds: [plan.entryId] });
		try {
			await this._persistCollaborationMode("default");
		} catch {
			// Restrictive cancel and Default mode are already durable; sandbox reset is best-effort.
		}
		return plan;
	}

	private async _persistCollaborationMode(collaborationMode: CollaborationMode): Promise<void> {
		this.sessionManager.setCollaborationMode(collaborationMode);
		this._applyEffectiveTools();
		try {
			await this._interactiveBashBoundary?.reset();
		} finally {
			this._emit({ type: "collaboration_mode_changed", collaborationMode });
		}
	}

	private _currentDurablePlanExecution(): StoredPlan | undefined {
		const scope = durablePromptExecutionContext.getStore();
		if (!scope?.active || !scope.input.planExecution) return undefined;
		return this.sessionManager
			.getPlanState()
			.plans.find(
				(plan) =>
					plan.planId === scope.input.planExecution!.planId &&
					plan.revision === scope.input.planExecution!.revision &&
					plan.status === "accepted",
			);
	}

	private _planToolSource(name: string): "builtin" | "trusted" | "extension" | "mcp" | "sdk" | undefined {
		if (this._trustedControlTools.has(name) && this._isTrustedControlTool(name)) return "trusted";
		if (this._mcpToolNames.has(name)) return "mcp";
		const entry = this._toolDefinitions.get(name);
		if (!entry) return undefined;
		const source = entry.sourceInfo.source;
		if (source === "builtin" || source === "sdk") return source;
		if (source.startsWith("mcp:")) return "mcp";
		return "extension";
	}

	private _effectiveSystemPrompt(): string {
		const selected = this._systemPromptOverride ?? this._baseSystemPrompt;
		return this.sessionManager.getCollaborationMode() === "plan" && this._systemPromptOverride !== undefined
			? `${selected}\n\n${PLAN_MODE_SYSTEM_PROMPT}`
			: selected;
	}

	private _applyEffectiveTools(): void {
		const mode = this.sessionManager.getCollaborationMode();
		const names =
			mode === "plan"
				? planVisibleToolNames(this._configuredActiveToolNames, (name) => this._planToolSource(name))
				: this._configuredActiveToolNames;
		this.agent.state.tools = names.flatMap((name) => this._toolRegistry.get(name) ?? []);
		this._baseSystemPrompt = this._rebuildSystemPrompt(names);
		this.agent.state.systemPrompt = this._effectiveSystemPrompt();
	}

	private _canActivateWebSearch(): boolean {
		return this._allowedToolNames ? this._allowedToolNames.has("web_search") : this._defaultBuiltinToolsEnabled;
	}

	private _canActivateDescribeImage(): boolean {
		if (this._excludedToolNames?.has("describe_image")) return false;
		return this._allowedToolNames ? this._allowedToolNames.has("describe_image") : this._defaultBuiltinToolsEnabled;
	}

	private _visionServiceReady(): boolean {
		return (
			this.settingsManager.getVisionSettings() !== undefined &&
			this._modelRegistry.authStorage.has(VISION_PROVIDER_ID)
		);
	}

	private _applyWebSearchEnabled(enabled: boolean): void {
		const names = new Set(this.getConfiguredActiveToolNames());
		if (enabled && this._canActivateWebSearch() && this._toolRegistry.has("web_search")) names.add("web_search");
		else names.delete("web_search");
		this.setActiveToolsByName([...names]);
	}

	private _rebuildImageToolDefinitions(): void {
		if (this._baseToolsOverride) return;
		const describeImage = createDescribeImageToolDefinition(this._cwd, {
			getSettings: () => this.settingsManager.getVisionSettings(),
			getApiKey: () => this._modelRegistry.authStorage.getApiKey(VISION_PROVIDER_ID, { includeFallback: false }),
			streamSimple: (model, context, options) => this._modelRegistry.streamSimple(model, context, options),
		});
		this._baseToolDefinitions.set("describe_image", describeImage as ToolDefinition);
	}

	setWebSearchEnabled(enabled: boolean): void {
		this.settingsManager.setWebSearchEnabled(enabled);
		this._applyWebSearchEnabled(enabled);
	}

	async refreshWebSearchSettings(): Promise<void> {
		await this.settingsManager.reload();
		this._applyWebSearchEnabled(this.settingsManager.getWebSearchSettings().enabled);
	}

	async refreshImageToolSettings(): Promise<void> {
		await this.settingsManager.reload();
		this._applyImageToolSettings();
	}

	private _applyImageToolSettings(): void {
		this._rebuildImageToolDefinitions();
		const names = new Set(this.getConfiguredActiveToolNames());
		if (this._visionServiceReady() && this._canActivateDescribeImage()) names.add("describe_image");
		else names.delete("describe_image");
		this._refreshToolRegistry({ activeToolNames: [...names] });
	}

	async prepareModelServiceSettingsRefresh(): Promise<void> {
		await this._memoryRuntime.quiesce("settings-refresh");
	}

	async applyModelServiceSettingsRefresh(): Promise<void> {
		await this.settingsManager.reload();
		this._modelRegistry.refresh();
		this._refreshCurrentModelFromRegistry();
		this._applyImageToolSettings();
		this.refreshSystemPrompt();
		this._memoryRuntime.resume();
	}

	async updateMemorySettings(update: {
		autoMemoryEnabled?: boolean;
		memoryEngine?: "index" | "extract";
	}): Promise<void> {
		await this.prepareModelServiceSettingsRefresh();
		let original: unknown;
		try {
			await this._memorySettingsTransaction.update(update);
		} catch (error) {
			original = error;
		}
		try {
			await this.applyModelServiceSettingsRefresh();
		} catch (recoveryError) {
			if (!original) throw recoveryError;
			if (original instanceof Error) (original as Error & { cause?: unknown }).cause ??= recoveryError;
		}
		if (original) throw original;
	}

	setWebSearchProvider(provider: WebSearchProvider): void {
		this.settingsManager.setWebSearchProvider(provider);
	}

	get mcp(): McpManager | undefined {
		return this._mcpManager;
	}

	getGoal(): ThreadGoal | null {
		return readThreadGoal(this.sessionManager);
	}

	setGoalFromUser(input: { objective?: string; status?: Extract<ThreadGoalStatus, "active" | "paused"> }): ThreadGoal {
		const existing = readThreadGoal(this.sessionManager);
		if (input.objective === undefined && input.status === undefined) {
			throw new TypeError("Goal set requires an objective and/or status");
		}
		if (input.objective === undefined && existing === null) {
			throw new TypeError("Cannot update goal status because this thread has no goal");
		}
		if (input.objective === undefined && existing?.status === "complete") {
			throw new TypeError("A completed goal cannot be paused or resumed; set a new objective instead");
		}
		if (
			input.objective === undefined &&
			input.status === "paused" &&
			existing?.status !== "active" &&
			existing?.status !== "paused"
		) {
			throw new TypeError("Only an active goal can be paused");
		}
		const previousObjective = existing?.objective;
		const objective = input.objective !== undefined ? validateGoalObjective(input.objective) : existing!.objective;
		const status =
			input.status ?? (input.objective !== undefined ? "active" : (existing!.status as "active" | "paused"));
		if (status !== "active" && status !== "paused") {
			throw new TypeError("User goal updates may only set active or paused");
		}
		const continuingExisting =
			existing !== null && !(existing.status === "complete" && input.objective !== undefined);
		const goal = writeThreadGoal(this.sessionManager, {
			...(continuingExisting ? existing : {}),
			goalId: continuingExisting ? existing.goalId : randomUUID(),
			objective,
			status,
			createdAt: continuingExisting ? existing.createdAt : undefined,
			timeUsedSeconds: continuingExisting ? existing.timeUsedSeconds : undefined,
		});
		this._emit({ type: "goal_changed", goal });
		if (isActiveGoalStatus(goal.status)) {
			if (this.isStreaming && previousObjective !== goal.objective) {
				this.agent.steer({
					role: "custom",
					customType: "goal_objective_updated",
					content: buildGoalObjectiveUpdatedPrompt(goal),
					display: false,
					timestamp: Date.now(),
				});
			} else {
				this._continueActiveGoalInBackground();
			}
		}
		return goal;
	}

	private _continueActiveGoalInBackground(): void {
		void this.queueGoalContinuationIfIdle().catch((error) => {
			this._extensionRunner.emitError({
				extensionPath: "<runtime>",
				event: "goal_continuation",
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	clearGoal(): boolean {
		const cleared = clearThreadGoal(this.sessionManager);
		if (cleared) this._emit({ type: "goal_changed", goal: null });
		return cleared;
	}

	/** Start a hidden continuation turn when the session is idle and the goal is active. */
	async queueGoalContinuationIfIdle(): Promise<boolean> {
		if (this.sessionManager.getHeader()?.agent) return false;
		if (this.isStreaming || this.isCompacting) return false;
		const goal = readThreadGoal(this.sessionManager);
		if (!goal || !isActiveGoalStatus(goal.status)) return false;
		await this.sendCustomMessage(
			{
				customType: "goal_continuation",
				content: buildGoalContinuationPrompt(goal),
				display: false,
			},
			{ triggerTurn: true },
		);
		return true;
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values())
			.filter(
				({ definition }) =>
					definition.name !== "submit_plan" || this.sessionManager.getCollaborationMode() === "plan",
			)
			.map(({ definition, sourceInfo }) => ({
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
		this._configuredActiveToolNames = [...new Set(toolNames)].filter((name) => this._toolRegistry.has(name));
		this._applyEffectiveTools();
	}

	/** Re-read memory indexes and rebuild the current base system prompt. */
	refreshSystemPrompt(): void {
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getConfiguredActiveToolNames());
		this.agent.state.systemPrompt = this._effectiveSystemPrompt();
	}

	private async _createMemoryExtractOptions(
		options: SessionMemoryExtractInput,
	): Promise<RunMemoryExtractOptions | undefined> {
		const agentDir = this._agentDir;
		const model = this.model;
		if (!agentDir || !model) return undefined;
		const extractArgs: RunMemoryExtractOptions = {
			mode: options.mode,
			agentDir,
			cwd: this._cwd,
			agentMode: this.mode,
			projectKey: memoryProjectIdentity(this._cwd).projectKey,
			sessionId: this.sessionId,
			evidence: options.evidence,
			cursorEntryId: options.cursorEntryId,
			trigger: options.trigger,
			signal: options.signal,
			model,
			thinkingLevel: "off",
			streamFn: this.agent.streamFn,
			...(this.agent.getApiKey ? { getApiKey: this.agent.getApiKey } : {}),
			transport: this.agent.transport,
			...(this.agent.thinkingBudgets ? { thinkingBudgets: this.agent.thinkingBudgets } : {}),
			...(this.agent.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: this.agent.maxRetryDelayMs } : {}),
		};
		if (this.settingsManager.getMemoryEngine() === "extract") {
			const embedder = await awaitWithAbort(this._createMemoryEmbedder(), options.signal);
			if (embedder) {
				extractArgs.embeddingKey = embedder.key;
				extractArgs.embedTexts = embedder.embed;
			}
		}
		return extractArgs;
	}

	private async _createMemoryEmbedder(): Promise<
		| {
				key: string;
				embed: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
		  }
		| undefined
	> {
		const settings = this.settingsManager.getEmbeddingSettings();
		if (!settings) return undefined;
		const apiKey = await this._modelRegistry.authStorage.getApiKey(MEMORY_EMBEDDING_CREDENTIAL_ID, {
			includeFallback: false,
		});
		if (!apiKey) return undefined;
		return {
			key: embeddingConfigKey(settings),
			embed: (texts, signal) => embedMemoryTexts(texts, { settings, apiKey, signal }),
		};
	}

	/** Reload Skills and expose their latest metadata to the current session. */
	async refreshSkills(changedSkill?: {
		path: string;
		scope: "project" | "user";
	}): Promise<ReturnType<ResourceLoader["getSkills"]>> {
		if (changedSkill) this._pendingSkillPaths.set(changedSkill.path, changedSkill.scope);
		else this._skillFullRefreshRequested = true;
		this._skillRefreshGeneration += 1;
		if (this._skillRefreshPromise) return this._skillRefreshPromise;

		const refresh = async (): Promise<ReturnType<ResourceLoader["getSkills"]>> => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			let observedGeneration: number;
			do {
				observedGeneration = this._skillRefreshGeneration;
				const fullRefresh = this._skillFullRefreshRequested;
				this._skillFullRefreshRequested = false;
				const changedSkills = [...this._pendingSkillPaths];
				this._pendingSkillPaths.clear();
				if (fullRefresh) {
					if (this._resourceLoader.reloadSkills) await this._resourceLoader.reloadSkills();
					else await this._resourceLoader.reload();
				} else if (changedSkills.length > 0) {
					this._resourceLoader.extendResources({
						skillPaths: changedSkills.map(([path, scope]) => ({
							path,
							metadata: {
								source: "auto",
								scope,
								origin: "top-level",
								baseDir: scope === "project" ? getProjectConfigDir(this._cwd) : this._agentDir,
							},
						})),
					});
				}
				this.refreshSystemPrompt();
			} while (observedGeneration !== this._skillRefreshGeneration);
			return this._resourceLoader.getSkills();
		};

		let wrapped!: Promise<ReturnType<ResourceLoader["getSkills"]>>;
		wrapped = refresh().finally(() => {
			if (this._skillRefreshPromise === wrapped) this._skillRefreshPromise = undefined;
		});
		this._skillRefreshPromise = wrapped;
		return wrapped;
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
		const autoMemoryEngine = autoMemory ? this.settingsManager.getMemoryEngine() : undefined;
		const autoMemoryRetrieved = autoMemory && autoMemoryEngine === "extract" ? this._autoMemoryRetrieved : undefined;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			additionalDirectories: this.sessionManager.getAdditionalDirectories(),
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			autoMemory,
			autoMemoryEngine,
			autoMemoryRetrieved,
		};
		const built = buildSystemPromptWithParts(this._baseSystemPromptOptions);
		const parts = [...built.parts];
		const additional =
			typeof this._additionalSystemPrompt === "function"
				? this._additionalSystemPrompt()
				: this._additionalSystemPrompt;
		const resolvedAdditional = additional?.trim();
		if (resolvedAdditional) {
			parts.push({
				category:
					resolvedAdditional.includes("<agent_coordination>") || resolvedAdditional.includes("<agent_contract>")
						? "agent_definitions"
						: "system_prompt",
				content: `\n\n${resolvedAdditional}`,
			});
		}
		if (this.sessionManager.getCollaborationMode() === "plan") {
			parts.push({ category: "system_prompt", content: `\n\n${PLAN_MODE_SYSTEM_PROMPT}` });
		}
		this._baseSystemPromptParts = parts;
		return parts.map((part) => part.content).join("");
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
		if (input.planExecution) {
			if (this.sessionManager.getHeader()?.agent || this.sessionManager.getHeader()?.scheduled) {
				throw new Error("Plan execution is unavailable for this session");
			}
			const exact = this.sessionManager
				.getPlanState()
				.plans.find(
					(plan) => plan.planId === input.planExecution!.planId && plan.revision === input.planExecution!.revision,
				);
			if (!exact || (exact.status !== "proposed" && exact.status !== "accepted")) {
				throw new Error(
					"Plan execution must target the current proposed revision or an already accepted exact revision",
				);
			}
		}
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

	/** Persist an independent queued turn before its provider work is scheduled. */
	beginDurableQueuedTurn(identity: RuntimeRequestIdentity, input: DurablePromptInput, queueItemId: string): string {
		if (this._durableTurn) throw new Error("A durable runtime turn is already active");
		const turnId = deriveBatchedTurnId([queueItemId]);
		const residentPayloadBytes = durablePromptResidentPayloadBytes(input);
		this.sessionManager.appendRuntimeControl({
			type: "runtime_turn",
			turnId,
			operationIds: [identity.operationId],
			state: "started",
			consumedQueueItemIds: [queueItemId],
		});
		this._durableTurn = {
			turnId,
			operations: [{ identity, input, kind: "next_turn", residentPayloadBytes }],
			consumedQueueItemIds: [queueItemId],
		};
		this._durableResidentPayloadBytes += residentPayloadBytes;
		this._durableOperationTurnListener?.(identity.operationId, turnId);
		this._durableTerminalEvidence = undefined;
		return turnId;
	}

	/** Queue one already-accepted prompt with its durable identity. */
	enqueueAcceptedDurablePrompt(
		input: DurablePromptInput,
		identity: RuntimeRequestIdentity,
		behavior: "steer" | "followUp",
		queueItemId = identity.queueItemId,
	): void {
		let text = this._expandSkillCommand(input.text, true);
		text = expandPromptTemplate(text, [...this.promptTemplates], MAX_DURABLE_PROMPT_TEXT_BYTES);
		const textBytes = Buffer.byteLength(text, "utf8");
		if (textBytes > MAX_DURABLE_PROMPT_TEXT_BYTES) {
			throw new Error(`Expanded durable prompt cannot exceed ${MAX_DURABLE_PROMPT_TEXT_BYTES} UTF-8 bytes`);
		}
		const queue = behavior === "followUp" ? "follow_up" : "steer";
		if (this._durableQueues.has(queueItemId)) {
			throw new Error(`Durable queue item is already enqueued: ${queueItemId}`);
		}
		const residentPayloadBytes = durablePromptResidentPayloadBytes(input, text);
		if (this._durableResidentPayloadBytes + residentPayloadBytes > MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES) {
			throw new Error(
				`Durable runtime turn payloads cannot exceed ${MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES} resident bytes`,
			);
		}
		this._durableQueues.set(queueItemId, {
			operation: { identity, input, kind: "steer", residentPayloadBytes },
			queue,
		});
		this._durableResidentPayloadBytes += residentPayloadBytes;
		try {
			const queueIdentity = { operationId: identity.operationId, queueItemId };
			if (behavior === "followUp") this._enqueueFollowUp(text, undefined, queueIdentity);
			else this._enqueueSteer(text, undefined, queueIdentity);
		} catch (error) {
			this._durableQueues.delete(queueItemId);
			this._durableResidentPayloadBytes -= residentPayloadBytes;
			throw error;
		}
	}

	/** Execute accepted work; final durable markers settle before this promise. */
	async runAcceptedDurablePrompt(turnId: string, input: DurablePromptInput): Promise<"completed" | "interrupted"> {
		if (input.planExecution) {
			const exact = this.sessionManager
				.getPlanState()
				.plans.find(
					(plan) => plan.planId === input.planExecution!.planId && plan.revision === input.planExecution!.revision,
				);
			if (!exact || (exact.status !== "proposed" && exact.status !== "accepted")) {
				throw new Error("The admitted Plan execution revision is no longer executable");
			}
			const accepted = exact.status === "accepted" ? exact : this.sessionManager.acceptPlan(input.planExecution);
			if (exact.status !== "accepted") {
				this._emit({ type: "plan_changed", entryIds: [accepted.entryId] });
			}
			const modeChanged = this.sessionManager.getCollaborationMode() !== "default";
			if (modeChanged) this.sessionManager.setCollaborationMode("default");
			await this._interactiveBashBoundary?.reset();
			this._applyEffectiveTools();
			if (modeChanged) {
				this._emit({ type: "collaboration_mode_changed", collaborationMode: "default" });
			}
		}
		const context: DurablePromptExecutionScope = { owner: this, turnId, input, active: true };
		let runError: unknown;
		try {
			if (this._runtimeTeardownRequested) throw new Error("The agent session is tearing down");
			const images = input.images?.length ? this.sessionManager.resolveDurableImageRefs(input.images) : undefined;
			await durablePromptExecutionContext.run(context, () => this.prompt(input.text, { images }));
		} catch (error) {
			runError = error;
		} finally {
			context.active = false;
			if (!this._isAgentRunActive && this._durableTurn?.turnId === turnId) this._finishDurableTurn();
		}
		const state = this._durableTerminalStates.get(turnId);
		this._durableTerminalStates.delete(turnId);
		if (runError !== undefined) throw runError;
		if (!state) throw new Error(`Durable runtime turn did not reach a terminal state: ${turnId}`);
		return state;
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
		this._durableTerminalStates.set(turn.turnId, state);
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
		const sessionId = this.sessionManager.getSessionId();
		this._activeWorkDir = undefined;
		this._isAgentRunActive = true;
		try {
			if (this._agentDir) clearSessionAttachmentNonFiles(this._agentDir, sessionId);
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
		} finally {
			this._activeAgentMailboxDelivery = undefined;
			this._stagedAgentMailboxEventIds = [];
			const workDir = this._activeWorkDir;
			if (this._agentDir) {
				clearSessionAttachmentNonFiles(this._agentDir, sessionId);
				if (workDir) clearSessionWorkDir(this._agentDir, workDir);
			}
			this._activeWorkDir = undefined;
		}
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

		if (!this.sessionManager.getHeader()?.agent && msg.stopReason !== "aborted") {
			const goal = readThreadGoal(this.sessionManager);
			if (msg.stopReason === "error") {
				if (goal && isActiveGoalStatus(goal.status)) {
					const next = writeThreadGoal(this.sessionManager, {
						...goal,
						status: isGoalUsageLimitError(msg.errorMessage) ? "usage_limited" : "paused",
					});
					this._emit({ type: "goal_changed", goal: next });
				}
			} else if (goal && isActiveGoalStatus(goal.status) && !this.agent.hasQueuedMessages()) {
				this.agent.followUp({
					role: "custom",
					customType: "goal_continuation",
					content: buildGoalContinuationPrompt(goal),
					display: false,
					timestamp: Date.now(),
				});
			}
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		const hasQueuedMessages = this.agent.hasQueuedMessages();
		if (!hasQueuedMessages && msg.stopReason !== "aborted") {
			this._scheduleThrottledMemoryExtract();
		}
		return hasQueuedMessages;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via metis.registerCommand) immediately, even during streaming
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
			// Extension commands manage their own LLM interaction via metis.sendMessage()
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

			// Extract-engine retrieval: embed the user message and inject top hits (never fall back to catalog).
			if (this._includeAutoMemory && this.settingsManager.getAutoMemoryEnabled()) {
				await this._memoryRuntime.prepareTurn(expandedText);
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
				this.agent.state.systemPrompt = this._effectiveSystemPrompt();
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
			this._recordSkillUsage(skill.name, "command");
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
		this._toolAuthorization.clear();
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
		try {
			await this.waitForIdle();
		} finally {
			this._toolAuthorization.clear();
		}
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
			if (!this.sessionManager.getUltraSelected() && (this.supportsThinking() || effectiveLevel !== "off")) {
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
		return this.sessionManager.getUltraSelected() ? "ultra" : this.thinkingLevel;
	}

	getAvailableThinkingSelections(): ThinkingSelection[] {
		const selections: ThinkingSelection[] = this.getAvailableThinkingLevels();
		if (this._ultraAvailable) selections.push("ultra");
		return selections;
	}

	setThinkingSelection(selection: ThinkingSelection): void {
		if (selection !== "ultra") {
			if (this.sessionManager.getUltraSelected()) this.sessionManager.setUltraSelected(false);
			this.setThinkingLevel(selection);
			this.settingsManager.setDefaultThinkingLevel(selection);
			this._emit({
				type: "thinking_selection_changed",
				selection,
				actualThinkingLevel: this.thinkingLevel,
				ultraSelected: false,
			});
			return;
		}
		if (!this._ultraAvailable || !this.sessionManager.isPersisted() || this.sessionManager.getHeader()?.agent) {
			throw new Error("Ultra requires a persisted primary Code AgentSessionRuntime");
		}
		if (!this.sessionManager.getUltraSelected()) this.sessionManager.setUltraSelected(true);
		const actual = getHighestSupportedThinkingLevel(this.model);
		this.setThinkingLevel(actual);
		this.settingsManager.setDefaultThinkingLevel("ultra");
		this._emit({
			type: "thinking_selection_changed",
			selection: "ultra",
			actualThinkingLevel: actual,
			ultraSelected: true,
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

	private _lastUserMessageText(): string {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (message?.role === "user") {
				return this._extractUserMessageText(message.content);
			}
		}
		return "";
	}

	private _scheduleThrottledMemoryExtract(): void {
		this._memoryRuntime.afterTurn();
	}

	private async _compactWithMemoryExtract<T>(
		preparation: CompactionPreparation,
		reason: "manual" | "threshold" | "overflow",
		signal: AbortSignal,
		compactWork: () => Promise<T>,
	): Promise<T> {
		const evidence = serializeExtractEvidence([
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		]);
		return this._memoryRuntime.withCompaction({ evidence, reason, signal }, compactWork);
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

			const generated = await this._compactWithMemoryExtract(
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

			const generated = await this._compactWithMemoryExtract(
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
		this._continueActiveGoalInBackground();
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
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getConfiguredActiveToolNames());
		this.agent.state.systemPrompt = this._effectiveSystemPrompt();
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
		const previousActiveToolNames =
			options?.activeToolNames ??
			(this._configuredActiveToolNames.length > 0 ? this._configuredActiveToolNames : this.getActiveToolNames());
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			this._trustedControlTools.has(name) ||
			((!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name));
		const isProtectedReadOnlyBuiltin = (name: string): boolean =>
			this._workspaceWritePolicy === "deny" && this._baseToolDefinitions.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const baseToolSource = this._baseToolsOverride ? "sdk" : "builtin";
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name) && !isProtectedReadOnlyBuiltin(tool.definition.name));
		const mcpTools = this._mcpManager
			? createMcpToolDefinitions(this._mcpManager, this)
			: { direct: [], deferred: [] };
		const directMcpTools = mcpTools.direct.filter(
			(definition) => isAllowedTool(definition.name) && !isProtectedReadOnlyBuiltin(definition.name),
		);
		const deferredMcpTools = mcpTools.deferred.filter(
			({ definition }) => isAllowedTool(definition.name) && !isProtectedReadOnlyBuiltin(definition.name),
		);
		this._mcpToolNames = new Set([
			...directMcpTools.map((definition) => definition.name),
			...deferredMcpTools.map(({ definition }) => definition.name),
		]);
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
				const guarded = this._toolAuthorization.guard(tool);
				return [guarded.name, guarded] as const;
			}),
		);
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			const guarded = this._toolAuthorization.guard(tool);
			toolRegistry.set(guarded.name, guarded);
		}
		for (const tool of [...wrappedDirectMcpTools, ...wrappedDeferredMcpTools]) {
			const guarded = this._toolAuthorization.guard(tool);
			toolRegistry.set(guarded.name, guarded);
		}
		for (const trustedName of ["ask_user", "submit_plan"] as const) {
			const definition = this._trustedControlTools.get(trustedName);
			if (!definition) continue;
			const sourceInfo = createSyntheticSourceInfo(`<trusted:${trustedName}>`, { source: "trusted" });
			definitionRegistry.set(trustedName, { definition, sourceInfo });
			const wrapped = wrapRegisteredTools([{ definition, sourceInfo }], runner)[0] as AgentTool;
			toolRegistry.set(trustedName, this._toolAuthorization.guard(wrapped));
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

		this._configuredActiveToolNames = [...new Set(nextActiveToolNames)];
		this._applyEffectiveTools();
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const shellCommandPrefix = this._unattendedExecution ? undefined : this.settingsManager.getShellCommandPrefix();
		const shellPath = this._unattendedExecution ? undefined : this.settingsManager.getShellPath();
		const memoryReadBoundary = this._agentDir
			? {
					memoryRoot: getAutoMemoryRoot(this._agentDir),
					allowedRoots: [
						getGlobalMemoryDirectory(this._agentDir),
						getProjectMemoryDirectory(this._agentDir, memoryProjectIdentity(this._cwd).projectKey),
					],
				}
			: undefined;
		this._runtimeShellCommandPrefix = shellCommandPrefix;
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { memoryReadBoundary },
					grep: { memoryReadBoundary },
					find: { memoryReadBoundary },
					ls: { memoryReadBoundary },
					bash: {
						operations: this._unattendedExecution?.bashOperations ?? this._interactiveBashBoundary?.operations,
						commandPrefix: shellCommandPrefix,
						shellPath,
						outputDir: this._toolOutputDir,
						...(!this._unattendedExecution && this._agentDir
							? {
									spawnHook: (context) => {
										if (!this._activeWorkDir && context.command.includes("METIS_WORK_DIR")) {
											this._activeWorkDir = createSessionWorkDir(
												this._agentDir!,
												this.sessionManager.getSessionId(),
											);
										}
										return {
											...context,
											command: this._activeWorkDir
												? `readonly METIS_WORK_DIR\n${context.command}`
												: context.command,
											env: {
												...context.env,
												METIS_ATTACHMENTS_DIR: getSessionAttachmentDir(
													this._agentDir!,
													this.sessionManager.getSessionId(),
												),
												...(this.sessionManager.getCollaborationMode() === "plan"
													? { GIT_OPTIONAL_LOCKS: "0" }
													: {}),
												...(this._activeWorkDir
													? {
															METIS_WORK_DIR: this._activeWorkDir,
															TMPDIR: this._activeWorkDir,
															TMP: this._activeWorkDir,
															TEMP: this._activeWorkDir,
														}
													: {}),
											},
										};
									},
								}
							: {}),
					},
					write: this._agentDir ? { restrictedRoots: [getAutoMemoryRoot(this._agentDir)] } : undefined,
					edit: this._agentDir ? { restrictedRoots: [getAutoMemoryRoot(this._agentDir)] } : undefined,
					webSearch: {
						getSettings: () => this.settingsManager.getWebSearchSettings(),
						getApiKey: (provider) => resolveWebSearchApiKey(this._modelRegistry.authStorage, provider),
					},
					describeImage: {
						getSettings: () => this.settingsManager.getVisionSettings(),
						getApiKey: () =>
							this._modelRegistry.authStorage.getApiKey(VISION_PROVIDER_ID, { includeFallback: false }),
						streamSimple: (model, context, options) => this._modelRegistry.streamSimple(model, context, options),
					},
					goal: {
						getSession: () => this.sessionManager,
						onChange: (goal) => this._emit({ type: "goal_changed", goal }),
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
		const submitPlanDefinition = createSubmitPlanToolDefinition((input) => this.submitPlan(input));
		this._baseToolDefinitions.set(submitPlanDefinition.name, submitPlanDefinition as ToolDefinition);
		this._trustedControlTools.set(submitPlanDefinition.name, submitPlanDefinition as ToolDefinition);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (this._unattendedExecution && extensionsResult.extensions.length > 0) {
			throw new TypeError("Unattended execution cannot load extensions");
		}
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
					...(this._visionServiceReady() && this._canActivateDescribeImage() ? ["describe_image"] : []),
					...(this.settingsManager.getWebSearchSettings().enabled && this._canActivateWebSearch()
						? ["web_search"]
						: []),
					...(this.sessionManager.getHeader()?.agent
						? []
						: ["set_tasks", "get_goal", "create_goal", "update_goal"]),
				];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		const globallyEnabledToolNames = baseActiveToolNames.filter((name) => {
			if (name === "web_search") {
				return this.settingsManager.getWebSearchSettings().enabled && this._canActivateWebSearch();
			}
			if (name === "describe_image") {
				return this._visionServiceReady() && this._canActivateDescribeImage();
			}
			return true;
		});
		this._configuredActiveToolNames = globallyEnabledToolNames;
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
			activeToolNames: this.getConfiguredActiveToolNames(),
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
		},
	): Promise<BashResult> {
		if (this.isCompacting) throw new Error("Wait for compaction to finish before running bash");

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
		this._bashAbortController = new AbortController();

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
					outputDir: this._toolOutputDir,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
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

	private _contextUsageFingerprint(model: Model<any>, systemPrompt: string, tools: readonly Tool[]): string {
		let serializedTools = "[unserializable]";
		try {
			serializedTools = JSON.stringify(tools) ?? "[]";
		} catch {}
		return createHash("sha256")
			.update(model.provider)
			.update("\0")
			.update(model.id)
			.update("\0")
			.update(String(model.contextWindow ?? 0))
			.update("\0")
			.update(systemPrompt)
			.update("\0")
			.update(serializedTools)
			.digest("hex");
	}

	private _contextUsageToolCategories(
		tools: readonly Tool[],
	): ReadonlyMap<string, "tool_definitions" | "mcp_dynamic_tools" | "agent_definitions"> {
		return new Map(
			tools.map(
				(tool) =>
					[
						tool.name,
						AGENT_CONTEXT_TOOL_NAMES.has(tool.name)
							? "agent_definitions"
							: this._mcpToolNames.has(tool.name)
								? "mcp_dynamic_tools"
								: "tool_definitions",
					] as const,
			),
		);
	}

	private _contextUsageSystemPromptParts(systemPrompt: string): readonly SystemPromptPart[] {
		if (this._baseSystemPromptParts.map((part) => part.content).join("") === systemPrompt) {
			return this._baseSystemPromptParts;
		}
		return systemPrompt ? [{ category: "system_prompt", content: systemPrompt }] : [];
	}

	private _estimateContextUsageBreakdown(
		systemPrompt: string,
		messages: readonly AgentMessage[],
		tools: readonly Tool[],
	): ContextUsageBreakdownItem[] {
		return estimateContextUsageBreakdown({
			systemPromptParts: this._contextUsageSystemPromptParts(systemPrompt),
			messages,
			tools,
			toolCategories: this._contextUsageToolCategories(tools),
		});
	}

	private _capturePreparedContextUsage(prepared: BeforeProviderRequestContext): void {
		const systemPrompt = prepared.llmContext.systemPrompt ?? "";
		const tools = prepared.llmContext.tools ?? [];
		this._preparedContextUsage = {
			configurationFingerprint: this._contextUsageFingerprint(prepared.model, systemPrompt, tools),
			breakdown: this._estimateContextUsageBreakdown(systemPrompt, prepared.agentMessages, tools),
		};
	}

	private _captureReportedContextUsage(message: AssistantMessage): void {
		const prepared = this._preparedContextUsage;
		this._preparedContextUsage = undefined;
		const reportedTokens = calculateContextTokens(message.usage);
		if (!prepared || message.stopReason === "error" || message.stopReason === "aborted" || reportedTokens <= 0) {
			return;
		}
		const rawBreakdown = mergeContextUsageBreakdown(prepared.breakdown, [
			{ category: "conversation", tokens: estimateMessageTokens(message) },
		]);
		const calibration = this._contextUsageCalibration;
		const breakdown =
			calibration?.configurationFingerprint === prepared.configurationFingerprint
				? reconcileContextUsageBreakdownWithFixed(rawBreakdown, reportedTokens, calibration.fixedBreakdown)
				: reconcileContextUsageBreakdown(rawBreakdown, reportedTokens);
		if (calibration?.configurationFingerprint !== prepared.configurationFingerprint) {
			this._contextUsageCalibration = {
				configurationFingerprint: prepared.configurationFingerprint,
				fixedBreakdown: breakdown.filter((item) => FIXED_CONTEXT_USAGE_CATEGORIES.has(item.category)),
			};
		}
		let stateAssistant = message;
		for (let index = this.messages.length - 1; index >= 0; index--) {
			const candidate = this.messages[index];
			if (candidate.role === "assistant" && (candidate === message || isDeepStrictEqual(candidate, message))) {
				stateAssistant = candidate;
				break;
			}
		}
		this._reportedContextUsage = {
			assistant: stateAssistant,
			configurationFingerprint: prepared.configurationFingerprint,
			breakdown,
			tokens: reportedTokens,
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const systemPrompt = this.systemPrompt;
		const tools = this.agent.state.tools as readonly Tool[];
		const fingerprint = this._contextUsageFingerprint(model, systemPrompt, tools);
		const reported = this._reportedContextUsage;
		const assistantIndex = reported ? this.messages.indexOf(reported.assistant) : -1;
		if (reported && reported.configurationFingerprint === fingerprint && assistantIndex >= 0) {
			const tail = this._estimateContextUsageBreakdown("", this.messages.slice(assistantIndex + 1), []);
			const breakdown = mergeContextUsageBreakdown(reported.breakdown, tail);
			const tokens = reported.tokens + tail.reduce((sum, item) => sum + item.tokens, 0);
			return {
				tokens,
				contextWindow,
				percent: (tokens / contextWindow) * 100,
				basis: "reported_total",
				breakdown: breakdown.reduce((sum, item) => sum + item.tokens, 0) === tokens ? breakdown : null,
			};
		}

		const estimatedBreakdown = this._estimateContextUsageBreakdown(systemPrompt, this.messages, tools);
		const calibration = this._contextUsageCalibration;
		const breakdown =
			calibration?.configurationFingerprint === fingerprint
				? mergeContextUsageBreakdown(
						calibration.fixedBreakdown,
						estimatedBreakdown.filter((item) => !FIXED_CONTEXT_USAGE_CATEGORIES.has(item.category)),
					)
				: estimatedBreakdown;
		const tokens = breakdown.reduce((sum, item) => sum + item.tokens, 0);
		return {
			tokens,
			contextWindow,
			percent: (tokens / contextWindow) * 100,
			basis: "estimated_total",
			breakdown,
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
