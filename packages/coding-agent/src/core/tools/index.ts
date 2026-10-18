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
import { type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { createDescribeImageToolDefinition, type DescribeImageToolOptions } from "./describe-image.ts";
import { createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWebFetchToolDefinition } from "./web-fetch.ts";
import { createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
type ToolDef = ToolDefinition<any, any>;
const toolNames = [
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
] as const;
export type ToolName = (typeof toolNames)[number];
const GOAL_TOOL_NAMES = ["get_goal", "create_goal", "update_goal"] as const;

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

function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
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
	return wrapToolDefinition(createToolDefinition(toolName, cwd, options));
}

function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return Object.fromEntries(toolNames.map((name) => [name, createToolDefinition(name, cwd, options)])) as Record<
		ToolName,
		ToolDef
	>;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return createCodingToolDefinitions(cwd, options).map((definition) => wrapToolDefinition(definition));
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return createReadOnlyToolDefinitions(cwd, options).map((definition) => wrapToolDefinition(definition));
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return Object.fromEntries(toolNames.map((name) => [name, createTool(name, cwd, options)])) as Record<ToolName, Tool>;
}

export function getDefaultToolNames(options: {
	visionEnabled: boolean;
	webSearchEnabled: boolean;
	isSubagent: boolean;
}): ToolName[] {
	return [
		"read",
		"grep",
		"bash",
		"edit",
		"write",
		"web_fetch",
		...(options.visionEnabled ? (["describe_image"] as const) : []),
		...(options.webSearchEnabled ? (["web_search"] as const) : []),
		...(options.isSubagent ? [] : (["set_tasks", ...GOAL_TOOL_NAMES] as const)),
	];
}
