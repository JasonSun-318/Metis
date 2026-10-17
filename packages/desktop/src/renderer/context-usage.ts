export function contextUsagePercent(status: {
	readonly contextTokens: number | null;
	readonly contextWindow: number | null;
}): number | null {
	if (status.contextTokens === null || status.contextWindow === null || status.contextWindow <= 0) return null;
	return Math.max(0, (status.contextTokens / status.contextWindow) * 100);
}

export function contextFillPercent(status: {
	readonly contextTokens: number | null;
	readonly contextWindow: number | null;
}): number | null {
	const percent = contextUsagePercent(status);
	return percent === null ? null : Math.min(100, percent);
}

export function formatContextTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 100_000) return `${(count / 1000).toFixed(1)}K`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}K`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
