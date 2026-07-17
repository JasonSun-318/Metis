export type AgentMode = "chat" | "code";

export const DEFAULT_AGENT_MODE: AgentMode = "code";

export function isAgentMode(value: unknown): value is AgentMode {
	return value === "chat" || value === "code";
}
