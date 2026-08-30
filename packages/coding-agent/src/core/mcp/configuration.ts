import { createHash } from "node:crypto";
import type { McpServerSettings, SettingsManager } from "../settings-manager.ts";

export type McpConfigurationScope = "user" | "project";

export type McpCredentialChange =
	| { readonly action: "preserve" }
	| { readonly action: "remove" }
	| {
			readonly action: "replace";
			readonly bearerToken?: string;
			readonly environment?: Readonly<Record<string, string>>;
	  };

export interface McpConfigurationChange {
	readonly name: string;
	readonly expectedRevision: string | null;
	readonly next: McpServerSettings | undefined;
	readonly credential: McpCredentialChange;
}

export interface McpConfigurationMutation {
	readonly settingsManager: SettingsManager;
	readonly cwd: string;
	readonly scope: McpConfigurationScope;
	readonly changes: readonly McpConfigurationChange[];
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function mcpConfigurationRevision(
	scope: McpConfigurationScope,
	name: string,
	server: McpServerSettings,
): string {
	return createHash("sha256")
		.update(canonicalJson([scope, name, server]))
		.digest("hex");
}

export class McpConfigurationConflictError extends Error {
	readonly names: readonly string[];

	constructor(names: readonly string[]) {
		super(`MCP configuration changed: ${names.join(", ")}`);
		this.name = "McpConfigurationConflictError";
		this.names = names;
	}
}
