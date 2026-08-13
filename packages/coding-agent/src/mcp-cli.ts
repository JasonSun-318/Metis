import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { AuthStorage, mcpCredentialKey } from "./core/auth-storage.ts";
import { resolveMcpServerSettings } from "./core/mcp/config.ts";
import type { McpServerSettings, McpStdioServerSettings, SettingsScope } from "./core/settings-manager.ts";
import {
	createCommandSettingsManager,
	type PackageCommandRuntimeOptions,
	reportProjectTrustWarnings,
	reportSettingsErrors,
} from "./package-manager-cli.ts";

type McpCliScope = "user" | "project";

type McpCliCommand =
	| { action: "help" }
	| { action: "list"; approve?: boolean }
	| { action: "get"; name: string; approve?: boolean }
	| {
			action: "add";
			name: string;
			scope: McpCliScope;
			approve?: boolean;
			server: McpServerSettings;
	  }
	| { action: "remove"; name: string; scope: McpCliScope; approve?: boolean };

const MCP_USAGE = `${APP_NAME} mcp <add|list|get|remove>`;

function printMcpHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} mcp add <name> -- <command> [args...]
    [--env <NAME>]...
  ${APP_NAME} mcp add <name> --url <http-or-https-url>
    [--bearer-token-env-var <NAME>]
    [--scope user|project] [--approve]
  ${APP_NAME} mcp list
  ${APP_NAME} mcp get <name>
  ${APP_NAME} mcp remove <name> [--scope user|project] [--approve]

