import type {
	ClientParams,
	McpCatalogEntryView,
	McpServerDetailView,
	McpServerSummaryView,
	PluginOwnerView,
} from "@metis/app-protocol";
import {
	type McpServerSettings,
	type McpServerStatus,
	type McpStdioServerSettings,
	mcpConfigurationRevision,
	type ResolvedMcpServerConfig,
	resolveMcpServerSettings,
	type SettingsManager,
} from "@metis/coding-agent";

type McpServerInput = ClientParams<"mcp/upsert">["server"];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isEnvironmentName(value: string): boolean {
	return value.length <= 256 && ENVIRONMENT_NAME.test(value);
}

function publicEnvironmentMap(value: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!value) return undefined;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([header, environmentName]) =>
					header.length > 0 &&
					header.length <= 256 &&
					!["__proto__", "constructor", "prototype"].includes(header) &&
					isEnvironmentName(environmentName),
			)
			.slice(0, 128),
	);
}

export function mcpRevision(
	scope: "user" | "project",
	name: string,
	server: McpServerSettings,
	credentialState?: string,
): string {
	return mcpConfigurationRevision(scope, name, server, credentialState);
}

function publicHttpUrl(value: string): { url?: string; error?: string } {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "MCP URL must use HTTP(S)" };
		const hadCredentials = Boolean(url.username || url.password);
		url.username = "";
		url.password = "";
		if (url.href.length > 8192) return { error: "MCP URL is too long" };
		return { url: url.href, ...(hadCredentials ? { error: "MCP URL credentials are hidden; edit required" } : {}) };
	} catch {
		return { error: "MCP URL is invalid" };
	}
}

export function publicMcpServer(input: {
	scope: "user" | "project" | "plugin";
	name: string;
	server: McpServerSettings;
	effective: boolean;
	status?: McpServerStatus;
	credentialConfigured?: boolean;
	credentialState?: string;
	pluginOwner?: PluginOwnerView;
	originalName?: string;
}): McpServerSummaryView {
	const { scope, name, server, effective, status, pluginOwner, originalName } = input;
	const serverInfoName = status?.serverInfo?.name.slice(0, 256);
	const startupTimeoutSec =
		typeof server.startupTimeoutSec === "number" && server.startupTimeoutSec > 0 && server.startupTimeoutSec <= 3_600
			? server.startupTimeoutSec
			: undefined;
	const toolTimeoutSec =
		typeof server.toolTimeoutSec === "number" && server.toolTimeoutSec > 0 && server.toolTimeoutSec <= 86_400
			? server.toolTimeoutSec
			: undefined;
	const description = server.description?.trim();
	const common = {
		name,
		...(pluginOwner ? { pluginOwner } : {}),
		...(originalName ? { originalName } : {}),
		...(description && Buffer.byteLength(description, "utf8") <= 4096 ? { description } : {}),
		scope,
		effective,
		revision: mcpRevision(scope === "plugin" ? "user" : scope, name, server, input.credentialState),
		enabled: server.enabled ?? true,
		required: server.required ?? false,
		...(startupTimeoutSec === undefined ? {} : { startupTimeoutSec }),
		...(toolTimeoutSec === undefined ? {} : { toolTimeoutSec }),
		...(server.enabledTools === undefined
			? {}
			: {
					enabledTools: [
						...new Set(server.enabledTools.filter((value) => value.length > 0 && value.length <= 256)),
					]
						.sort()
						.slice(0, 512),
				}),
		disabledTools: [
			...new Set((server.disabledTools ?? []).filter((value) => value.length > 0 && value.length <= 256)),
		]
			.sort()
			.slice(0, 512),
		state: effective ? (status?.state ?? (server.enabled === false ? "disabled" : "inactive")) : "shadowed",
		credentialConfigured: input.credentialConfigured ?? false,
		toolCount: effective ? (status?.toolCount ?? 0) : 0,
		resourceCount: effective ? (status?.resourceCount ?? 0) : 0,
		resourceTemplateCount: effective ? (status?.resourceTemplateCount ?? 0) : 0,
		promptCount: effective ? (status?.promptCount ?? 0) : 0,
		capabilities: effective
			? [...new Set((status?.capabilities ?? []).filter((value) => value.length > 0 && value.length <= 256))]
					.sort()
					.slice(0, 128)
			: [],
		...(effective && status?.serverInfo && serverInfoName
			? { serverInfo: { name: serverInfoName, version: status.serverInfo.version.slice(0, 16_000) } }
			: {}),
	} as const;

	if (typeof server.command === "string") {
		const stdio = server as McpStdioServerSettings;
		const envVars = stdio.envVars?.filter(isEnvironmentName).slice(0, 128);
		const invalidEnvironment = envVars?.length !== stdio.envVars?.length;
		return {
			...common,
			transport: "stdio",
			command: stdio.command.slice(0, 16_000),
			...(stdio.args === undefined ? {} : { args: stdio.args.slice(0, 128).map((value) => value.slice(0, 16_000)) }),
			...(envVars === undefined ? {} : { envVars: [...new Set(envVars)].sort() }),
			...(stdio.env === undefined
				? {}
				: {
						inlineEnvKeys: Object.keys(stdio.env)
							.filter((value) => value.length > 0 && value.length <= 256)
							.sort()
							.slice(0, 128),
					}),
			...(stdio.cwd === undefined || Buffer.byteLength(stdio.cwd, "utf8") > 32 * 1024 ? {} : { cwd: stdio.cwd }),
			...(status?.lastError || invalidEnvironment
				? { lastError: status?.lastError?.slice(0, 16_000) ?? "Invalid MCP environment names are hidden" }
				: {}),
		};
	}

	const projectedUrl = publicHttpUrl(server.url);
	const bearerTokenEnvVar =
		server.bearerTokenEnvVar && isEnvironmentName(server.bearerTokenEnvVar) ? server.bearerTokenEnvVar : undefined;
	const envHttpHeaders = publicEnvironmentMap(server.envHttpHeaders);
	const invalidEnvironment =
		(server.bearerTokenEnvVar !== undefined && bearerTokenEnvVar === undefined) ||
		Object.keys(envHttpHeaders ?? {}).length !== Object.keys(server.envHttpHeaders ?? {}).length;
	const projectionError =
		projectedUrl.error ?? (invalidEnvironment ? "Invalid MCP environment names are hidden" : undefined);
	return {
		...common,
		transport: "http",
		...(projectedUrl.url ? { url: projectedUrl.url } : {}),
		...(bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar }),
		...(envHttpHeaders === undefined ? {} : { envHttpHeaders }),
		...(status?.lastError || projectionError
			? { lastError: status?.lastError?.slice(0, 16_000) ?? projectionError }
			: {}),
	};
}

