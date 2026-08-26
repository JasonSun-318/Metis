import { AGENT_TOOL_NAMES, type AgentType } from "./types.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_fetch", "web_search"]);
const REVIEW_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);
const RESERVED_TOOLS = new Set<string>([...AGENT_TOOL_NAMES, "set_tasks", "get_goal", "create_goal", "update_goal"]);

export const AGENT_TYPE_CATALOG: Readonly<Record<AgentType, string>> = Object.freeze({
	default: "General analysis and execution; use when no narrower type fits.",
	explorer: "Read and search only; returns focused findings without changing files.",
	worker: "Implements changes and runs focused verification.",
	reviewer: "Reviews code and runs non-mutating checks; filesystem writes are denied.",
});

export interface ResolvedAgentProfile {
	readonly agentType: AgentType;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

export function resolveAgentProfile(input: {
	readonly agentType: AgentType;
	readonly parentTools: readonly string[];
	readonly depth: number;
	readonly maxDepth: number;
}): ResolvedAgentProfile {
	const inherited = input.parentTools.filter((name) => !RESERVED_TOOLS.has(name));
	const allowed =
		input.agentType === "explorer" ? READ_TOOLS : input.agentType === "reviewer" ? REVIEW_TOOLS : undefined;
	return {
		agentType: input.agentType,
		tools: allowed ? inherited.filter((name) => allowed.has(name)) : inherited,
		writePolicy: input.agentType === "explorer" || input.agentType === "reviewer" ? "deny" : "inherit",
		mayDelegate: (input.agentType === "default" || input.agentType === "worker") && input.depth < input.maxDepth,
	};
}
