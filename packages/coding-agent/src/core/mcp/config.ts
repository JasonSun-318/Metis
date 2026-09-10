import { createHash } from "node:crypto";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { type McpCredentialIdentity, mcpCredentialKey, mcpVersionedCredentialKey } from "../auth-storage.ts";
import { readPluginSnapshot } from "../plugins/registry.ts";
import type { PluginMcpComponent, PluginOwner } from "../plugins/types.ts";
import type {
	McpHttpServerSettings,
	McpServerSettings,
	McpStdioServerSettings,
	SettingsManager,
} from "../settings-manager.ts";

export interface ResolvedMcpServerConfig {
	name: string;
	pluginOwner?: PluginOwner;
	originalName?: string;
	description?: string;
	credentialIdentity: McpCredentialIdentity;
	credentialKey: string;
	credentialVersion?: string;
	transport: "stdio" | "http";
	enabled: boolean;
	required: boolean;
	startupTimeoutMs: number;
	toolTimeoutMs: number;
	enabledTools?: string[];
	disabledTools: string[];
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: URL;
	bearerToken?: string;
	bearerTokenEnvVar?: string;
	httpHeaders?: Record<string, string>;
	httpHeaderEnv?: Record<string, string>;
}

export function resolvePluginTemplateVariables(value: string, context: { pluginRoot: string; cwd: string }): string {
	return value.replace(
		/\$\{(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|workspaceFolder|PROJECT_ROOT|cwd)\}|\$(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|workspaceFolder|PROJECT_ROOT|cwd)\b/g,
		(_match, bracedKey, bareKey) => {
			const key = bracedKey ?? bareKey;
			switch (key) {
				case "CLAUDE_PLUGIN_ROOT":
				case "PLUGIN_ROOT":
					return context.pluginRoot;
				case "workspaceFolder":
				case "PROJECT_ROOT":
				case "cwd":
					return context.cwd;
				default:
					return _match;
			}
		},
	);
}

export interface ResolvedMcpSettings {
	servers: ResolvedMcpServerConfig[];
}

type McpFingerprintSource = Pick<ResolvedMcpServerConfig, "transport" | "url" | "command" | "args" | "cwd">;

export function mcpServerFingerprint(config: McpFingerprintSource): string {
	const identity =
		config.transport === "http"
			? ["http", config.url?.href]
			: ["stdio", config.command, config.args ?? [], config.cwd];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function withCredentialKey(config: Omit<ResolvedMcpServerConfig, "credentialKey">): ResolvedMcpServerConfig {
	return {
		...config,
		credentialKey: config.credentialVersion
			? mcpVersionedCredentialKey(config.credentialIdentity, mcpServerFingerprint(config), config.credentialVersion)
			: mcpCredentialKey(config.credentialIdentity),
	};
}

function positiveSeconds(value: unknown, key: string, fallback: number): number {
	if (value === undefined) return fallback * 1000;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid MCP ${key}; expected a positive number`);
	}
	return Math.floor(value * 1000);
}

function stringArray(value: unknown, key: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`Invalid MCP ${key}; expected non-empty strings`);
	}
	return [...new Set(value)];
}

function stringRecord(value: unknown, key: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid MCP ${key}; expected an object of strings`);
	}
	const entries = Object.entries(value);
	if (entries.some(([name, item]) => !name || typeof item !== "string")) {
		throw new Error(`Invalid MCP ${key}; expected an object of strings`);
	}
	return Object.fromEntries(entries as Array<[string, string]>);
}

function optionalBoolean(value: unknown, key: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`Invalid MCP ${key}; expected a boolean`);
	return value;
}

function optionalDescription(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("Invalid MCP description; expected a string");
	const description = value.trim();
	if (!description) return undefined;
	if (Buffer.byteLength(description, "utf8") > 4096) {
		throw new Error("Invalid MCP description; expected at most 4096 UTF-8 bytes");
	}
	return description;
}

