export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createDescribeImageTool,
	createDescribeImageToolDefinition,
	type DescribeImageToolDetails,
	type DescribeImageToolInput,
	type DescribeImageToolOptions,
} from "./describe-image.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export type {
	ToolSubprocessExecutor,
	ToolSubprocessInput,
	WrappedToolSubprocess,
} from "./subprocess.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWebFetchTool,
	createWebFetchToolDefinition,
	type WebFetchToolDetails,
	type WebFetchToolInput,
} from "./web-fetch.ts";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type ImageResult,
	type WebResult,
	type WebSearchResponse,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@metis/agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	createCreateGoalToolDefinition,
	createGetGoalToolDefinition,
	createUpdateGoalToolDefinition,
	type GoalToolOptions,
} from "../goal/tools.ts";
import { createSetTasksToolDefinition } from "../set-tasks.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import {
	createDescribeImageTool,
	createDescribeImageToolDefinition,
	type DescribeImageToolOptions,
} from "./describe-image.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWebFetchTool, createWebFetchToolDefinition } from "./web-fetch.ts";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "web_fetch"
	| "web_search"
	| "set_tasks"
	| "get_goal"
	| "create_goal"
	| "update_goal"
	| "describe_image";
export const GOAL_TOOL_NAMES = ["get_goal", "create_goal", "update_goal"] as const;
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"web_fetch",
	"web_search",
	"set_tasks",
	"get_goal",
	"create_goal",
	"update_goal",
	"describe_image",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	webSearch?: WebSearchToolOptions;
	describeImage?: DescribeImageToolOptions;
	goal?: GoalToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "web_fetch":
			return createWebFetchToolDefinition();
		case "web_search":
			return createWebSearchToolDefinition(options?.webSearch);
		case "set_tasks":
			return createSetTasksToolDefinition();
		case "get_goal":
			return createGetGoalToolDefinition(options?.goal);
		case "create_goal":
			return createCreateGoalToolDefinition(options?.goal);
		case "update_goal":
			return createUpdateGoalToolDefinition(options?.goal);
		case "describe_image":
			return createDescribeImageToolDefinition(cwd, options?.describeImage);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "web_fetch":
			return createWebFetchTool();
		case "web_search":
			return createWebSearchTool(options?.webSearch);
		case "set_tasks":
			return wrapToolDefinition(createSetTasksToolDefinition());
		case "get_goal":
			return wrapToolDefinition(createGetGoalToolDefinition(options?.goal));
		case "create_goal":
			return wrapToolDefinition(createCreateGoalToolDefinition(options?.goal));
		case "update_goal":
			return wrapToolDefinition(createUpdateGoalToolDefinition(options?.goal));
		case "describe_image":
			return createDescribeImageTool(cwd, options?.describeImage);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		web_fetch: createWebFetchToolDefinition(),
		web_search: createWebSearchToolDefinition(options?.webSearch),
		set_tasks: createSetTasksToolDefinition(),
		get_goal: createGetGoalToolDefinition(options?.goal),
		create_goal: createCreateGoalToolDefinition(options?.goal),
		update_goal: createUpdateGoalToolDefinition(options?.goal),
		describe_image: createDescribeImageToolDefinition(cwd, options?.describeImage),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		web_fetch: createWebFetchTool(),
		web_search: createWebSearchTool(options?.webSearch),
		set_tasks: wrapToolDefinition(createSetTasksToolDefinition()),
		get_goal: wrapToolDefinition(createGetGoalToolDefinition(options?.goal)),
		create_goal: wrapToolDefinition(createCreateGoalToolDefinition(options?.goal)),
		update_goal: wrapToolDefinition(createUpdateGoalToolDefinition(options?.goal)),
		describe_image: createDescribeImageTool(cwd, options?.describeImage),
	};
}
