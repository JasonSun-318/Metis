import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@metis/agent-core";
import { clampThinkingLevel } from "@metis/ai/compat";
import { getAgentDir } from "../config.ts";
import { canonicalizeActionPath, resolvePath } from "../utils/paths.ts";
import { DEFAULT_AGENT_MODE } from "./agent-mode.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { ensureVaultLayout } from "./auto-memory.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { McpManager } from "./mcp/index.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import { formatPermissionApproval, type PermissionApprovalRequest } from "./permissions/approval.ts";
import { isPermissionPreset } from "./permissions/settings.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, PermissionRequester } from "./sdk.ts";
import { createSessionId } from "./session-id.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { removeOwnedManagedWorkspace, resolveNewSessionWorkspace } from "./session-workspace.ts";
import { SettingsManager, VISION_PROVIDER_ID } from "./settings-manager.ts";
import { time } from "./timings.ts";
import { getDefaultToolNames } from "./tools/index.ts";
import { UNATTENDED_TOOL_NAMES } from "./unattended-execution.ts";
import { WorkspaceSandbox } from "./workspace-sandbox.ts";

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
		if (decision === "always-allow-project") {
			return { decision: "allow" as const, remember: "project" as const };
		}
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
	const suppliedSessionManager = options.sessionManager;
	const requestedPermissionPreset =
		options.permissionPreset === undefined
			? undefined
			: isPermissionPreset(options.permissionPreset)
				? options.permissionPreset
				: undefined;
	if (options.permissionPreset !== undefined && !requestedPermissionPreset) {
		throw new TypeError("permissionPreset must be ask, auto, or full");
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
	if (suppliedSessionManager && requestedPermissionPreset !== undefined) {
		if (requestedPermissionPreset !== suppliedSessionManager.getPermissionPreset()) {
			throw new Error("permissionPreset cannot override the supplied sessionManager permissions");
		}
	}
	if (options.authStorage && options.modelRegistry && options.modelRegistry.authStorage !== options.authStorage) {
		throw new Error("authStorage must match modelRegistry.authStorage");
	}
	const childWriteDenied = suppliedSessionManager?.getHeader()?.agent?.writePolicy === "deny";
	if ((options.unattendedExecution || childWriteDenied) && options.mcpManager) {
		throw new TypeError(
			childWriteDenied
				? "Write-denied child agents cannot use an MCP manager"
				: "Unattended execution cannot use an MCP manager",
		);
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
				permissionPreset: requestedPermissionPreset,
			});
	} catch (error) {
		if (workspace?.cwdOrigin === "managed") {
			removeOwnedManagedWorkspace({ id: sessionId!, cwd, cwdOrigin: "managed", agentDir });
		}
		throw error;
	}
	const ownsSessionManager = suppliedSessionManager === undefined;
	const mcpDisabled = options.unattendedExecution !== undefined || childWriteDenied;
	let mcpManager = mcpDisabled ? undefined : options.mcpManager;
	const ownsMcpManager = !mcpDisabled && mcpManager === undefined;
	let completed = false;

	try {
		ensureVaultLayout(agentDir);
		if (!mcpDisabled) {
			mcpManager ??= await McpManager.create({
				settingsManager,
				authStorage,
				cwd,
				agentDir,
				backgroundOptionalStartup: options.backgroundOptionalMcpStartup,
				configurationCoordinator: options.mcpConfigurationCoordinator,
			});
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
		const savedThinkingLevel = settingsManager.getDefaultThinkingLevel();

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

		let thinkingLevel = options.thinkingLevel ?? options.thinkingSelection;

		// If session has data, restore thinking level from it
		if (thinkingLevel === undefined && hasExistingSession) {
			thinkingLevel = hasThinkingEntry
				? (existingSession.thinkingLevel as ThinkingLevel)
				: (savedThinkingLevel ?? DEFAULT_THINKING_LEVEL);
		}

		// Fall back to settings default
		if (thinkingLevel === undefined) {
			thinkingLevel = savedThinkingLevel ?? DEFAULT_THINKING_LEVEL;
		}

		// Clamp to model capabilities
		if (!model) {
			thinkingLevel = "off";
		} else {
			thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
		}

		const defaultActiveToolNames = getDefaultToolNames({
			visionEnabled: settingsManager.getVisionSettings() !== undefined && authStorage.has(VISION_PROVIDER_ID),
			webSearchEnabled: settingsManager.getWebSearchSettings().enabled,
			isSubagent: suppliedSessionManager?.getHeader()?.agent !== undefined,
		});
		const allowedToolNames = options.unattendedExecution
			? [...UNATTENDED_TOOL_NAMES]
			: (options.tools ?? (options.noTools === "all" ? [] : undefined));
		const excludedToolNames = suppliedSessionManager?.getHeader()?.agent
			? [...new Set([...(options.excludeTools ?? []), "set_tasks", "get_goal", "create_goal", "update_goal"])]
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
			.filter((name) => name !== "web_search" || settingsManager.getWebSearchSettings().enabled)
			.filter(
				(name) =>
					name !== "describe_image" ||
					(settingsManager.getVisionSettings() !== undefined && authStorage.has(VISION_PROVIDER_ID)),
			);

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
		const sandboxHealth = await WorkspaceSandbox.health();
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
			additionalSystemPrompt: options.additionalSystemPrompt,
			includeAutoMemory: options.includeAutoMemory,
			memoryEvents: options.memoryEvents,
			permissionSettingsCeiling: options.permissionSettingsCeiling,
			workspaceWritePolicy: options.workspaceWritePolicy,
			unattendedExecution: options.unattendedExecution,
			sandboxHealth: sandboxHealth.status,
			sandboxHealthProbe: WorkspaceSandbox.health,
		});
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
