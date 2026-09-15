import { lstatSync } from "node:fs";
import type { ClientResult } from "@metis/app-protocol";
import { DEFAULT_AGENT_MODE, type FileEntry, parseSkillUsageRecord, SessionManager } from "@metis/coding-agent/host";
import type { SessionRef } from "./session-runtime-host.ts";

const DAY_MS = 86_400_000;
const VISIBLE_WEEKS = 53;
const SKILL_USAGE_TYPE = "metis.skill_usage.v1";

interface SessionProfileContribution {
	readonly mode: "chat" | "code";
	readonly totalTokens: number;
	readonly tokensByDate: readonly (readonly [date: string, tokens: number])[];
	readonly usageByDate: readonly (readonly [
		date: string,
		usage: {
			readonly total: number;
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
		},
	])[];
	readonly modelTokensByDate: readonly (readonly [date: string, provider: string, modelId: string, tokens: number])[];
	readonly durationMs: number;
	readonly hasUserMessage: boolean;
	readonly thinkingCounts: readonly (readonly [level: ProfileThinkingLevel, count: number])[];
	readonly skillCounts: readonly (readonly [name: string, count: number])[];
}

type ProfileThinkingLevel = NonNullable<ClientResult<"profile/get">["mostUsedThinkingLevel"]>;
const PROFILE_THINKING_LEVELS = new Set<ProfileThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

interface ProfileSummaryCacheOptions {
	readonly fingerprint?: (path: string) => string;
	readonly readEntries?: (path: string) => readonly FileEntry[];
}

function safeCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function safeAdd(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, safeCount(left) + safeCount(right));
}

