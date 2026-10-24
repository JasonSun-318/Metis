import { AGENT_TOOL_NAMES } from "./types.ts";

export interface AgentTypeProfile {
	readonly displayName?: string;
	readonly revision?: string;
	readonly purpose: string;
	readonly allowedTools?: readonly string[];
	readonly systemPrompt?: string;
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

export const AGENT_TYPE_PROFILES = {
	default: {
		displayName: "General assistant",
		purpose: "General analysis and execution; use when no narrower type fits.",
		systemPrompt:
			"Complete the bounded assignment using the available evidence and tools. Clarify uncertainties, verify consequential claims, and provide a concise handoff. Choose this general role only when no narrower role fits.",
		writePolicy: "inherit",
		mayDelegate: true,
	},
	explorer: {
		displayName: "Explorer",
		purpose: "Read and search only; returns focused findings without changing files.",
		systemPrompt:
			"Investigate the assigned question through reading and search. Return relevant sources, concrete findings, and remaining unknowns. Distinguish direct evidence from inference; do not modify files or implement changes.",
		allowedTools: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
		writePolicy: "deny",
		mayDelegate: false,
	},
	worker: {
		displayName: "Worker",
		purpose: "Produces the assigned outcome and performs focused verification.",
		systemPrompt:
			"Produce the assigned outcome, whether analysis, an artifact, or an implementation. Use the smallest coherent approach within your permissions, verify the result with appropriate evidence, and report what changed and what remains incomplete.",
		writePolicy: "inherit",
		mayDelegate: true,
	},
	reviewer: {
		displayName: "Reviewer",
		purpose: "Reviews evidence, artifacts, or code using non-mutating checks; filesystem writes are denied.",
		systemPrompt:
			"Review the assigned evidence, artifact, or implementation independently. Prioritize actionable issues by impact, provide reproducible evidence, and identify uncertainty and coverage limits. Do not modify the reviewed material or run mutating checks.",
		allowedTools: ["read", "grep", "find", "ls", "bash"],
		writePolicy: "deny",
		mayDelegate: false,
	},
} as const satisfies Readonly<Record<string, AgentTypeProfile>>;

const RESERVED_TOOLS = new Set<string>([...AGENT_TOOL_NAMES, "set_tasks", "get_goal", "create_goal", "update_goal"]);

export interface ResolvedAgentProfile {
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

export const MAX_AGENT_DEPTH = 2;

export interface AgentGuideCapabilities {
	readonly parentTools: readonly string[];
	/** Depth of the child that would be created, not the current actor. */
	readonly depth: number;
	readonly writePolicy?: "inherit" | "deny";
	readonly mode?: "chat" | "code";
}

export function effectiveAgentToolNames(input: {
	readonly tools: readonly string[];
	readonly mayDelegate: boolean;
}): readonly string[] {
	return input.mayDelegate ? [...input.tools, ...AGENT_TOOL_NAMES] : input.tools;
}

export function buildAgentTypeGuide(
	definitions: Readonly<Record<string, AgentTypeProfile>>,
	capabilities?: AgentGuideCapabilities,
): string {
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
			const identity = `name=${JSON.stringify(profile.displayName ?? agentType)}; revision=${profile.revision ?? "unversioned"}; purpose=${JSON.stringify(profile.purpose)}`;
			if (!capabilities)
				return `${agentType}: tools=${effectiveTools}; filesystem writes=${writes}; delegation=${delegation}; ${identity}`;
			const resolved = resolveAgentProfile({
				definition: profile,
				parentTools: capabilities.parentTools,
				depth: capabilities.depth,
			});
			const unavailableTools = profile.allowedTools?.filter((tool) => !resolved.tools.includes(tool)) ?? [];
			const currentWrites =
				profile.writePolicy === "deny" || capabilities.writePolicy === "deny" ? "denied" : "inherited";
			const currentDelegation = resolved.mayDelegate
				? "allowed"
				: profile.mayDelegate
					? "denied (depth limit)"
					: "denied (role)";
			const availability = capabilities.depth > MAX_AGENT_DEPTH ? "unavailable (depth limit)" : "available";
			return `${agentType}: ${availability}; mode=${capabilities.mode ?? "inherited"}; maximum tools=${tools}; effective tools=${JSON.stringify(effectiveAgentToolNames(resolved))}; unavailable tools=${JSON.stringify(unavailableTools)} (current parent capabilities and delegatable-tool rules); filesystem writes=${currentWrites}; delegation=${currentDelegation}; ${identity}`;
		})
		.join("\n")
		.replace(/[<>&]/gu, (character) => (character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026"));
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