export function inputMcpServer(
	input: McpServerInput,
	previous?: McpServerSettings,
	cwd = process.cwd(),
): McpServerSettings {
	if (
		(input.transport === "stdio" && input.envVars?.some((value) => !isEnvironmentName(value))) ||
		(input.transport === "http" &&
			((input.bearerTokenEnvVar !== undefined && !isEnvironmentName(input.bearerTokenEnvVar)) ||
				Object.values(input.envHttpHeaders ?? {}).some((value) => !isEnvironmentName(value))))
	) {
		throw new Error("Invalid MCP environment name");
	}
	const common = {
		...(input.description?.trim() ? { description: input.description.trim() } : {}),
		...(input.enabled === undefined ? {} : { enabled: input.enabled }),
		...(input.required === undefined ? {} : { required: input.required }),
		...(input.startupTimeoutSec === undefined ? {} : { startupTimeoutSec: input.startupTimeoutSec }),
		...(input.toolTimeoutSec === undefined ? {} : { toolTimeoutSec: input.toolTimeoutSec }),
		...(input.enabledTools === undefined ? {} : { enabledTools: [...input.enabledTools] }),
		...(input.disabledTools === undefined ? {} : { disabledTools: [...input.disabledTools] }),
	};
	const server: McpServerSettings =
		input.transport === "stdio"
			? {
					...common,
					command: input.command,
					...(input.args === undefined ? {} : { args: [...input.args] }),
					...(input.envVars === undefined ? {} : { envVars: [...input.envVars] }),
					...(input.cwd === undefined ? {} : { cwd: input.cwd }),
					...(previous && typeof previous.command === "string" && previous.env
						? { env: { ...previous.env } }
						: {}),
				}
			: {
					...common,
					url: input.url,
					...(input.bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar: input.bearerTokenEnvVar }),
					...(input.envHttpHeaders === undefined ? {} : { envHttpHeaders: { ...input.envHttpHeaders } }),
				};
	resolveMcpServerSettings("validation", server, cwd);
	return server;
}

export function mcpDefinitionAtScope(
	settingsManager: SettingsManager,
	scope: "user" | "project",
	name: string,
): McpServerSettings | undefined {
	const settings = scope === "user" ? settingsManager.getGlobalSettings() : settingsManager.getProjectSettings();
	return settings.mcpServers?.[name];
}

