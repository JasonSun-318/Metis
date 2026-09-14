import type { ThinkingLevel } from "@metis/agent-core";
import { getProviders, getSupportedThinkingLevels, type Model } from "@metis/ai/compat";
import type { AgentMode } from "./agent-mode.ts";

export type ThinkingSelection = ThinkingLevel | "ultra";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

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

export function getLowestSupportedThinkingLevel(model: Model<any> | undefined): ThinkingLevel {
	if (!model) return "off";
	return (getSupportedThinkingLevels(model) as ThinkingLevel[])[0] ?? "off";
}

export function canUseUltra(input: {
	readonly hostAllowsUltra: boolean;
	readonly persisted: boolean;
	readonly mode: AgentMode;
	readonly isAgent: boolean;
	readonly model: Model<any> | undefined;
}): boolean {
	return (
		input.hostAllowsUltra &&
		input.persisted &&
		input.mode === "code" &&
		!input.isAgent &&
		(input.model === undefined || BUILT_IN_MODEL_PROVIDERS.has(input.model.provider))
	);
}