function optionalCredentialVersion(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value || value.length > 128) {
		throw new Error("Invalid MCP credential version");
	}
	return value;
}

export function resolveMcpServerSettings(
	name: string,
	server: McpServerSettings,
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
	credentialIdentity: McpCredentialIdentity = { scope: "user", name },
	options?: {
		pluginOwner?: PluginOwner;
		originalName?: string;
	},
): ResolvedMcpServerConfig {
	if (!name.trim()) throw new Error("MCP server name must not be empty");
	if (typeof server !== "object" || server === null || Array.isArray(server)) {
		throw new Error(`Invalid MCP server "${name}"; expected an object`);
	}

	const hasCommand = "command" in server && server.command !== undefined;
	const hasUrl = "url" in server && server.url !== undefined;
	if (hasCommand === hasUrl) {
		throw new Error(`MCP server "${name}" must define exactly one of command or url`);
	}

	const credentialVersion = optionalCredentialVersion(server.credentialVersion);
	const common = {
		name,
		...(options?.pluginOwner ? { pluginOwner: options.pluginOwner } : {}),
		...(options?.originalName ? { originalName: options.originalName } : {}),
		description: optionalDescription(server.description),
		credentialIdentity,
		...(credentialVersion ? { credentialVersion } : {}),
		enabled: optionalBoolean(server.enabled, "enabled", true),
		required: optionalBoolean(server.required, "required", false),
		startupTimeoutMs: positiveSeconds(server.startupTimeoutSec, "startupTimeoutSec", 10),
		toolTimeoutMs: positiveSeconds(server.toolTimeoutSec, "toolTimeoutSec", 60),
		enabledTools: stringArray(server.enabledTools, "enabledTools"),
		disabledTools: stringArray(server.disabledTools, "disabledTools") ?? [],
	};

	if (hasCommand) {
		const stdio = server as McpStdioServerSettings;
		if (typeof stdio.command !== "string" || !stdio.command.trim()) {
			throw new Error(`MCP server "${name}" requires a non-empty command`);
		}
		const args = stringArray(stdio.args, "args") ?? [];
		const envVars = stringArray(stdio.envVars, "envVars") ?? [];
		const literalEnv = stringRecord(stdio.env, "env") ?? {};
		if (stdio.cwd !== undefined && (typeof stdio.cwd !== "string" || !stdio.cwd.trim())) {
			throw new Error("Invalid MCP cwd; expected a non-empty string");
		}
		const forwarded = Object.fromEntries(
			envVars.flatMap((key) => (environment[key] === undefined ? [] : ([[key, environment[key]]] as const))),
		);
		return withCredentialKey({
			...common,
			transport: "stdio",
			command: stdio.command,
			args,
			env: { ...forwarded, ...literalEnv },
			cwd: stdio.cwd ? resolvePath(stdio.cwd, cwd) : resolvePath(cwd),
		});
	}

	const http = server as McpHttpServerSettings;
	if (typeof http.url !== "string" || !http.url) {
		throw new Error(`MCP server "${name}" requires a non-empty URL`);
	}
	if (
		http.bearerTokenEnvVar !== undefined &&
		(typeof http.bearerTokenEnvVar !== "string" || !http.bearerTokenEnvVar)
	) {
		throw new Error("Invalid MCP bearerTokenEnvVar; expected a non-empty string");
	}
	const envHttpHeaders = stringRecord(http.envHttpHeaders, "envHttpHeaders") ?? {};
	let url: URL;
	try {
		url = new URL(http.url);
	} catch {
		throw new Error(`MCP server "${name}" requires a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`MCP server "${name}" URL must use http or https`);
	}
	if (url.username || url.password) {
		throw new Error(`MCP server "${name}" URL must not contain credentials`);
	}
	const httpHeaders = Object.fromEntries(
		Object.entries(envHttpHeaders).flatMap(([header, envName]) =>
			environment[envName] === undefined ? [] : ([[header, environment[envName]]] as const),
		),
	);
	return withCredentialKey({
		...common,
		transport: "http",
		url,
		bearerToken: http.bearerTokenEnvVar ? environment[http.bearerTokenEnvVar] : undefined,
		bearerTokenEnvVar: http.bearerTokenEnvVar,
		httpHeaders,
		httpHeaderEnv: envHttpHeaders,
	});
}

function resolvePluginMcpSettings(comp: PluginMcpComponent, cwd: string): McpServerSettings {
	const vars = { pluginRoot: comp.packageDir, cwd };
	const def = comp.definition;
	if (typeof def.command === "string") {
		const resolvedCommand = resolvePluginTemplateVariables(def.command, vars);
		const resolvedArgs = def.args?.map((arg) => resolvePluginTemplateVariables(arg, vars));
		const resolvedCwd = def.cwd ? resolvePluginTemplateVariables(def.cwd, vars) : undefined;
		const resolvedEnv: Record<string, string> = {};
		if (def.env) {
			for (const [k, v] of Object.entries(def.env)) {
				resolvedEnv[k] = resolvePluginTemplateVariables(v, vars);
			}
		}
		resolvedEnv.CLAUDE_PLUGIN_ROOT = comp.packageDir;

		return {
			...def,
			command: resolvedCommand,
			args: resolvedArgs,
			cwd: resolvedCwd,
			env: resolvedEnv,
		};
	}
	if (typeof def.url === "string") {
		const resolvedUrl = resolvePluginTemplateVariables(def.url, vars);
		return {
			...def,
			url: resolvedUrl,
		};
	}
	return def;
}

export function resolveMcpSettings(
	settings: SettingsManager,
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
	agentDirOrPlugins?: string | readonly PluginMcpComponent[],
): ResolvedMcpSettings {
	return resolveMcpServerDefinitions(
		settings.getGlobalSettings().mcpServers ?? {},
		settings.getProjectSettings().mcpServers ?? {},
		cwd,
		environment,
		agentDirOrPlugins,
	);
}

export function resolveMcpServerDefinitions(
	globalServers: Readonly<Record<string, McpServerSettings>>,
	projectServers: Readonly<Record<string, McpServerSettings>>,
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
	agentDirOrPlugins?: string | readonly PluginMcpComponent[],
): ResolvedMcpSettings {
	const effective = new Map<
		string,
		{
			readonly server: McpServerSettings;
			readonly credentialIdentity: McpCredentialIdentity;
			readonly pluginOwner?: PluginOwner;
			readonly originalName?: string;
		}
	>();
	for (const [name, server] of Object.entries(globalServers)) {
		effective.set(name, { server, credentialIdentity: { scope: "user", name } });
	}
	for (const [name, server] of Object.entries(projectServers)) {
		effective.set(name, { server, credentialIdentity: { scope: "project", name, cwd } });
	}

	let pluginServers: readonly PluginMcpComponent[] = [];
	if (Array.isArray(agentDirOrPlugins)) {
		pluginServers = agentDirOrPlugins;
	} else {
		const agentDir = typeof agentDirOrPlugins === "string" ? agentDirOrPlugins : getAgentDir();
		try {
			pluginServers = readPluginSnapshot(agentDir).mcp;
		} catch {
			pluginServers = [];
		}
	}

	for (const comp of pluginServers) {
		if (effective.has(comp.name)) {
			continue;
		}
		const instantiated = resolvePluginMcpSettings(comp, cwd);
		effective.set(comp.name, {
			server: instantiated,
			credentialIdentity: { scope: "user", name: comp.name },
			pluginOwner: comp.owner,
			originalName: comp.originalName,
		});
	}

	return {
		servers: [...effective.entries()].map(([name, { server, credentialIdentity, pluginOwner, originalName }]) =>
			resolveMcpServerSettings(name, server, cwd, environment, credentialIdentity, {
				pluginOwner,
				originalName,
			}),
		),
	};
}
