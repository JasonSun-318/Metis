import { AGENT_TOOL_NAMES, AGENT_TYPES, type AgentType } from "./types.ts";

interface AgentTypeProfile {
	readonly purpose: string;
	readonly allowedTools?: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

export const AGENT_TYPE_PROFILES = {
	default: {
		purpose: "General analysis and execution; use when no narrower type fits.",
		writePolicy: "inherit",
		mayDelegate: true,
	},
	explorer: {
		purpose: "Read and search only; returns focused findings without changing files.",
		allowedTools: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
		writePolicy: "deny",
		mayDelegate: false,
	},
	worker: {
		purpose: "Implements changes and runs focused verification.",
		writePolicy: "inherit",
		mayDelegate: true,
	},
	reviewer: {
		purpose: "Reviews code and runs non-mutating checks; filesystem writes are denied.",
		allowedTools: ["read", "grep", "find", "ls", "bash"],
		writePolicy: "deny",
		mayDelegate: false,
	},
} as const satisfies Readonly<Record<AgentType, AgentTypeProfile>>;

export const AGENT_TYPE_GUIDE = AGENT_TYPES.map((agentType) => {
	const profile = AGENT_TYPE_PROFILES[agentType];
	const tools =
		"allowedTools" in profile
			? `parent intersection [${profile.allowedTools.join(", ")}]`
			: "all parent delegatable tools";
	const effectiveTools = profile.mayDelegate
		? `${tools} plus [${AGENT_TOOL_NAMES.join(", ")}] when delegation is allowed`
		: tools;
	const writes = profile.writePolicy === "deny" ? "denied" : "inherited";
	const delegation = profile.mayDelegate ? "allowed below depth limit" : "denied";
	return `${agentType}: tools=${effectiveTools}; filesystem writes=${writes}; delegation=${delegation}; purpose=${profile.purpose}`;
}).join("\n");

const RESERVED_TOOLS = new Set<string>([
	...AGENT_TOOL_NAMES,
	"ask_user",
	"deliver_file",
	"set_tasks",
	"get_goal",
	"create_goal",
	"update_goal",
]);

export interface ResolvedAgentProfile {
	readonly agentType: AgentType;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

export const MAX_AGENT_DEPTH = 2;

export function effectiveAgentToolNames(input: {
	readonly tools: readonly string[];
	readonly mayDelegate: boolean;
}): readonly string[] {
	return input.mayDelegate ? [...input.tools, ...AGENT_TOOL_NAMES] : input.tools;
}

export function resolveAgentProfile(input: {
	readonly agentType: AgentType;
	readonly parentTools: readonly string[];
	readonly depth: number;
}): ResolvedAgentProfile {
	const inherited = input.parentTools.filter((name) => !RESERVED_TOOLS.has(name));
	const definition = AGENT_TYPE_PROFILES[input.agentType];
	const allowed = "allowedTools" in definition ? new Set<string>(definition.allowedTools) : undefined;
	return {
		agentType: input.agentType,
		tools: allowed ? inherited.filter((name) => allowed.has(name)) : inherited,
		writePolicy: definition.writePolicy,
		mayDelegate: definition.mayDelegate && input.depth < MAX_AGENT_DEPTH,
	};
}
