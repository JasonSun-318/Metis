import type { AgentMode } from "./agent-mode.ts";

export type PermissionMode = "ask" | "auto" | "full";

export interface PermissionSettings {
	readonly mode: PermissionMode;
	readonly reviewerEnabled: boolean;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "ask" || value === "auto" || value === "full";
}

export function defaultPermissionSettings(agentMode: AgentMode): PermissionSettings {
	return {
		mode: agentMode === "chat" ? "ask" : "auto",
		reviewerEnabled: true,
	};
}
