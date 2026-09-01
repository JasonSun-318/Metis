import type { AgentTool } from "@metis/agent-core";
import type { ToolDefinition, ToolPermissionDescriptor } from "../../src/core/extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "../../src/core/tool-permission-adapter.ts";

export function noEffectTestPermission<TParams = unknown>(): ToolPermissionDescriptor<TParams> {
	return permissionDescriptor(() => permissionClaim());
}

/** Adapt a low-level AgentTool for tests that are unrelated to permission semantics. */
export function testToolDefinition(tool: AgentTool): ToolDefinition {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		permission: noEffectTestPermission(),
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}

export function testToolDefinitions(tools: readonly AgentTool[]): ToolDefinition[] {
	return tools.map(testToolDefinition);
}
