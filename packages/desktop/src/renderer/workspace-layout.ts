/**
 * Pure pane geometry: projecting preferred weights onto an available budget and resizing
 * neighboring panes across one separator. No DOM or layout side effects; inputs are never mutated.
 */

function finiteNonnegative(value: number): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Projects preferred weights onto `available` pixels. Weights are sanitized (nonpositive or
 * nonfinite entries count as zero, an all-zero set falls back to equal shares), every pane
 * receives at least the soft minimum (`minimum` clamped to `available / count`), and the results
 * sum exactly to `available`. Returns an empty array for no weights and all zeros for an
 * unusable budget.
 */
export function projectPaneSizes(weights: readonly number[], available: number, minimum: number): readonly number[] {
	const count = weights.length;
	if (count === 0) return [];
	if (!finiteNonnegative(available) || available === 0) return new Array<number>(count).fill(0);
	const sanitized = weights.map((weight) =>
		typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 0,
	);
	// Scaling preserves ratios while keeping the sum of large finite weights finite.
	const maximumWeight = sanitized.reduce((maximum, weight) => Math.max(maximum, weight), 0);
	const scaled = maximumWeight > 0 ? sanitized.map((weight) => weight / maximumWeight) : sanitized;
	const totalWeight = scaled.reduce((sum, weight) => sum + weight, 0);
	const shareOf = (index: number) => (totalWeight > 0 ? scaled[index]! / totalWeight : 1 / count);
	const softMinimum = finiteNonnegative(minimum) ? Math.min(minimum, available / count) : 0;

	// Water-fill: repeatedly pin panes whose proportional share falls below the soft minimum to
	// that minimum and redistribute the remainder across the still-floating panes.
	const sizes = new Array<number>(count).fill(0);
	const pinned = new Array<boolean>(count).fill(false);
	for (;;) {
		let openWeight = 0;
		let remaining = available;
		for (let index = 0; index < count; index += 1) {
			if (pinned[index]) remaining -= sizes[index]!;
			else openWeight += shareOf(index);
		}
		if (openWeight <= 0) break;
		let changed = false;
		for (let index = 0; index < count; index += 1) {
			if (pinned[index]) continue;
			const share = remaining * (shareOf(index) / openWeight);
			if (share <= softMinimum) {
				sizes[index] = softMinimum;
				pinned[index] = true;
				changed = true;
			} else {
				sizes[index] = share;
			}
		}
		if (!changed) break;
	}

	// Absorb floating-point drift into the largest pane so the sizes sum exactly to `available`.
	let largest = 0;
	for (let index = 1; index < count; index += 1) {
		if (sizes[index]! > sizes[largest]!) largest = index;
	}
	const drift = available - sizes.reduce((sum, size) => sum + size, 0);
	sizes[largest] = (sizes[largest] ?? 0) + drift;
	return sizes;
}

/**
 * Moves the boundary between `sizes[boundary - 1]` and `sizes[boundary]` by `delta` pixels
 * (positive grows the left pane), clamped so both adjacent panes stay at or above `minimum`.
 * Non-adjacent sizes and the total are preserved; unusable input returns the original array.
 */
export function resizeAdjacentPaneSizes(
	sizes: readonly number[],
	boundary: number,
	delta: number,
	minimum: number,
): readonly number[] {
	if (
		!Number.isInteger(boundary) ||
		boundary < 1 ||
		boundary >= sizes.length ||
		sizes.length < 2 ||
		!sizes.every(finiteNonnegative) ||
		!Number.isFinite(delta) ||
		!finiteNonnegative(minimum)
	) {
		return sizes;
	}
	const left = sizes[boundary - 1]!;
	const right = sizes[boundary]!;
	const total = left + right;
	const effectiveMinimum = Math.min(minimum, total / 2);
	const lower = effectiveMinimum - left;
	const upper = right - effectiveMinimum;
	const clamped = Math.min(Math.max(delta, lower), upper);
	const next = [...sizes];
	next[boundary - 1] = left + clamped;
	next[boundary] = right - clamped;
	return next;
}
