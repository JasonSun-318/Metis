import type { Api, ModelThinkingLevel, ThinkingLevelMap } from "@metis/ai";

export type CustomModelReasoningMode = "auto" | "off" | "generic" | "manual";
export type CustomModelReasoningSource = "catalog" | "generic" | "off" | "manual" | "unrecognized";

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

function normalizeLevelValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Normalize a user-authored manual map to the complete seven-level shape.
 * Missing values, nulls, and blank strings are explicitly unsupported (`null`)
 * so `getSupportedThinkingLevels` never invents implicit off/minimal/low/etc.
 */
export function normalizeManualThinkingLevelMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap {
	const normalized: ThinkingLevelMap = {};
	for (const level of LEVELS) normalized[level] = normalizeLevelValue(map?.[level]);
	return normalized;
}

/** True when a manual map contains at least one explicit provider value. */
export function hasConfiguredManualThinkingLevel(map: ThinkingLevelMap | undefined): boolean {
	return LEVELS.some((level) => normalizeLevelValue(map?.[level]) !== null);
}

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
 * - `manual` uses only user-provided level values. Unconfigured levels become
 *   explicit `null`s so no protocol or catalog default can be inferred.
 */
export function resolveCustomModelReasoning(input: {
	readonly mode: CustomModelReasoningMode;
	readonly modelId: string;
	readonly api: Api;
	readonly catalog: readonly CatalogReasoningModel[];
	readonly thinkingLevelMap?: ThinkingLevelMap;
}): ResolvedCustomModelReasoning {
	if (input.mode === "off") return { reasoning: false, source: "off" };
	if (input.mode === "generic") {
		return { reasoning: true, thinkingLevelMap: { minimal: null }, source: "generic" };
	}
	if (input.mode === "manual") {
		if (!hasConfiguredManualThinkingLevel(input.thinkingLevelMap)) {
			throw new Error(
				`Model "${input.modelId}" uses manual reasoning but does not configure any thinking level value`,
			);
		}
		return {
			reasoning: true,
			thinkingLevelMap: normalizeManualThinkingLevelMap(input.thinkingLevelMap),
			source: "manual",
		};
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
