import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	flushGoalElapsed,
	isTerminalGoalStatus,
	readThreadGoal,
	type ThreadGoal,
	validateGoalObjective,
	writeThreadGoal,
} from "./store.ts";

export const GetGoalParams = Type.Object({}, { additionalProperties: false });
export const CreateGoalParams = Type.Object(
	{
		objective: Type.String({ minLength: 1, maxLength: 4000 }),
	},
	{ additionalProperties: false },
);
export const UpdateGoalParams = Type.Object(
	{
		status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
	},
	{ additionalProperties: false },
);

export type GetGoalInput = Static<typeof GetGoalParams>;
export type CreateGoalInput = Static<typeof CreateGoalParams>;
export type UpdateGoalInput = Static<typeof UpdateGoalParams>;

export interface GoalToolDetails {
	readonly goal: ThreadGoal | null;
	readonly ok: boolean;
}

export interface GoalToolOptions {
	readonly getSession: () => SessionManager;
	readonly onChange?: (goal: ThreadGoal | null) => void;
}

function unavailableGoalOptions(): GoalToolOptions {
	return {
		getSession: () => {
			throw new Error("Goal tools require a session");
		},
	};
}

export function resolveGoalToolOptions(options?: GoalToolOptions): GoalToolOptions {
	return options ?? unavailableGoalOptions();
}

function goalPayload(goal: ThreadGoal | null): string {
	return JSON.stringify(
		{
			goal: goal
				? {
						goalId: goal.goalId,
						objective: goal.objective,
						status: goal.status,
						timeUsedSeconds: goal.timeUsedSeconds,
					}
				: null,
		},
		null,
		2,
	);
}

function currentGoalForAccounting(getSession: () => SessionManager): ThreadGoal | null {
	const session = getSession();
	const goal = readThreadGoal(session);
	if (!goal || goal.status !== "active") return goal;
	return flushGoalElapsed(session, goal);
}

export function createGetGoalToolDefinition(
	options?: GoalToolOptions,
): ToolDefinition<typeof GetGoalParams, GoalToolDetails> {
	const resolved = resolveGoalToolOptions(options);
	return {
		name: "get_goal",
		label: "Get goal",
		description: "Get the current goal for this thread, including status and elapsed-time usage.",
		promptSnippet: "Read the current session goal",
		parameters: GetGoalParams,
		executionMode: "parallel",
		async execute() {
			const goal = currentGoalForAccounting(resolved.getSession);
			return {
				content: [{ type: "text", text: goalPayload(goal) }],
				details: { goal, ok: true },
			};
		},
	};
}

export function createCreateGoalToolDefinition(
	options?: GoalToolOptions,
): ToolDefinition<typeof CreateGoalParams, GoalToolDetails> {
	const resolved = resolveGoalToolOptions(options);
	return {
		name: "create_goal",
		label: "Create goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if an unfinished goal exists; use update_goal only for status.",
		promptSnippet: "Create a session goal when explicitly requested",
		parameters: CreateGoalParams,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			const session = resolved.getSession();
			const objective = validateGoalObjective(input.objective);
			const existing = currentGoalForAccounting(resolved.getSession);
			if (existing && !isTerminalGoalStatus(existing.status)) {
				throw new Error(
					"cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
				);
			}
			const goal = writeThreadGoal(session, {
				objective,
				status: "active",
				goalId: crypto.randomUUID(),
			});
			resolved.onChange?.(goal);
			return {
				content: [{ type: "text", text: goalPayload(goal) }],
				details: { goal, ok: true },
			};
		},
	};
}

export function createUpdateGoalToolDefinition(
	options?: GoalToolOptions,
): ToolDefinition<typeof UpdateGoalParams, GoalToolDetails> {
	const resolved = resolveGoalToolOptions(options);
	return {
		name: "update_goal",
		label: "Update goal",
		description: `Update the existing goal.
Use this tool only to mark the goal achieved or genuinely blocked.
Set status to complete only when the objective has actually been achieved and no required work remains.
Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked blocked, treat the resumed run as a fresh blocked audit.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to blocked.
Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because you are stopping work.
You cannot use this tool to pause, resume, or usage-limit a goal; those status changes are controlled by the user or system.`,
		promptSnippet: "Mark the session goal complete or blocked",
		parameters: UpdateGoalParams,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			if (input.status !== "complete" && input.status !== "blocked") {
				throw new Error(
					"update_goal can only mark the existing goal complete or blocked; pause, resume, and usage-limited status changes are controlled by the user or system",
				);
			}
			const session = resolved.getSession();
			const existing = currentGoalForAccounting(resolved.getSession);
			if (!existing) {
				throw new Error("cannot update goal because this thread has no goal");
			}
			const goal = writeThreadGoal(session, {
				...existing,
				status: input.status,
			});
			resolved.onChange?.(goal);
			return {
				content: [{ type: "text", text: goalPayload(goal) }],
				details: { goal, ok: true },
			};
		},
	};
}
