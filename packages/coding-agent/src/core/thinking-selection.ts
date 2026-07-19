import type { ThinkingLevel } from "@arcmind/agent-core";
import { getSupportedThinkingLevels, type Model } from "@arcmind/ai/compat";

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
