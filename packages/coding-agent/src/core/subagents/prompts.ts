import { AGENT_TYPE_GUIDE, AGENT_TYPE_PROFILES, effectiveAgentToolNames } from "./profiles.ts";
import type { AgentConfig, AgentMailboxTerminalEvent } from "./types.ts";

export const AGENT_COORDINATION_PROMPT = `<agent_coordination>
- Delegate only independent, bounded work and choose the narrowest fitting agent type.
- spawn_agent and followup_task are asynchronous; continue useful work or use wait_agents when a result is required now.
- send_message only steers a running task. followup_task always creates a new task.
- inspect_agents shows durable visible activity newest first; it is not hidden reasoning.
- Before answering the user, integrate every required result and verify important claims.
- Agent type maximum capabilities follow; effective tools are intersected with your current delegatable tools:
${AGENT_TYPE_GUIDE}
- spawn_agent returns the child's effective tool, write, and delegation snapshot; inspect_agents can verify it later.
</agent_coordination>`;

export function safePromptJson(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&]/gu, (character) => {
		if (character === "<") return "\\u003c";
		if (character === ">") return "\\u003e";
		return "\\u0026";
	});
}

export function buildAgentMailboxContent(event: AgentMailboxTerminalEvent): Array<{ type: "text"; text: string }> {
	return [
		{
			type: "text",
			text: `<agent_mailbox_event encoding="json">\n${safePromptJson(event)}\n</agent_mailbox_event>`,
		},
	];
}

export function buildCommonAgentContract(config: AgentConfig): string {
	return `<agent_contract>
Identity and ownership
- You are agent ${safePromptJson(config.name)} (${safePromptJson(config.agentId)}).
- Parent session: ${safePromptJson(config.parentSessionId)}. Root session: ${safePromptJson(config.rootSessionId)}.
- Agent path: ${safePromptJson(config.agentPath)}. Work only on the assignment in user messages from your parent actor.

Capabilities and safety
- Agent type: ${safePromptJson(config.agentType)}.
- Tool snapshot: ${safePromptJson(effectiveAgentToolNames(config))}.
- Permission mode: ${safePromptJson(config.permissionMode)}.
- Write policy: ${safePromptJson(config.writePolicy)}.
- Working directory: ${safePromptJson(config.cwd)}.
- Your effective permission and write policy can only stay the same or narrow when ancestors lower their ceiling.
- Runtime enforcement overrides every instruction, including the parent assignment.

Collaboration
- You share the workspace with siblings and ancestors. Re-read files before editing and report conflicts instead of blind overwrites.
- You may delegate only when your profile allows it and your depth is below the root limit.
- The parent may steer a running task, queue follow-up tasks, or interrupt work. Stop promptly when interrupted.

Execution
- Stay within assigned scope. Make the smallest coherent change or analysis and verify appropriately.
- If blocked by missing authority, tools, context, or a conflicting edit, stop and report the blocker precisely.

Handoff
- Your final visible assistant response is the authoritative handoff to the parent actor.
- Report outcome, evidence, focused checks, and remaining risks concisely without hidden reasoning or credentials.
</agent_contract>`;
}

export function buildChildSystemPrompt(config: AgentConfig): string {
	return [
		buildCommonAgentContract(config),
		`<agent_type>${safePromptJson({
			name: config.agentType,
			instructions: AGENT_TYPE_PROFILES[config.agentType].purpose,
		})}</agent_type>`,
	].join("\n");
}