export function publicMcpServers(
	settingsManager: SettingsManager,
	options: {
		statuses?: readonly McpServerStatus[];
		serverConfigs?: readonly ResolvedMcpServerConfig[];
		credentialStatus?: (
			scope: "user" | "project",
			name: string,
			server: McpServerSettings,
			effective: boolean,
		) => { readonly revisionState: string; readonly configured: boolean } | undefined;
	} = {},
): McpServerSummaryView[] {
	const user = settingsManager.getGlobalSettings().mcpServers ?? {};
	const project = settingsManager.getProjectSettings().mcpServers ?? {};
	const statusByName = new Map((options.statuses ?? []).map((status) => [status.name, status]));
	const serverConfigByName = new Map((options.serverConfigs ?? []).map((c) => [c.name, c]));
	const rows: McpServerSummaryView[] = [];
	for (const [name, server] of Object.entries(user)) {
		if (name.length === 0 || name.length > 256) continue;
		const effective = !(name in project);
		const credentialStatus = options.credentialStatus?.("user", name, server, effective);
		rows.push(
			publicMcpServer({
				scope: "user",
				name,
				server,
				effective,
				...(effective ? { status: statusByName.get(name) } : {}),
				credentialConfigured: credentialStatus?.configured ?? false,
				credentialState: credentialStatus?.revisionState,
			}),
		);
	}
	for (const [name, server] of Object.entries(project)) {
		if (name.length === 0 || name.length > 256) continue;
		const credentialStatus = options.credentialStatus?.("project", name, server, true);
		rows.push(
			publicMcpServer({
				scope: "project",
				name,
				server,
				effective: true,
				status: statusByName.get(name),
				credentialConfigured: credentialStatus?.configured ?? false,
				credentialState: credentialStatus?.revisionState,
			}),
		);
	}
	for (const status of options.statuses ?? []) {
		if (!status.pluginOwner) continue;
		const effective = !(status.name in user) && !(status.name in project);
		const config = serverConfigByName.get(status.name);
		const serverSettings: McpServerSettings = config
			? config.transport === "http"
				? {
						url: config.url ? String(config.url) : "",
						bearerTokenEnvVar: config.bearerTokenEnvVar,
						httpHeaders: config.headerTemplates ?? config.httpHeaders,
						envHttpHeaders: config.httpHeaderEnv,
						enabled: config.enabled,
						required: config.required,
						startupTimeoutSec: config.startupTimeoutMs / 1000,
						toolTimeoutSec: config.toolTimeoutMs / 1000,
						description: config.description,
					}
				: {
						command: config.command ?? "",
						args: config.args,
						cwd: config.cwd,
						env: config.env,
						enabled: config.enabled,
						required: config.required,
						startupTimeoutSec: config.startupTimeoutMs / 1000,
						toolTimeoutSec: config.toolTimeoutMs / 1000,
						description: config.description,
					}
			: status.transport === "http"
				? { url: "https://unknown.plugin", enabled: status.state !== "disabled", required: status.required }
				: { command: "plugin", enabled: status.state !== "disabled", required: status.required };

		const credentialStatus = options.credentialStatus?.("user", status.name, serverSettings, effective);
		rows.push(
			publicMcpServer({
				scope: "plugin",
				name: status.name,
				originalName: status.originalName,
				pluginOwner: status.pluginOwner,
				server: serverSettings,
				effective,
				status,
				credentialConfigured: credentialStatus?.configured ?? false,
				credentialState: credentialStatus?.revisionState,
			}),
		);
	}
	const scopePriority = (scope: "user" | "project" | "plugin") => {
		if (scope === "user") return 0;
		if (scope === "project") return 1;
		return 2;
	};
	return rows.sort(
		(left, right) =>
			Number(right.effective) - Number(left.effective) ||
			scopePriority(left.scope) - scopePriority(right.scope) ||
			left.name.localeCompare(right.name),
	);
}

export function publicMcpDetail(
	server: McpServerSummaryView,
	catalog?: {
		tools: McpCatalogEntryView[];
		resources: McpCatalogEntryView[];
		resourceTemplates: McpCatalogEntryView[];
		prompts: McpCatalogEntryView[];
	},
): McpServerDetailView {
	return {
		server,
		tools: catalog?.tools ?? [],
		resources: catalog?.resources ?? [],
		resourceTemplates: catalog?.resourceTemplates ?? [],
		prompts: catalog?.prompts ?? [],
	};
}
