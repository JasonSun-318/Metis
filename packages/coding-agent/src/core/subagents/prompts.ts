import type { SubagentConfig } from "./types.ts";

export const SUBAGENT_COORDINATION_PROMPT = `<subagent_coordination>
You may delegate independent, bounded work with spawn_agent. Keep ownership of the overall answer, inspect results before relying on them, use wait_agents instead of polling, and close children only when their recoverable history is no longer needed. Children cannot create other children or communicate with siblings. Leaving Ultra disables new work and messaging but keeps observation, interruption, waiting, and close available until every child is closed.
</subagent_coordination>`;

export function buildChildSystemPrompt(config: SubagentConfig): string {
	const additions = [
		"<subagent_profile>",
		`You are the child agent named ${JSON.stringify(config.name)}. Complete the assigned task independently and return a concise, authoritative final response to the parent agent.`,
		"You cannot create subagents or communicate with sibling agents. Do not claim that you can. Your final assistant response is the handoff; do not launch a separate summarization step.",
		config.role ? `Role: ${config.role}` : undefined,
		config.developerInstructions ? `Additional developer instructions:\n${config.developerInstructions}` : undefined,
		"</subagent_profile>",
	].filter((part): part is string => part !== undefined);
	return additions.join("\n");
}
