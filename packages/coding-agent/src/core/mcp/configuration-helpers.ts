import type { McpServerSettings } from "../settings-manager.ts";

/** Raw TUI rule: non-empty without "=" or NUL; callers trim before checking. */
export function isValidMcpEnvironmentName(value: string): boolean {
	return Boolean(value) && !value.includes("=") && !value.includes("\0");
}

/** CLI rule: reject blank names, but otherwise return the original value unchanged. */
export function parseMcpEnvironmentName(value: string, option: string): string {
	if (!value.trim() || !isValidMcpEnvironmentName(value)) {
		throw new Error(`${option} requires an environment variable name`);
	}
	return value;
}

/** Project definitions override global/user definitions; only read global settings when needed. */
export function findMcpDefinition<GlobalScope extends string>(
	name: string,
	projectServers: Record<string, McpServerSettings> | undefined,
	getGlobalServers: () => Record<string, McpServerSettings> | undefined,
	globalScope: GlobalScope,
): { scope: "project" | GlobalScope; server: McpServerSettings } | undefined {
	const project = projectServers?.[name];
	if (project) return { scope: "project", server: project };
	const global = getGlobalServers()?.[name];
	return global ? { scope: globalScope, server: global } : undefined;
}
