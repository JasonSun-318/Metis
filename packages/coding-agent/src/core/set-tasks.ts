import { Text } from "@metis/tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../presentation/theme.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "./tool-permission-adapter.ts";
import { getTextOutput } from "./tools/render-utils.ts";

export interface TaskItem {
	task: string;
	completed: boolean;
}

export interface SetTasksDetails {
	tasks: TaskItem[];
}

export const SetTasksParams = Type.Object(
	{
		tasks: Type.Array(
			Type.Object(
				{
					task: Type.String({ minLength: 1, maxLength: 512 }),
					completed: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 256 },
		),
	},
	{ additionalProperties: false },
);

export type SetTasksInput = Static<typeof SetTasksParams>;

function normalizeTasks(input: SetTasksInput): SetTasksDetails {
	if (input.tasks.length === 0) throw new TypeError("At least one task is required");
	const tasks = input.tasks.map(({ task, completed }) => ({ task: task.trim(), completed }));
	if (tasks.some(({ task }) => task.length === 0)) throw new TypeError("Tasks cannot be empty");
	return { tasks };
}

function formatTaskResult({ tasks }: SetTasksDetails): string {
	const lines = [
		"<task_list>",
		...tasks.map(({ task, completed }) => `- [${completed ? "x" : " "}] ${task}`),
		"</task_list>",
	];
	if (tasks.every((task) => task.completed)) {
		lines.push("All tasks are complete. No close call is needed.");
	}
	return lines.join("\n");
}

function formatTasksForTui(input: Partial<SetTasksInput> | undefined, theme: Theme): string {
	const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
	const completed = tasks.filter((task) => task.completed).length;
	const lines = [theme.fg("toolTitle", theme.bold(`Tasks · ${completed}/${tasks.length}`))];
	for (const task of tasks) {
		lines.push(
			task.completed
				? `${theme.fg("success", "[✓]")} ${theme.fg("muted", task.task.trim())}`
				: `${theme.fg("accent", "[→]")} ${theme.fg("text", task.task.trim())}`,
		);
	}
	return lines.join("\n");
}

export function createSetTasksToolDefinition(): ToolDefinition<typeof SetTasksParams, SetTasksDetails> {
	return {
		name: "set_tasks",
		label: "Tasks",
		description:
			"Send the complete visible task list for multi-step work; skip simple tasks. Each call replaces the previous list. Keep completed=false until finished; multiple tasks may remain false. Call only on meaningful changes. When all tasks are completed, tracking ends automatically; no close call is needed.",
		promptSnippet: "Set the visible task list",
		parameters: SetTasksParams,
		permission: permissionDescriptor(() => permissionClaim()),
		executionMode: "sequential",
		renderShell: "self",
		async execute(_toolCallId, input) {
			const details = normalizeTasks(input);
			return { content: [{ type: "text", text: formatTaskResult(details) }], details };
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 1, 1);
			const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
			const allCompleted = tasks.length > 0 && tasks.every((task) => task.completed);
			text.setCustomBgFn(
				context.isError ? undefined : (line) => theme.bg(allCompleted ? "toolSuccessBg" : "toolPendingBg", line),
			);
			text.setText(context.isError ? "" : formatTasksForTui(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 1, 1);
			text.setCustomBgFn(context.isError ? (line) => theme.bg("toolErrorBg", line) : undefined);
			text.setText(context.isError ? theme.fg("error", getTextOutput(result, context.showImages)) : "");
			return text;
		},
	};
}
