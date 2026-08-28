import { AGENT_TOOL_NAMES } from "./types.ts";

export interface AgentTypeProfile {
	readonly purpose: string;
	readonly allowedTools?: readonly string[];
	readonly systemPrompt?: string;
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
} as const satisfies Readonly<Record<string, AgentTypeProfile>>;

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

export function buildAgentTypeGuide(definitions: Readonly<Record<string, AgentTypeProfile>>): string {
	return Object.entries(definitions)
		.map(([agentType, profile]) => {
			const tools = profile.allowedTools
				? `parent intersection [${profile.allowedTools.join(", ")}]`
				: "all parent delegatable tools";
			const effectiveTools = profile.mayDelegate
				? `${tools} plus [${AGENT_TOOL_NAMES.join(", ")}] when delegation is allowed`
				: tools;
			const writes = profile.writePolicy === "deny" ? "denied" : "inherited";
			const delegation = profile.mayDelegate ? "allowed below depth limit" : "denied";
			return `${agentType}: tools=${effectiveTools}; filesystem writes=${writes}; delegation=${delegation}; purpose=${profile.purpose}`;
		})
		.join("\n");
}

export function resolveAgentProfile(input: {
	readonly definition: AgentTypeProfile;
	readonly parentTools: readonly string[];
	readonly depth: number;
}): ResolvedAgentProfile {
	const inherited = input.parentTools.filter((name) => !RESERVED_TOOLS.has(name));
	const allowed = input.definition.allowedTools ? new Set<string>(input.definition.allowedTools) : undefined;
	return {
		tools: allowed ? inherited.filter((name) => allowed.has(name)) : inherited,
		writePolicy: input.definition.writePolicy,
		mayDelegate: input.definition.mayDelegate && input.depth < MAX_AGENT_DEPTH,
	};
}