function localDateKey(timestamp: number): string {
	const date = new Date(timestamp);
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function dateKeyDayNumber(value: string): number {
	const [year, month, day] = value.split("-").map(Number) as [number, number, number];
	return Math.trunc(Date.UTC(year, month - 1, day) / DAY_MS);
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function dominant<Value extends string>(counts: ReadonlyMap<Value, number>): { value: Value | null; percent: number } {
	const ranked = [...counts].sort(
		([leftValue, leftCount], [rightValue, rightCount]) =>
			rightCount - leftCount || compareNames(leftValue, rightValue),
	);
	const total = ranked.reduce((sum, [, count]) => safeAdd(sum, count), 0);
	return ranked[0] && total > 0
		? { value: ranked[0][0], percent: Math.round((ranked[0][1] / total) * 100) }
		: { value: null, percent: 0 };
}

export function reduceProfileEntries(entries: readonly FileEntry[]): SessionProfileContribution {
	const tokensByDate = new Map<string, number>();
	const usageByDate = new Map<
		string,
		{ total: number; input: number; output: number; cacheRead: number; cacheWrite: number }
	>();
	const modelTokensByDate = new Map<string, { date: string; provider: string; modelId: string; tokens: number }>();
	const skillCounts = new Map<string, number>();
	const thinkingCounts = new Map<ProfileThinkingLevel, number>();
	const header = entries.find((entry) => entry.type === "session");
	const mode = header?.type === "session" ? (header.mode ?? DEFAULT_AGENT_MODE) : DEFAULT_AGENT_MODE;
	let thinkingLevel: ProfileThinkingLevel | null = null;
	let totalTokens = 0;
	let firstMessageAt = Number.POSITIVE_INFINITY;
	let lastMessageAt = Number.NEGATIVE_INFINITY;
	let hasUserMessage = false;

	for (const entry of entries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = PROFILE_THINKING_LEVELS.has(entry.thinkingLevel as ProfileThinkingLevel)
				? (entry.thinkingLevel as ProfileThinkingLevel)
				: null;
			continue;
		}
		if (entry.type === "custom" && entry.customType === SKILL_USAGE_TYPE) {
			const usage = parseSkillUsageRecord(entry.data);
			if (usage) skillCounts.set(usage.name, safeAdd(skillCounts.get(usage.name) ?? 0, 1));
			continue;
		}
		if (entry.type !== "message") continue;
		const timestamp = entry.message.timestamp;
		if (!Number.isFinite(timestamp)) continue;
		firstMessageAt = Math.min(firstMessageAt, timestamp);
		lastMessageAt = Math.max(lastMessageAt, timestamp);
		if (entry.message.role === "user") hasUserMessage = true;
		if (entry.message.role !== "assistant") continue;
		if (thinkingLevel) thinkingCounts.set(thinkingLevel, safeAdd(thinkingCounts.get(thinkingLevel) ?? 0, 1));
		const tokens = safeCount(entry.message.usage.totalTokens);
		totalTokens = safeAdd(totalTokens, tokens);
		if (tokens > 0) {
			const date = localDateKey(timestamp);
			tokensByDate.set(date, safeAdd(tokensByDate.get(date) ?? 0, tokens));
			const daily = usageByDate.get(date) ?? { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			daily.total = safeAdd(daily.total, tokens);
			daily.input = safeAdd(daily.input, entry.message.usage.input);
			daily.output = safeAdd(daily.output, entry.message.usage.output);
			daily.cacheRead = safeAdd(daily.cacheRead, entry.message.usage.cacheRead);
			daily.cacheWrite = safeAdd(daily.cacheWrite, entry.message.usage.cacheWrite);
			usageByDate.set(date, daily);
			const modelKey = `${date}\0${entry.message.provider}\0${entry.message.model}`;
			const model = modelTokensByDate.get(modelKey) ?? {
				date,
				provider: entry.message.provider,
				modelId: entry.message.model,
				tokens: 0,
			};
			model.tokens = safeAdd(model.tokens, tokens);
			modelTokensByDate.set(modelKey, model);
		}
	}

	return {
		mode,
		totalTokens,
		tokensByDate: [...tokensByDate].sort(([left], [right]) => compareNames(left, right)),
		usageByDate: [...usageByDate].sort(([left], [right]) => compareNames(left, right)),
		modelTokensByDate: [...modelTokensByDate.values()]
			.sort(
				(left, right) =>
					compareNames(left.date, right.date) ||
					compareNames(left.provider, right.provider) ||
					compareNames(left.modelId, right.modelId),
			)
			.map((entry) => [entry.date, entry.provider, entry.modelId, entry.tokens]),
		durationMs:
			hasUserMessage && Number.isFinite(firstMessageAt) && Number.isFinite(lastMessageAt)
				? Math.max(0, lastMessageAt - firstMessageAt)
				: 0,
		hasUserMessage,
		thinkingCounts: [...thinkingCounts].sort(([left], [right]) => compareNames(left, right)),
		skillCounts: [...skillCounts].sort(([left], [right]) => compareNames(left, right)),
	};
}

export function buildUsageSummary(
	contributions: readonly SessionProfileContribution[],
	rangeDays: 7 | 30 | 90,
	now = Date.now(),
): ClientResult<"usage/get"> {
	const todayDay = dateKeyDayNumber(localDateKey(now));
	const firstDay = todayDay - rangeDays + 1;
	const daily = Array.from({ length: rangeDays }, (_, index) => ({
		date: new Date((firstDay + index) * DAY_MS).toISOString().slice(0, 10),
		chatTokens: 0,
		codeTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	}));
	const byDate = new Map(daily.map((day) => [day.date, day]));
	const modelTotals = new Map<string, { provider: string; modelId: string; totalTokens: number }>();
	let totalTokens = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let chatTokens = 0;
	let codeTokens = 0;
	let chatSessionCount = 0;
	let codeSessionCount = 0;

	for (const contribution of contributions) {
		let sessionTokens = 0;
		for (const [date, usage] of contribution.usageByDate) {
			const day = byDate.get(date);
			if (!day) continue;
			sessionTokens = safeAdd(sessionTokens, usage.total);
			totalTokens = safeAdd(totalTokens, usage.total);
			inputTokens = safeAdd(inputTokens, usage.input);
			outputTokens = safeAdd(outputTokens, usage.output);
			cacheReadTokens = safeAdd(cacheReadTokens, usage.cacheRead);
			cacheWriteTokens = safeAdd(cacheWriteTokens, usage.cacheWrite);
			day.inputTokens = safeAdd(day.inputTokens, usage.input);
			day.outputTokens = safeAdd(day.outputTokens, usage.output);
			day.cacheReadTokens = safeAdd(day.cacheReadTokens, usage.cacheRead);
			day.cacheWriteTokens = safeAdd(day.cacheWriteTokens, usage.cacheWrite);
			if (contribution.mode === "chat") {
				chatTokens = safeAdd(chatTokens, usage.total);
				day.chatTokens = safeAdd(day.chatTokens, usage.total);
			} else {
				codeTokens = safeAdd(codeTokens, usage.total);
				day.codeTokens = safeAdd(day.codeTokens, usage.total);
			}
		}
		if (contribution.hasUserMessage && sessionTokens > 0) {
			if (contribution.mode === "chat") chatSessionCount += 1;
			else codeSessionCount += 1;
		}
		for (const [date, provider, modelId, tokens] of contribution.modelTokensByDate) {
			if (!byDate.has(date)) continue;
			const key = `${provider}\0${modelId}`;
			const model = modelTotals.get(key) ?? { provider, modelId, totalTokens: 0 };
			model.totalTokens = safeAdd(model.totalTokens, tokens);
			modelTotals.set(key, model);
		}
	}

	return {
		generatedAt: new Date(now).toISOString(),
		rangeDays,
		totalTokens,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		chatTokens,
		codeTokens,
		sessionCount: chatSessionCount + codeSessionCount,
		chatSessionCount,
		codeSessionCount,
		daily,
		topModels: [...modelTotals.values()]
			.sort(
				(left, right) =>
					right.totalTokens - left.totalTokens ||
					compareNames(left.provider, right.provider) ||
					compareNames(left.modelId, right.modelId),
			)
			.slice(0, 8),
	};
}

export function buildProfileSummary(
	contributions: readonly SessionProfileContribution[],
	now = Date.now(),
): ClientResult<"profile/get"> {
	const tokensByDate = new Map<string, number>();
	const skillCounts = new Map<string, number>();
	const modeCounts = new Map<"chat" | "code", number>();
	const thinkingCounts = new Map<ProfileThinkingLevel, number>();
	let totalTokens = 0;
	let longestSessionMs = 0;
	let sessionCount = 0;

	for (const contribution of contributions) {
		totalTokens = safeAdd(totalTokens, contribution.totalTokens);
		longestSessionMs = Math.max(longestSessionMs, contribution.durationMs);
		if (contribution.hasUserMessage) {
			sessionCount += 1;
			modeCounts.set(contribution.mode, safeAdd(modeCounts.get(contribution.mode) ?? 0, 1));
		}
		for (const [date, tokens] of contribution.tokensByDate) {
			tokensByDate.set(date, safeAdd(tokensByDate.get(date) ?? 0, tokens));
		}
		for (const [name, count] of contribution.skillCounts) {
			skillCounts.set(name, safeAdd(skillCounts.get(name) ?? 0, count));
		}
		for (const [level, count] of contribution.thinkingCounts) {
			thinkingCounts.set(level, safeAdd(thinkingCounts.get(level) ?? 0, count));
		}
	}
	const mostUsedMode = dominant(modeCounts);
	const mostUsedThinkingLevel = dominant(thinkingCounts);

	const todayKey = localDateKey(now);
	const todayDayNumber = dateKeyDayNumber(todayKey);
	const today = new Date(now);
	const firstVisibleDayNumber = todayDayNumber - today.getDay() - (VISIBLE_WEEKS - 1) * 7;
	const activity = [...tokensByDate]
		.filter(([date, tokens]) => {
			const day = dateKeyDayNumber(date);
			return tokens > 0 && day >= firstVisibleDayNumber && day <= todayDayNumber;
		})
		.map(([date, tokens]) => ({ date, tokens }))
		.sort((left, right) => compareNames(left.date, right.date));

	const activeDayNumbers = [...tokensByDate]
		.filter(([, tokens]) => tokens > 0)
		.map(([date]) => dateKeyDayNumber(date))
		.filter((day) => day <= todayDayNumber)
		.sort((left, right) => left - right);
	let longestStreakDays = 0;
	let runningStreak = 0;
	let previousDay: number | undefined;
	for (const day of activeDayNumbers) {
		runningStreak = previousDay !== undefined && day === previousDay + 1 ? runningStreak + 1 : 1;
		longestStreakDays = Math.max(longestStreakDays, runningStreak);
		previousDay = day;
	}
	const activeDays = new Set(activeDayNumbers);
	let currentStreakDays = 0;
	for (let day = todayDayNumber; activeDays.has(day); day -= 1) currentStreakDays += 1;

	const topSkills = [...skillCounts]
		.sort(
			([leftName, leftCount], [rightName, rightCount]) =>
				rightCount - leftCount || compareNames(leftName, rightName),
		)
		.slice(0, 5)
		.map(([name, count]) => ({ name, count }));

	return {
		generatedAt: new Date(now).toISOString(),
		totalTokens,
		peakDailyTokens: [...tokensByDate.values()].reduce((peak, tokens) => Math.max(peak, tokens), 0),
		longestSessionMs,
		currentStreakDays,
		longestStreakDays,
		sessionCount,
		mostUsedMode: mostUsedMode.value,
		mostUsedModePercent: mostUsedMode.percent,
		mostUsedThinkingLevel: mostUsedThinkingLevel.value,
		mostUsedThinkingLevelPercent: mostUsedThinkingLevel.percent,
		usedSkillCount: skillCounts.size,
		skillUseCount: [...skillCounts.values()].reduce(safeAdd, 0),
		activity,
		topSkills,
	};
}

function defaultFingerprint(path: string): string {
	const stats = lstatSync(path);
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function defaultReadEntries(path: string): readonly FileEntry[] {
	return SessionManager.openReadOnly(path).getDurableJournalSnapshot();
}

/** Caches per-journal reductions; unchanged sessions avoid repeated JSONL parsing. */
export class ProfileSummaryCache {
	private readonly cache = new Map<
		string,
		{ readonly fingerprint: string; readonly value: SessionProfileContribution }
	>();
	private readonly fingerprint: (path: string) => string;
	private readonly readEntries: (path: string) => readonly FileEntry[];

	constructor(options: ProfileSummaryCacheOptions = {}) {
		this.fingerprint = options.fingerprint ?? defaultFingerprint;
		this.readEntries = options.readEntries ?? defaultReadEntries;
	}

	private contributions(refs: readonly SessionRef[]): SessionProfileContribution[] {
		const livePaths = new Set(refs.map((ref) => ref.path));
		for (const path of this.cache.keys()) {
			if (!livePaths.has(path)) this.cache.delete(path);
		}
		const contributions: SessionProfileContribution[] = [];
		for (const ref of refs) {
			if (ref.summary.state === "corrupt") {
				this.cache.delete(ref.path);
				continue;
			}
			try {
				const fingerprint = this.fingerprint(ref.path);
				let cached = this.cache.get(ref.path);
				if (!cached || cached.fingerprint !== fingerprint) {
					cached = { fingerprint, value: reduceProfileEntries(this.readEntries(ref.path)) };
					this.cache.set(ref.path, cached);
				}
				contributions.push(cached.value);
			} catch {
				// One unreadable journal must not make the local profile unavailable.
			}
		}
		return contributions;
	}

	summarize(refs: readonly SessionRef[], now = Date.now()): ClientResult<"profile/get"> {
		return buildProfileSummary(this.contributions(refs), now);
	}

	usage(refs: readonly SessionRef[], rangeDays: 7 | 30 | 90, now = Date.now()): ClientResult<"usage/get"> {
		return buildUsageSummary(this.contributions(refs), rangeDays, now);
	}
}
