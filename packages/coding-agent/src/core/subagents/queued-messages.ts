import { createHash } from "node:crypto";
import type { AgentInputEntry } from "../session-control.ts";
import type { AgentQueuedMessage, AgentRunControl, AgentTaskSummary } from "./types.ts";

export interface AgentQueueProjection {
	readonly inputs: readonly AgentInputEntry[];
	readonly tasks: readonly AgentTaskSummary[];
	readonly runControl?: AgentRunControl;
	readonly archived?: boolean;
}

/** A failed admission leaves its runtime request indexed; a revised draft gets a fresh identity. */
export function queuedAdmissionRequestId(messageId: string, revision: string): string {
	return `guide-${createHash("sha256").update(`${messageId}\n${revision}`).digest("hex")}`;
}

export function queuedAgentMessages(
	record: Pick<AgentQueueProjection, "inputs" | "tasks" | "runControl" | "archived">,
): readonly AgentQueuedMessage[] {
	const projection = record;
	if (projection.archived) return [];
	const taskOrder = new Map(projection.tasks.map((task, index) => [task.taskId, index]));
	const tasks = new Map(projection.tasks.map((task) => [task.taskId, task]));
	return projection.inputs
		.flatMap((input) => {
			if (input.origin.kind !== "user" || input.state !== "queued") return [];
			const task = tasks.get(input.taskId);
			if (!task || (task.status !== "queued" && task.status !== "stopped")) return [];
			const state =
				task.status === "queued" && (!projection.runControl || projection.runControl.state === "enabled")
					? "queued"
					: "paused";
			return [
				{
					messageId: input.messageId,
					revision: input.id,
					state,
					input: structuredClone(input.input),
				} satisfies AgentQueuedMessage,
			];
		})
		.sort((left, right) => {
			const leftInput = projection.inputs.find((input) => input.messageId === left.messageId)!;
			const rightInput = projection.inputs.find((input) => input.messageId === right.messageId)!;
			const order =
				(taskOrder.get(leftInput.taskId) ?? Number.MAX_SAFE_INTEGER) -
				(taskOrder.get(rightInput.taskId) ?? Number.MAX_SAFE_INTEGER);
			if (order !== 0) return order;
			const revision = leftInput.instructionRevision - rightInput.instructionRevision;
			return revision !== 0 ? revision : leftInput.id.localeCompare(rightInput.id);
		});
}

/** Restored human drafts occupy capacity even while their old tasks are stopped. */
export function queuedAgentTaskCount(records: readonly AgentQueueProjection[]): number {
	return records.reduce((count, record) => {
		const stopped = new Set(record.tasks.filter((task) => task.status === "stopped").map((task) => task.taskId));
		return (
			count +
			record.tasks.filter((task) => task.status === "queued").length +
			record.inputs.filter(
				(input) => input.origin.kind === "user" && input.state === "queued" && stopped.has(input.taskId),
			).length
		);
	}, 0);
}

export function isManageableQueuedMessage(input: AgentInputEntry, task?: AgentTaskSummary): boolean {
	return (
		input.origin.kind === "user" &&
		input.state === "queued" &&
		(task?.status === "queued" || task?.status === "stopped")
	);
}
