import type { Api, ModelThinkingLevel, ThinkingLevelMap } from "@metis/ai";

export type CustomModelReasoningMode = "auto" | "off" | "generic";
export type CustomModelReasoningSource = "catalog" | "generic" | "off" | "unrecognized";

export interface ResolvedCustomModelReasoning {
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
	readonly source: CustomModelReasoningSource;
}

/** Narrow catalog view: only the fields needed to resolve custom-model reasoning. */
export interface CatalogReasoningModel {
	readonly id: string;
	readonly api: Api;
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
}

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function sameCapabilities(left: CatalogReasoningModel, right: CatalogReasoningModel): boolean {
	return (
		left.reasoning === right.reasoning &&
		LEVELS.every((level) => left.thinkingLevelMap?.[level] === right.thinkingLevelMap?.[level])
	);
}

/**
 * Resolve reasoning capabilities for a custom (models.json) model.
 *
 * - `auto` inherits capabilities only when the exact case-sensitive model id AND
 *   api protocol match catalog entries that all share one capability signature.
 *   Otherwise the model is unrecognized and reasoning stays off.
 * - `off` never reasons.
 * - `generic` enables reasoning with the conservative low/medium/high surface
 *   (minimal is mapped out; xhigh/max require explicit catalog mappings).
 */
export function resolveCustomModelReasoning(input: {
	readonly mode: CustomModelReasoningMode;
	readonly modelId: string;
	readonly api: Api;
	readonly catalog: readonly CatalogReasoningModel[];
}): ResolvedCustomModelReasoning {
	if (input.mode === "off") return { reasoning: false, source: "off" };
	if (input.mode === "generic") {
		return { reasoning: true, thinkingLevelMap: { minimal: null }, source: "generic" };
	}
	const matches = input.catalog.filter((model) => model.id === input.modelId && model.api === input.api);
	if (matches.length === 0) return { reasoning: false, source: "unrecognized" };
	const first = matches[0];
	if (!matches.every((match) => sameCapabilities(match, first))) {
		return { reasoning: false, source: "unrecognized" };
	}
	return {
		reasoning: first.reasoning,
		...(first.thinkingLevelMap ? { thinkingLevelMap: { ...first.thinkingLevelMap } } : {}),
		source: "catalog",
	};
}
