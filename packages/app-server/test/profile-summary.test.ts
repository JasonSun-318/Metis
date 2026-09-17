import type { FileEntry } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import {
	buildProfileSummary,
	buildUsageSummary,
	ProfileSummaryCache,
	reduceProfileEntries,
} from "../src/profile-summary.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";

function localTime(year: number, month: number, day: number, hour = 12): number {
	return new Date(year, month - 1, day, hour).getTime();
}

function userEntry(id: string, timestamp: number): FileEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: "hello", timestamp },
	};
}

function assistantEntry(id: string, timestamp: number, totalTokens: number): FileEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		},
	};
}

function skillEntry(id: string, name: string, trigger: "command" | "read" = "read"): FileEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-01T00:00:00.000Z",
		customType: "metis.skill_usage.v1",
		data: { name, trigger },
	};
}

function sessionEntry(id: string, mode: "chat" | "code"): FileEntry {
	return {
		type: "session",
		version: 9,
		id,
		timestamp: "2026-08-01T00:00:00.000Z",
		cwd: "/tmp/profile-test",
		mode,
	};
}

function thinkingEntry(id: string, thinkingLevel: string): FileEntry {
	return {
		type: "thinking_level_change",
		id,
		parentId: null,
		timestamp: "2026-08-01T00:00:00.000Z",
		thinkingLevel,
	};
}

