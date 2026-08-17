import type { ItemView } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import {
	appendProjectedDelta,
	projectLiveMessage,
	projectMessageEntry,
	projectSessionEntry,
} from "../src/item-projection.ts";

const CREATED_AT = "2026-08-08T00:00:00.000Z";

describe("assistant usage projection", () => {
	it("projects output usage without double-counting reasoning", () => {
		const item = projectLiveMessage({
			itemId: "assistant-1",
			sessionId: "session-1",
			turnId: "turn-1",
			state: "streaming",
			fallbackTimestamp: CREATED_AT,
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "分析" }],
				usage: { output: 44, reasoning: 30 },
				timestamp: Date.parse(CREATED_AT),
			},
		});

		expect(item?.usage).toEqual({ outputTokens: 44 });
	});

	it("projects full cache usage onto completed assistant items", () => {
		const item = projectLiveMessage({
			itemId: "assistant-2",
			sessionId: "session-1",
			turnId: "turn-1",
			state: "completed",
			fallbackTimestamp: CREATED_AT,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "reply" }],
				usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 40 },
				timestamp: Date.parse(CREATED_AT),
			},
		});

		expect(item?.usage).toEqual({
			outputTokens: 30,
			inputTokens: 120,
			cacheReadTokens: 80,
			cacheWriteTokens: 40,
		});
	});

	it("keeps projected cache usage when a streamed delta updates output tokens", () => {
		const streamingItem: ItemView = {
			itemId: "assistant-2",
			sessionId: "session-1",
			turnId: "turn-1",
			role: "assistant",
			state: "streaming",
			content: [],
			usage: { outputTokens: 10, inputTokens: 120, cacheReadTokens: 80, cacheWriteTokens: 40 },
			createdAt: CREATED_AT,
		};

		const projected = appendProjectedDelta(streamingItem, { type: "text", text: "more", outputTokens: 12 });

		expect(projected?.item.usage).toEqual({
			outputTokens: 12,
			inputTokens: 120,
			cacheReadTokens: 80,
			cacheWriteTokens: 40,
		});
	});

	it("applies the latest output usage with a streamed delta", () => {
		const streamingItem: ItemView = {
			itemId: "assistant-1",
			sessionId: "session-1",
			turnId: "turn-1",
			role: "assistant",
			state: "streaming",
			content: [],
			createdAt: CREATED_AT,
		};

		const projected = appendProjectedDelta(streamingItem, {
			type: "text",
			text: "answer",
			outputTokens: 51,
		});

		expect(projected?.item.usage).toEqual({ outputTokens: 51 });
		expect(projected?.delta.outputTokens).toBe(51);
	});
});

describe("session entry projection", () => {
	it("projects compaction entries without exposing the private summary", () => {
		const item = projectSessionEntry({
			entry: {
				type: "compaction",
				id: "entry-compacted",
				parentId: "entry-before",
				timestamp: CREATED_AT,
				summary: "private compacted context",
				firstKeptEntryId: "entry-kept",
				tokensBefore: 64_000,
			},
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		});

		expect(item).toEqual({
			itemId: "entry-compacted",
			sessionId: "session-1",
			role: "system",
			state: "completed",
			content: [{ type: "compaction" }],
			createdAt: CREATED_AT,
			completedAt: CREATED_AT,
		});
		expect(JSON.stringify(item)).not.toContain("private compacted context");
	});
});

describe("tool result image projection", () => {
	const imageRef = {
		type: "image_ref",
		hash: "a".repeat(64),
		mimeType: "image/png",
		size: 4,
	} as const;

	function projectToolResult(content: unknown) {
		return projectMessageEntry({
			entry: {
				type: "message",
				id: "tool-1",
				timestamp: CREATED_AT,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "image_tool",
					isError: false,
					content,
				},
			},
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		});
	}

	it("attaches durable image refs onto tool_result", () => {
		const item = projectToolResult([{ type: "text", text: "ok" }, imageRef]);
		expect(item?.content).toEqual([
			{
				type: "tool_result",
				toolCallId: "call-1",
				name: "image_tool",
				isError: false,
				output: "ok",
				images: [{ hash: "a".repeat(64), mediaType: "image/png", byteLength: 4 }],
			},
		]);
	});

	it("omits images for text-only tool results", () => {
		const item = projectToolResult([{ type: "text", text: "ok" }]);
		expect(item?.content[0]).toEqual({
			type: "tool_result",
			toolCallId: "call-1",
			name: "image_tool",
			isError: false,
			output: "ok",
		});
	});

	it("caps projected tool result images at 4", () => {
		const item = projectToolResult([
			{ type: "text", text: "ok" },
			...Array.from({ length: 5 }, (_, index) => ({
				type: "image_ref",
				hash: `${"a".repeat(63)}${index}`,
				mimeType: "image/png",
				size: 4,
			})),
		]);
		const block = item?.content[0];
		expect(block?.type).toBe("tool_result");
		if (block?.type !== "tool_result") throw new Error("expected tool_result");
		expect(block.images).toHaveLength(4);
	});
});