Direct secret values are entered through the /mcp TUI and are never accepted as CLI flags.
Project definitions are stored in ${CONFIG_DIR_NAME}/settings.json and require project trust.`);
}

function requiredValue(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value === "--" || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
	return value;
}

function parseScope(value: string): McpCliScope {
	if (value !== "user" && value !== "project") throw new Error(`Invalid scope "${value}"; expected user or project`);
	return value;
}

function parseEnvironmentName(value: string, option: string): string {
	if (!value.trim() || value.includes("=") || value.includes("\0")) {
		throw new Error(`${option} requires an environment variable name`);
	}
	return value;
}

function parseApprovalOptions(args: string[]): boolean | undefined {
	let approve: boolean | undefined;
	for (const arg of args) {
		if (arg === "--approve") approve = true;
		else if (arg === "--no-approve") approve = false;
		else throw new Error(`Unknown option ${arg}`);
	}
	return approve;
}

function parseCommonOptions(args: string[]): { scope: McpCliScope; approve?: boolean } {
	let scope: McpCliScope = "user";
	let approve: boolean | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--scope") {
			scope = parseScope(requiredValue(args, index, arg));
			index++;
		} else if (arg === "--approve") approve = true;
		else if (arg === "--no-approve") approve = false;
		else throw new Error(`Unknown option ${arg}`);
	}
	return { scope, approve };
}

function parseAdd(name: string | undefined, args: string[]): McpCliCommand {
	if (!name || name.startsWith("-")) throw new Error("Missing MCP server name");
	let scope: McpCliScope = "user";
	let approve: boolean | undefined;
	let url: string | undefined;
	let bearerTokenEnvVar: string | undefined;
	const envVars: string[] = [];
	let command: string[] | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			command = args.slice(index + 1);
			break;
		}
		if (arg === "--url") {
			url = requiredValue(args, index, arg);
			index++;
		} else if (arg === "--env") {
			envVars.push(parseEnvironmentName(requiredValue(args, index, arg), arg));
			index++;
		} else if (arg === "--bearer-token-env-var") {
			bearerTokenEnvVar = parseEnvironmentName(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--scope") {
			scope = parseScope(requiredValue(args, index, arg));
			index++;
		} else if (arg === "--approve") approve = true;
		else if (arg === "--no-approve") approve = false;
		else throw new Error(`Unknown option ${arg}`);
	}

	if (url && command) throw new Error("Choose either --url or -- <command>, not both");
	if (!url && (!command || command.length === 0)) throw new Error("Add requires --url or -- <command>");
	if (url && envVars.length > 0) throw new Error("--env is available only for stdio MCP servers");
	if (command && bearerTokenEnvVar) {
		throw new Error("--bearer-token-env-var is available only for HTTP MCP servers");
	}
	const server: McpServerSettings = url
		? { url, bearerTokenEnvVar }
		: { command: command![0]!, args: command!.slice(1), envVars };
	return { action: "add", name, scope, approve, server };
}

function parseMcpCommand(args: string[]): McpCliCommand {
	const [, action, ...rest] = args;
	if (!action || action === "-h" || action === "--help") return { action: "help" };
	if (action === "add") return parseAdd(rest[0], rest.slice(1));
	if (action === "list") {
		return { action, approve: parseApprovalOptions(rest) };
	}
	if (action === "get") {
		const [name, ...options] = rest;
		if (!name || name.startsWith("-")) throw new Error("Missing MCP server name");
		return { action, name, approve: parseApprovalOptions(options) };
	}
	if (action === "remove") {
		const [name, ...options] = rest;
		if (!name || name.startsWith("-")) throw new Error("Missing MCP server name");
		return { action, name, ...parseCommonOptions(options) };
	}
	throw new Error(`Unknown MCP command "${action}"`);
}

function settingsScope(scope: McpCliScope): SettingsScope {
	return scope === "user" ? "global" : "project";
}

function safeConfiguration(server: McpServerSettings): McpServerSettings {
	if (!("command" in server)) return server;
	const stdio = server as McpStdioServerSettings;
	if (!stdio.env) return server;
	return { ...stdio, env: Object.fromEntries(Object.keys(stdio.env).map((name) => [name, "<redacted>"])) };
}

function findDefinition(
	name: string,
	globalServers: Record<string, McpServerSettings>,
	projectServers: Record<string, McpServerSettings>,
): { scope: McpCliScope; server: McpServerSettings } | undefined {
	if (projectServers[name]) return { scope: "project", server: projectServers[name] };
	return globalServers[name] ? { scope: "user", server: globalServers[name] } : undefined;
}

export async function handleMcpCliCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	if (args[0] !== "mcp") return false;

	let command: McpCliCommand;
	try {
		command = parseMcpCommand(args);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		console.error(chalk.dim(`Usage: ${MCP_USAGE}`));
		process.exitCode = 1;
		return true;
	}
	if (command.action === "help") {
		printMcpHelp();
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: command.approve,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	reportSettingsErrors(settingsManager, "mcp command");

	try {
		if ((command.action === "add" || command.action === "remove") && command.scope === "project") {
			if (!settingsManager.isProjectTrusted())
				throw new Error("Project is not trusted. Use --approve to modify it.");
		}
		const globalServers = settingsManager.getGlobalSettings().mcpServers ?? {};
		const projectServers = settingsManager.getProjectSettings().mcpServers ?? {};

		if (command.action === "list") {
			const rows = [
				...Object.entries(globalServers).map(([name, server]) => ({
					name,
					scope: "user",
					transport: "url" in server ? "http" : "stdio",
				})),
				...Object.entries(projectServers).map(([name, server]) => ({
					name,
					scope: "project",
					transport: "url" in server ? "http" : "stdio",
				})),
			];
			if (rows.length === 0) console.log("No MCP servers configured.");
			else console.log(JSON.stringify(rows, null, 2));
			return true;
		}

		if (command.action === "get") {
			const definition = findDefinition(command.name, globalServers, projectServers);
			if (!definition) throw new Error(`MCP server "${command.name}" is not configured`);
			console.log(
				JSON.stringify(
					{ name: command.name, ...definition, server: safeConfiguration(definition.server) },
					null,
					2,
				),
			);
			return true;
		}

		const scope = settingsScope(command.scope);
		const servers = scope === "global" ? globalServers : projectServers;
		if (command.action === "add") {
			if (servers[command.name])
				throw new Error(`MCP server "${command.name}" already exists in ${command.scope} settings`);
			resolveMcpServerSettings(command.name, command.server, cwd, process.env);
			settingsManager.setMcpServer(scope, command.name, command.server);
			await settingsManager.flush();
			const errors = settingsManager.drainErrors();
			if (errors.length > 0) throw errors[0]!.error;
			console.log(chalk.green(`Added MCP server "${command.name}" to ${command.scope} settings.`));
			return true;
		}

		if (!settingsManager.removeMcpServer(scope, command.name)) {
			throw new Error(`MCP server "${command.name}" is not configured in ${command.scope} settings`);
		}
		await settingsManager.flush();
		const errors = settingsManager.drainErrors();
		if (errors.length > 0) throw errors[0]!.error;
		AuthStorage.create(join(agentDir, "auth.json")).remove(
			mcpCredentialKey(
				command.scope === "user"
					? { scope: "user", name: command.name }
					: { scope: "project", name: command.name, cwd },
			),
		);
		console.log(chalk.green(`Removed MCP server "${command.name}" from ${command.scope} settings.`));
		return true;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
		return true;
	}
}
