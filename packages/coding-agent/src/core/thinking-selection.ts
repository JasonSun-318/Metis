import type { ThinkingLevel } from "@metis/agent-core";
import { getSupportedThinkingLevels, type Model } from "@metis/ai/compat";
import type { AgentMode } from "./agent-mode.ts";

export type ThinkingSelection = ThinkingLevel | "ultra";

export function isThinkingSelection(value: unknown): value is ThinkingSelection {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max" ||
		value === "ultra"
	);
}

export function getHighestSupportedThinkingLevel(model: Model<any> | undefined): ThinkingLevel {
	if (!model) return "off";
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return levels.at(-1) ?? "off";
}

export function canUseUltra(input: {
	readonly hostAllowsUltra: boolean;
	readonly persisted: boolean;
	readonly mode: AgentMode;
	readonly isSubagent: boolean;
}): boolean {
	return input.hostAllowsUltra && input.persisted && input.mode === "code" && !input.isSubagent;
}
