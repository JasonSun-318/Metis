import type { ThinkingLevel } from "@metis/agent-core";
import type { Model } from "@metis/ai/compat";
import type { AgentMode } from "./agent-mode.ts";
import type { AgentSession, AgentSessionConfig } from "./agent-session.ts";
import type { AuthStorage } from "./auth-storage.ts";
import type { LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import type { McpConfigurationCoordinator, McpManager } from "./mcp/index.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { PermissionPreset } from "./permissions/settings.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
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
	withFileMutationQueue,
} from "./tools/index.ts";
import type { UnattendedExecutionProfile } from "./unattended-execution.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.metis/agent */
	agentDir?: string;
	/** Classification mode for a newly-created default session manager. Default: code. */
	agentMode?: AgentMode;
	/** Initial permission preset for a newly-created session. */
	permissionPreset?: PermissionPreset;
	/** Host callback for one-action approvals. */
	onPermissionRequest?: PermissionRequester;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;
	/** Injectable MCP manager. Ownership transfers to AgentSession after successful construction. */
	mcpManager?: McpManager;
	/** Process-owned MCP configuration coordinator shared by sibling sessions. */
	mcpConfigurationCoordinator?: McpConfigurationCoordinator;
	/** @internal Allow host UIs to render before optional MCP servers finish connecting. */
	backgroundOptionalMcpStartup?: boolean;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Initial thinking selection; identical to thinkingLevel. */
	thinkingSelection?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

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
	/** @internal Host-owned prompt suffix for parent/child runtime profiles. */
	additionalSystemPrompt?: string | (() => string | undefined);
	/** @internal Disable the memory vault snapshot and memory tools for isolated runtimes. */
	includeAutoMemory?: boolean;
	/** @internal Host-shared vault emitter; session vault writes broadcast through it. */
	memoryEvents?: AgentSessionConfig["memoryEvents"];
	/** @internal Host-owned monotonic permission ceiling for a child runtime. */
	permissionSettingsCeiling?: AgentSessionConfig["permissionSettingsCeiling"];
	/** @internal Host-owned workspace write ceiling for a child runtime. */
	workspaceWritePolicy?: AgentSessionConfig["workspaceWritePolicy"];
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

export type PermissionRequester = (
	request: PermissionRequest,
	signal?: AbortSignal,
) => Promise<"allow-once" | "always-allow-project" | "deny">;

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

export { createAgentSession } from "./agent-session-factory.ts";
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
