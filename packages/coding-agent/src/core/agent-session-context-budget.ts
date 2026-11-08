import { getMicrocompactionTarget, type MicrocompactionTarget } from "./tool-result-microcompaction.ts";

/** Token count at which compaction / pressure pruning becomes relevant. */
export function compactionHighWatermark(contextWindow: number | undefined, reserveTokens: number): number {
	return (contextWindow ?? 0) - reserveTokens;
}

export interface MicrocompactionPressureInput {
	readonly used: number;
	readonly contextWindow: number | undefined;
	readonly reserveTokens: number;
	readonly growthP95: number;
}

/**
 * Resolves the pressure-pruning target for a projected context view, or
 * undefined when the view is below the high watermark / growth signal.
 */
export function microcompactionPressureTarget(input: MicrocompactionPressureInput): MicrocompactionTarget | undefined {
	return getMicrocompactionTarget({
		used: input.used,
		high: compactionHighWatermark(input.contextWindow, input.reserveTokens),
		growthP95: input.growthP95,
	});
}
