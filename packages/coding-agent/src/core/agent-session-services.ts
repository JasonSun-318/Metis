import { join } from "node:path";
import type { ThinkingLevel } from "@metis/agent-core";
import type { Model } from "@metis/ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { createDeclarativeHooksBridge } from "./hooks/hook-bridge.ts";
import type { McpConfigurationCoordinator } from "./mcp/configuration.ts";
import { MemoryEvents } from "./memory/vault-events.ts";
import { ModelRegistry } from "./model-registry.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { UnattendedExecutionProfile } from "./unattended-execution.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	/** @internal Prevent child runtimes from loading executable extension code. */
	isolatedChild?: boolean;
	/** Runtime-owned auth view. Use separate instances when runtimes share one credential file. */
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	mcpConfigurationCoordinator?: McpConfigurationCoordinator;
	modelRegistry?: ModelRegistry;
	extensionFlagValues?: Map<string, boolean | string>;
	/** Host-shared vault emitter; sessions and Dream runs in this runtime publish to it. */
	memoryEvents?: MemoryEvents;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	thinkingSelection?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	/** @internal Allow host UIs to render before optional MCP servers finish connecting. */
	backgroundOptionalMcpStartup?: boolean;
	onPermissionRequest?: CreateAgentSessionOptions["onPermissionRequest"];
	additionalSystemPrompt?: string | (() => string | undefined);
	includeAutoMemory?: boolean;
	/** Host-shared vault emitter so host-side memory services observe every write. */
	memoryEvents?: MemoryEvents;
	permissionSettingsCeiling?: CreateAgentSessionOptions["permissionSettingsCeiling"];
	workspaceWritePolicy?: CreateAgentSessionOptions["workspaceWritePolicy"];
	/** Host-only fail-closed profile for unattended runs. */
	unattendedExecution?: UnattendedExecutionProfile;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	memoryEvents: MemoryEvents;
	mcpConfigurationCoordinator?: McpConfigurationCoordinator;
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	if (options.authStorage && options.modelRegistry && options.modelRegistry.authStorage !== options.authStorage) {
		throw new Error("authStorage must match modelRegistry.authStorage");
	}
	const authStorage =
		options.modelRegistry?.authStorage ?? options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const requestedResourceLoaderOptions = options.resourceLoaderOptions ?? {};
	const resourceLoaderOptions = options.isolatedChild
		? {
				...requestedResourceLoaderOptions,
				additionalExtensionPaths: [],
				extensionFactories: [],
				noExtensions: true,
			}
		: requestedResourceLoaderOptions;
	// Declarative hooks ride along as an inline extension resolved dynamically per reload,
	// but only when extensions load: unattended execution requires zero extensions.
	const declarativeHooksBridgeProvider = resourceLoaderOptions.noExtensions
		? undefined
		: (resourceLoaderOptions.declarativeHooksBridgeProvider ?? createDeclarativeHooksBridge);
	const resourceLoader = new DefaultResourceLoader({
		...resourceLoaderOptions,
		declarativeHooksBridgeProvider,
		cwd,
		agentDir,
		settingsManager,
	});
	let completed = false;
	try {
		await resourceLoader.reload(options.resourceLoaderReloadOptions);

		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const extensionsResult = resourceLoader.getExtensions();
		for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
			try {
				modelRegistry.registerExtensionProvider(name, config);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({
					type: "error",
					message: `Extension "${extensionPath}" error: ${message}`,
				});
			}
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
		diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

		const services = {
			cwd,
			agentDir,
			authStorage,
			settingsManager,
			modelRegistry,
			resourceLoader,
			diagnostics,
			memoryEvents: options.memoryEvents ?? new MemoryEvents(),
			mcpConfigurationCoordinator: options.mcpConfigurationCoordinator,
		};
		completed = true;
		return services;
	} finally {
		if (!completed) resourceLoader.dispose();
	}
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		thinkingSelection: options.thinkingSelection,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		backgroundOptionalMcpStartup: options.backgroundOptionalMcpStartup,
		mcpConfigurationCoordinator: options.services.mcpConfigurationCoordinator,
		onPermissionRequest: options.onPermissionRequest,
		additionalSystemPrompt: options.additionalSystemPrompt,
		includeAutoMemory: options.includeAutoMemory,
		memoryEvents: options.memoryEvents ?? options.services.memoryEvents,
		permissionSettingsCeiling: options.permissionSettingsCeiling,
		workspaceWritePolicy: options.workspaceWritePolicy,
		unattendedExecution: options.unattendedExecution,
		sessionStartEvent: options.sessionStartEvent,
	});
}
