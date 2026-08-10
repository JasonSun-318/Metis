import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@metis/agent-core";
import { clampThinkingLevel, type Model } from "@metis/ai/compat";
import { getAgentDir } from "../config.ts";
import { canonicalizeActionPath, resolvePath } from "../utils/paths.ts";
import { type AgentMode, DEFAULT_AGENT_MODE } from "./agent-mode.ts";
import { AgentSession, type AgentSessionConfig } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { ensureModeScopedMemoryLayout } from "./auto-memory.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { McpManager } from "./mcp/index.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import { normalizePermissionMode, type PermissionMode } from "./permission-mode.ts";
import { formatPermissionApproval, type PermissionApprovalRequest } from "./permission-policy.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { createSessionId } from "./session-id.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { removeOwnedManagedWorkspace, resolveNewSessionWorkspace } from "./session-workspace.ts";
import { SettingsManager } from "./settings-manager.ts";
import { canUseUltra, getHighestSupportedThinkingLevel, type ThinkingSelection } from "./thinking-selection.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWebFetchTool,
	createWebSearchTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";
import { UNATTENDED_TOOL_NAMES, type UnattendedExecutionProfile } from "./unattended-execution.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.metis/agent */
	agentDir?: string;
	/** Classification mode for a newly-created default session manager. Default: code. */
	agentMode?: AgentMode;
	/** Initial permission mode for a newly-created session. */
	permissionMode?: PermissionMode | "auto";
	/** @deprecated Ignored. Ask/Full has no reviewer. */
	reviewerEnabled?: boolean;
	/** Host callback for one-action approvals. */
	onPermissionRequest?: PermissionRequester;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;
	/** Injectable MCP manager. Ownership transfers to AgentSession after successful construction. */
	mcpManager?: McpManager;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** User-facing composite selection; Ultra requires a persisted primary runtime host. */
	thinkingSelection?: ThinkingSelection;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingSelection }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, grep, bash, edit, write, web_fetch, set_tasks,
	 *   and web_search when globally enabled) but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, metis enables the default built-in tools (read, grep, bash, edit, write, web_fetch,
	 * set_tasks, and web_search when globally enabled) and leaves extension/custom tools enabled unless
	 * `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;
	/** @internal Host-owned capability for a persisted primary runtime. */
	ultraAvailable?: boolean;
	/** @internal Host-owned prompt suffix for parent/child runtime profiles. */
	additionalSystemPrompt?: string | (() => string | undefined);
	/** @internal Disable automatic memory context and dream writes for isolated runtimes. */
	includeAutoMemory?: boolean;
	/** @internal Host-owned monotonic permission ceiling for a child runtime. */
	permissionModeCeiling?: AgentSessionConfig["permissionModeCeiling"];
	/** @internal Host-only fail-closed profile for unattended runs. */
	unattendedExecution?: UnattendedExecutionProfile;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

export interface PermissionRequest {
	kind: "action";
	title: string;
	summary: string;
	details: string;
}

export type PermissionRequester = (request: PermissionRequest, signal?: AbortSignal) => Promise<"allow-once" | "deny">;

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createWebFetchTool,
	createWebSearchTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function createActionPermissionRequester(requester: PermissionRequester | undefined) {
	if (!requester) return undefined;
	return async (request: PermissionApprovalRequest) => {
		const view = formatPermissionApproval(request);
		const decision = await requester(
			{
				kind: "action",
				title: view.title,
				summary: view.summary,
				details: view.details,
			},
			request.signal,
		);
		return decision === "allow-once" ? { decision: "allow" as const } : { decision: "deny" as const };
	};
}

function restoredMcpToolNames(sessionManager: SessionManager, manager: McpManager): string[] {
	const known = new Set(manager.getToolRecords().map((tool) => tool.modelName));
	const restored = new Set<string>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		for (const name of entry.message.addedToolNames ?? []) {
			if (known.has(name)) restored.add(name);
		}
	}
	return [...restored];
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@metis/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	if (options.thinkingLevel !== undefined && options.thinkingSelection !== undefined) {
		throw new Error("thinkingLevel and thinkingSelection cannot both be supplied");
	}
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	await ensureModeScopedMemoryLayout(agentDir);
	const suppliedSessionManager = options.sessionManager;
	const requestedPermissionMode =
		options.permissionMode === undefined ? undefined : normalizePermissionMode(options.permissionMode);
	if (options.permissionMode !== undefined && !requestedPermissionMode) {
		throw new TypeError("permissionMode must be ask, auto, or full");
	}
	if (
		suppliedSessionManager &&
		options.agentMode !== undefined &&
		options.agentMode !== suppliedSessionManager.getMode()
	) {
		throw new Error("agentMode cannot override the supplied sessionManager mode");
	}
	if (
		suppliedSessionManager &&
		options.cwd !== undefined &&
		canonicalizeActionPath(options.cwd, process.cwd()) !==
			canonicalizeActionPath(suppliedSessionManager.getCwd(), suppliedSessionManager.getCwd())
	) {
		throw new Error("cwd cannot override the supplied sessionManager cwd");
	}
	if (suppliedSessionManager && requestedPermissionMode !== undefined) {
		if (requestedPermissionMode !== suppliedSessionManager.getPermissionSettings().mode) {
			throw new Error("permissionMode cannot override the supplied sessionManager permissions");
		}
	}
	if (options.authStorage && options.modelRegistry && options.modelRegistry.authStorage !== options.authStorage) {
		throw new Error("authStorage must match modelRegistry.authStorage");
	}
	if (options.unattendedExecution && options.mcpManager) {
		throw new TypeError("Unattended execution cannot use an MCP manager");
	}

	const mode = options.agentMode ?? DEFAULT_AGENT_MODE;
	const sessionId = suppliedSessionManager ? undefined : createSessionId();
	const workspace = suppliedSessionManager
		? undefined
		: resolveNewSessionWorkspace({
				id: sessionId!,
				mode,
				requestedCwd: options.cwd,
				hostCwd: process.cwd(),
				agentDir,
			});
	const cwd = suppliedSessionManager?.getCwd() ?? workspace!.cwd;
	let resourceLoader = options.resourceLoader;
	const ownsResourceLoader = resourceLoader === undefined;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.modelRegistry?.authStorage ?? options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	let settingsManager: SettingsManager;
	let sessionManager: SessionManager;
	try {
		settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
		sessionManager =
			suppliedSessionManager ??
			SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir), {
				id: sessionId,
				mode,
				cwdOrigin: workspace!.cwdOrigin,
				permissionMode: requestedPermissionMode,
			});
	} catch (error) {
		if (workspace?.cwdOrigin === "managed") {
			removeOwnedManagedWorkspace({ id: sessionId!, cwd, cwdOrigin: "managed", agentDir });
		}
		throw error;
	}
	const ownsSessionManager = suppliedSessionManager === undefined;
	let mcpManager = options.unattendedExecution ? undefined : options.mcpManager;
	const ownsMcpManager = !options.unattendedExecution && mcpManager === undefined;
	let completed = false;

	try {
		if (!options.unattendedExecution) {
			mcpManager ??= await McpManager.create({ settingsManager, authStorage, cwd });
		}
		if (!resourceLoader) {
			resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				...(options.unattendedExecution
					? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true }
					: {}),
			});
			await resourceLoader.reload();
			time("resourceLoader.reload");
		}
		if (options.unattendedExecution && resourceLoader.getExtensions().extensions.length > 0) {
			throw new TypeError("Unattended execution requires extensions to be disabled");
		}

		// Check if session has existing data to restore
		const existingSession = sessionManager.buildSessionContext();
		const hasExistingSession = existingSession.messages.length > 0;
		const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
		const savedThinkingSelection = settingsManager.getDefaultThinkingLevel();
		const savedThinkingLevel = savedThinkingSelection === "ultra" ? undefined : savedThinkingSelection;

		let model = options.model;
		let modelFallbackMessage: string | undefined;

		// If session has data, try to restore model from it
		if (!model && hasExistingSession && existingSession.model) {
			const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
			if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
				model = restoredModel;
			}
			if (!model) {
				modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
			}
		}

		// If still no model, use findInitialModel (checks settings default, then provider defaults)
		if (!model) {
			const result = await findInitialModel({
				scopedModels: [],
				isContinuing: hasExistingSession,
				defaultProvider: settingsManager.getDefaultProvider(),
				defaultModelId: settingsManager.getDefaultModel(),
				defaultThinkingLevel: savedThinkingLevel,
				modelRegistry,
			});
			model = result.model;
			if (!model) {
				modelFallbackMessage = formatNoModelsAvailableMessage();
			} else if (modelFallbackMessage) {
				modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
		}

		let thinkingLevel = options.thinkingLevel;
		const unattendedUltra = options.unattendedExecution !== undefined && options.thinkingSelection === "ultra";
		let thinkingSelection = unattendedUltra ? undefined : options.thinkingSelection;
		if (
			thinkingSelection === undefined &&
			thinkingLevel === undefined &&
			savedThinkingSelection === "ultra" &&
			(!hasExistingSession || !hasThinkingEntry)
		) {
			const supportsSavedUltra = canUseUltra({
				hostAllowsUltra: options.ultraAvailable === true && !options.unattendedExecution,
				persisted: sessionManager.isPersisted(),
				mode: sessionManager.getMode(),
				isSubagent: sessionManager.getHeader()?.subagent !== undefined,
			});
			if (supportsSavedUltra) {
				thinkingSelection = "ultra";
			} else {
				thinkingLevel = getHighestSupportedThinkingLevel(model);
				const warning =
					"Saved Ultra preference is unavailable in this host; using the model's highest normal thinking level.";
				modelFallbackMessage = modelFallbackMessage ? `${modelFallbackMessage}. ${warning}` : warning;
			}
		}

		// If session has data, restore thinking level from it
		if (thinkingLevel === undefined && hasExistingSession) {
			thinkingLevel = hasThinkingEntry
				? (existingSession.thinkingLevel as ThinkingLevel)
				: (savedThinkingLevel ?? thinkingLevel ?? DEFAULT_THINKING_LEVEL);
		}

		// Fall back to settings default
		if (thinkingLevel === undefined) {
			thinkingLevel = savedThinkingLevel ?? DEFAULT_THINKING_LEVEL;
		}

		if (unattendedUltra) {
			thinkingLevel = getHighestSupportedThinkingLevel(model);
			const warning =
				"Ultra is unavailable for unattended execution; using the model's highest normal thinking level.";
			modelFallbackMessage = modelFallbackMessage ? `${modelFallbackMessage}. ${warning}` : warning;
		} else if (thinkingSelection === "ultra") thinkingLevel = getHighestSupportedThinkingLevel(model);
		else if (thinkingSelection !== undefined) thinkingLevel = thinkingSelection;

		// Clamp to model capabilities
		if (!model) {
			thinkingLevel = "off";
		} else {
			thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
		}

		const ultraCapable = canUseUltra({
			hostAllowsUltra: options.ultraAvailable === true && !options.unattendedExecution,
			persisted: sessionManager.isPersisted(),
			mode: sessionManager.getMode(),
			isSubagent: sessionManager.getHeader()?.subagent !== undefined,
		});
		if (sessionManager.getSubagentsEnabled() && !ultraCapable) {
			if (sessionManager.getHeader()?.subagent) {
				throw new Error("A subagent session cannot restore Ultra");
			}
			sessionManager.setSubagentsEnabled(false);
			thinkingSelection = undefined;
			thinkingLevel = getHighestSupportedThinkingLevel(model);
			const warning =
				"Saved Ultra is available only in persisted Code sessions; using the model's highest normal thinking level.";
			modelFallbackMessage = modelFallbackMessage ? `${modelFallbackMessage}. ${warning}` : warning;
		}

		const isSubagent = sessionManager.getHeader()?.subagent !== undefined;
		const defaultActiveToolNames: ToolName[] = [
			"read",
			"grep",
			"bash",
			"edit",
			"write",
			"web_fetch",
			...(settingsManager.getWebSearchSettings().enabled ? (["web_search"] as const) : []),
			...(isSubagent ? [] : (["set_tasks"] as const)),
		];
		const allowedToolNames = options.unattendedExecution
			? [...UNATTENDED_TOOL_NAMES]
			: (options.tools ?? (options.noTools === "all" ? [] : undefined));
		const excludedToolNames = isSubagent
			? [...new Set([...(options.excludeTools ?? []), "set_tasks"])]
			: options.excludeTools;
		const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
		const initialActiveToolNames: string[] = (
			options.unattendedExecution
				? [...UNATTENDED_TOOL_NAMES]
				: options.tools
					? [...options.tools]
					: options.noTools
						? []
						: defaultActiveToolNames
		)
			.concat(
				mcpManager ? mcpManager.getDirectToolNames() : [],
				mcpManager ? restoredMcpToolNames(sessionManager, mcpManager) : [],
			)
			.filter((name) => !excludedToolNameSet?.has(name))
			.filter((name) => name !== "web_search" || settingsManager.getWebSearchSettings().enabled);

		let agent: Agent;

		const extensionRunnerRef: { current?: ExtensionRunner } = {};

		agent = new Agent({
			initialState: {
				systemPrompt: "",
				model,
				thinkingLevel,
				tools: [],
			},
			convertToLlm,
			streamFn: async (model, context, options) => {
				const auth = await modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				const env = auth.env || options?.env ? { ...(auth.env ?? {}), ...(options?.env ?? {}) } : undefined;
				const providerRetrySettings = settingsManager.getProviderRetrySettings();
				const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
				// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
				// Use max int32 to effectively disable the timeout.
				const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
				const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
				const websocketConnectTimeoutMs =
					options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
				let headers = mergeProviderAttributionHeaders(
					model,
					settingsManager,
					options?.sessionId,
					auth.headers,
					options?.headers,
				);
				// Let extensions inject/adjust per-request headers (e.g. tracing, session correlation)
				// after static assembly, before the provider HTTP call.
				const headerRunner = extensionRunnerRef.current;
				if (headerRunner?.hasHandlers("before_provider_headers")) {
					headers = await headerRunner.emitBeforeProviderHeaders(headers ?? {});
				}
				return modelRegistry.streamSimple(model, context, {
					...options,
					apiKey: auth.apiKey,
					env,
					timeoutMs,
					websocketConnectTimeoutMs,
					maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
					headers,
				});
			},
			onPayload: async (payload, _model) => {
				const runner = extensionRunnerRef.current;
				if (!runner?.hasHandlers("before_provider_request")) {
					return payload;
				}
				return runner.emitBeforeProviderRequest(payload);
			},
			onResponse: async (response, _model) => {
				const runner = extensionRunnerRef.current;
				if (!runner?.hasHandlers("after_provider_response")) {
					return;
				}
				await runner.emit({
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
				});
			},
			sessionId: sessionManager.getSessionId(),
			transformContext: async (messages) => {
				const runner = extensionRunnerRef.current;
				if (!runner) return messages;
				return runner.emitContext(messages);
			},
			steeringMode: settingsManager.getSteeringMode(),
			followUpMode: settingsManager.getFollowUpMode(),
			transport: settingsManager.getTransport(),
			thinkingBudgets: settingsManager.getThinkingBudgets(),
			maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		});

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.state.messages = existingSession.messages;
			if (!hasThinkingEntry) {
				sessionManager.appendThinkingLevelChange(thinkingLevel);
			}
		} else {
			// Save initial model and thinking level for new sessions so they can be restored on resume
			if (model) {
				sessionManager.appendModelChange(model.provider, model.id);
			}
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}

		const extensionsResult = resourceLoader.getExtensions();
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd,
			agentDir,
			scopedModels: options.scopedModels,
			resourceLoader,
			customTools: options.unattendedExecution ? [] : options.customTools,
			modelRegistry,
			mcpManager,
			initialActiveToolNames,
			defaultBuiltinToolsEnabled: options.noTools === undefined,
			allowedToolNames,
			excludedToolNames,
			extensionRunnerRef,
			sessionStartEvent: options.sessionStartEvent,
			requestPermissionApproval: createActionPermissionRequester(options.onPermissionRequest),
			ultraAvailable: options.ultraAvailable,
			additionalSystemPrompt: options.additionalSystemPrompt,
			includeAutoMemory: options.includeAutoMemory,
			permissionModeCeiling: options.permissionModeCeiling,
			unattendedExecution: options.unattendedExecution,
		});
		if (thinkingSelection === "ultra") session.setThinkingSelection("ultra");
		completed = true;
		return {
			session,
			extensionsResult,
			modelFallbackMessage,
		};
	} finally {
		if (!completed) {
			try {
				if (ownsMcpManager) await mcpManager?.close();
			} finally {
				try {
					if (ownsResourceLoader) resourceLoader?.dispose?.();
				} finally {
					// Managers created by the SDK transfer to AgentSession only on success.
					if (ownsSessionManager) {
						try {
							sessionManager.close();
						} finally {
							if (workspace?.cwdOrigin === "managed") {
								removeOwnedManagedWorkspace({ id: sessionId!, cwd, cwdOrigin: "managed", agentDir });
							}
						}
					}
				}
			}
		}
	}
}
