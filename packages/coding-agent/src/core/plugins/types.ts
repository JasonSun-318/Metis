import type { DeclarativeHook } from "../hooks/declarative-hooks.ts";
import type { McpServerSettings } from "../settings-manager.ts";

export type PluginFormat = "claude" | "codex" | "agent-skills";
export type CapabilityKind = "skill" | "mcp" | "hook" | "unsupported";

export interface PluginOwner {
	pluginId: string;
	displayName: string;
	componentId: string;
}

export interface PluginIssue {
	code: string;
	componentId: string;
	message: string;
	status: "unsupported" | "needs-configuration" | "warning";
}

export interface PluginManifestHints {
	name?: string;
	description?: string;
	strict?: boolean;
	skills?: readonly string[];
}

export interface PluginRecord {
	id: string;
	name: string;
	displayName: string;
	format: PluginFormat;
	repository: string;
	subdir: string;
	commit: string;
	version?: string;
	trackingRef?: string;
	pinnedCommit?: string;
	manifestHints?: PluginManifestHints;
	sourceId: string;
	enabled: boolean;
	installedAt: string;
	issues: PluginIssue[];
}

export interface MarketRecord {
	id: string;
	url: string;
	displayName: string;
	selected: boolean;
	fetchedAt?: string;
	commit?: string;
	root?: string;
	trackingRef?: string;
	pinnedCommit?: string;
}

export interface PluginRegistry {
	schemaVersion: 1;
	revision: number;
	markets: MarketRecord[];
	installed: PluginRecord[];
	pendingCredentialCleanup?: string[];
}

export interface PluginSkillComponent {
	kind: "skill";
	owner: PluginOwner;
	name: string; // unique invocation name (e.g. p-abcd1234-my-skill)
	originalName: string; // original name in SKILL.md
	filePath: string; // absolute path in controlled packages directory
	baseDir: string;
	disableModelInvocation?: boolean;
}

export interface PluginMcpComponent {
	kind: "mcp";
	owner: PluginOwner;
	name: string;
	originalName: string;
	packageDir: string;
	definition: McpServerSettings; // template, variables resolved at instantiation
}

export interface PluginHookComponent {
	kind: "hook";
	owner: PluginOwner;
	packageDir: string;
	definition: DeclarativeHook;
}

export interface PluginSnapshot {
	fingerprint: string;
	plugins: PluginRecord[]; // only enabled
	skills: PluginSkillComponent[];
	mcp: PluginMcpComponent[];
	hooks: PluginHookComponent[];
	diagnostics: PluginIssue[];
}
