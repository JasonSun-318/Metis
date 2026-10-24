import type { SessionSnapshot } from "@metis/app-protocol";
import type { AgentSummary } from "@metis/coding-agent/host";

export function agentTaskView(
	task: NonNullable<AgentSummary["currentTask"]>,
	includeResult = true,
): NonNullable<SessionSnapshot["agents"][number]["currentTask"]> {
	return {
		taskId: task.taskId,
		...(task.instructionRevision === undefined ? {} : { instructionRevision: task.instructionRevision }),
		...(task.consumedInstructionRevision === undefined
			? {}
			: { consumedInstructionRevision: task.consumedInstructionRevision }),
		status: task.status,
		taskSummary: task.taskSummary,
		...(includeResult && task.finalMessage ? { finalMessage: task.finalMessage } : {}),
		...(includeResult && task.error ? { error: task.error } : {}),
		...(task.usage ? { usage: { ...task.usage, model: { ...task.usage.model } } } : {}),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}

export function agentSummaryView(summary: AgentSummary): SessionSnapshot["agents"][number] {
	return {
		agentId: summary.agentId,
		...(summary.retry ? { retry: { ...summary.retry } } : {}),
		...(summary.mode ? { mode: summary.mode } : {}),
		...(summary.model ? { model: summary.model } : {}),
		tools: [...summary.tools],
		writePolicy: summary.writePolicy,
		mayDelegate: summary.mayDelegate,
		...(summary.roleSnapshot ? { roleRevision: summary.roleSnapshot.revision } : {}),
		...(summary.runControl ? { runControl: summary.runControl.state } : {}),
		name: summary.name,
		agentType: summary.agentType,
		depth: summary.depth,
		status: summary.status,
		archived: summary.archived,
		parentSessionId: summary.parentSessionId,
		rootSessionId: summary.rootSessionId,
		agentPath: [...summary.agentPath],
		tasks: summary.tasks.map((task) => agentTaskView(task, false)),
		...(summary.currentTask ? { currentTask: agentTaskView(summary.currentTask) } : {}),
		...(summary.latestTask ? { latestTask: agentTaskView(summary.latestTask) } : {}),
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
	};
}

const MAX_AGENT_COLLECTION_UTF8_BYTES = 1024 * 1024;

export function boundedAgentSummaryViews(
	summaries: readonly AgentSummary[],
	limit: number,
): SessionSnapshot["agents"][number][] {
	const views: SessionSnapshot["agents"][number][] = [];
	let bytes = 2;
	for (const summary of summaries) {
		if (views.length >= limit) break;
		const view = agentSummaryView(summary);
		const viewBytes = Buffer.byteLength(JSON.stringify(view), "utf8") + (views.length > 0 ? 1 : 0);
		if (views.length > 0 && bytes + viewBytes > MAX_AGENT_COLLECTION_UTF8_BYTES) break;
		views.push(view);
		bytes += viewBytes;
	}
	return views;
}