function ref(path: string, state: SessionRef["summary"]["state"] = "idle"): SessionRef {
	return {
		path,
		relativePath: path,
		summary: {
			sessionId: path.replace(/\W/gu, "") || "session",
			mode: "chat",
			cwdOrigin: "managed",
			cwd: null,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			state,
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
	};
}

describe("profile summary", () => {
	it("aggregates real Token, streak, chat-duration, and Skill usage data", () => {
		const first = reduceProfileEntries([
			sessionEntry("10000000-0000-4000-8000-000000000001", "chat"),
			userEntry("u1", localTime(2026, 7, 31, 9)),
			assistantEntry("a1", localTime(2026, 7, 31, 10), 200),
			skillEntry("s1", "pdf"),
			skillEntry("s2", "pdf", "command"),
		]);
		const second = reduceProfileEntries([
			sessionEntry("10000000-0000-4000-8000-000000000002", "chat"),
			userEntry("u2", localTime(2026, 8, 1, 11)),
			assistantEntry("a2", localTime(2026, 8, 1, 12), 400),
			skillEntry("s3", "documents"),
		]);

		expect(buildProfileSummary([first, second], localTime(2026, 8, 1, 18))).toEqual({
			generatedAt: new Date(localTime(2026, 8, 1, 18)).toISOString(),
			totalTokens: 600,
			peakDailyTokens: 400,
			longestSessionMs: 3_600_000,
			currentStreakDays: 2,
			longestStreakDays: 2,
			sessionCount: 2,
			mostUsedMode: "chat",
			mostUsedModePercent: 100,
			mostUsedThinkingLevel: null,
			mostUsedThinkingLevelPercent: 0,
			usedSkillCount: 2,
			skillUseCount: 3,
			activity: [
				{ date: "2026-07-31", tokens: 200 },
				{ date: "2026-08-01", tokens: 400 },
			],
			topSkills: [
				{ name: "pdf", count: 2 },
				{ name: "documents", count: 1 },
			],
		});
	});

	it("reports dominant mode and only classifies reasoning recorded in the journal", () => {
		const contributions = [
			reduceProfileEntries([
				sessionEntry("10000000-0000-4000-8000-000000000011", "chat"),
				userEntry("u1", localTime(2026, 8, 1, 8)),
				thinkingEntry("t1", "high"),
				assistantEntry("a1", localTime(2026, 8, 1, 9), 10),
				assistantEntry("a2", localTime(2026, 8, 1, 10), 10),
			]),
			reduceProfileEntries([
				sessionEntry("10000000-0000-4000-8000-000000000012", "code"),
				userEntry("u2", localTime(2026, 8, 1, 11)),
				assistantEntry("unknown", localTime(2026, 8, 1, 12), 10),
				thinkingEntry("t2", "high"),
				assistantEntry("a3", localTime(2026, 8, 1, 13), 10),
			]),
			reduceProfileEntries([
				sessionEntry("10000000-0000-4000-8000-000000000013", "code"),
				userEntry("u3", localTime(2026, 8, 1, 14)),
				thinkingEntry("t3", "medium"),
				assistantEntry("a4", localTime(2026, 8, 1, 15), 10),
			]),
		];

		expect(buildProfileSummary(contributions, localTime(2026, 8, 1, 18))).toMatchObject({
			mostUsedMode: "code",
			mostUsedModePercent: 67,
			mostUsedThinkingLevel: "high",
			mostUsedThinkingLevelPercent: 75,
		});
	});

	it("builds range-scoped daily and model usage from the shared journal reduction", () => {
		const chat = reduceProfileEntries([
			sessionEntry("10000000-0000-4000-8000-000000000021", "chat"),
			userEntry("u1", localTime(2026, 8, 7)),
			assistantEntry("a1", localTime(2026, 8, 7), 20),
		]);
		const code = reduceProfileEntries([
			sessionEntry("10000000-0000-4000-8000-000000000022", "code"),
			userEntry("u2", localTime(2026, 8, 8)),
			assistantEntry("a2", localTime(2026, 8, 8), 30),
		]);

		const summary = buildUsageSummary([chat, code], 7, localTime(2026, 8, 8, 18));
		expect(summary).toMatchObject({
			rangeDays: 7,
			totalTokens: 50,
			inputTokens: 50,
			outputTokens: 0,
			chatTokens: 20,
			codeTokens: 30,
			sessionCount: 2,
			chatSessionCount: 1,
			codeSessionCount: 1,
			topModels: [{ provider: "openai", modelId: "gpt-test", totalTokens: 50 }],
		});
		expect(summary.daily).toHaveLength(7);
		expect(summary.daily.slice(-2)).toEqual([
			{
				date: "2026-08-07",
				chatTokens: 20,
				codeTokens: 0,
				inputTokens: 20,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			{
				date: "2026-08-08",
				chatTokens: 0,
				codeTokens: 30,
				inputTokens: 30,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		]);
	});

	it("keeps all-time totals while clipping the sparse heatmap to 53 weeks", () => {
		const now = localTime(2026, 8, 1);
		const old = reduceProfileEntries([assistantEntry("old", localTime(2025, 1, 1), 50)]);
		const current = reduceProfileEntries([assistantEntry("new", now, 75)]);
		const summary = buildProfileSummary([old, current], now);

		expect(summary.totalTokens).toBe(125);
		expect(summary.peakDailyTokens).toBe(75);
		expect(summary.activity).toEqual([{ date: "2026-08-01", tokens: 75 }]);
		expect(summary.currentStreakDays).toBe(1);
		expect(summary.longestStreakDays).toBe(1);
	});

	it("ignores malformed Skill usage and sorts ties by Skill name", () => {
		const contribution = reduceProfileEntries([
			skillEntry("s1", "zeta"),
			skillEntry("s2", "alpha"),
			{
				type: "custom",
				id: "bad",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				customType: "arcmind.skill_usage.v1",
				data: { name: "fake", trigger: "tool", extra: true },
			},
		]);

		expect(buildProfileSummary([contribution], localTime(2026, 8, 1)).topSkills).toEqual([
			{ name: "alpha", count: 1 },
			{ name: "zeta", count: 1 },
		]);
	});

	it("reuses unchanged per-journal reductions and refreshes changed journals", () => {
		let version = "v1";
		let reads = 0;
		let entries: readonly FileEntry[] = [assistantEntry("a1", localTime(2026, 8, 1), 10)];
		const cache = new ProfileSummaryCache({
			fingerprint: () => version,
			readEntries: () => {
				reads += 1;
				return entries;
			},
		});
		const session = ref("session-a.jsonl");

		expect(cache.summarize([session], localTime(2026, 8, 1)).totalTokens).toBe(10);
		expect(cache.summarize([session], localTime(2026, 8, 1)).totalTokens).toBe(10);
		expect(reads).toBe(1);

		version = "v2";
		entries = [assistantEntry("a2", localTime(2026, 8, 1), 25)];
		expect(cache.summarize([session], localTime(2026, 8, 1)).totalTokens).toBe(25);
		expect(reads).toBe(2);
	});

	it("skips corrupt and unreadable journals without failing the profile", () => {
		const cache = new ProfileSummaryCache({
			fingerprint: (path) => {
				if (path === "unreadable.jsonl") throw new Error("unreadable");
				return "v1";
			},
			readEntries: () => [assistantEntry("a", localTime(2026, 8, 1), 10)],
		});

		expect(
			cache.summarize(
				[ref("healthy.jsonl"), ref("unreadable.jsonl"), ref("corrupt.jsonl", "corrupt")],
				localTime(2026, 8, 1),
			).totalTokens,
		).toBe(10);
	});
});
