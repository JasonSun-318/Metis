import type { ItemView } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import {
	appendProjectedDelta,
	projectDeliveredFileFromToolResult,
	projectLiveMessage,
	projectMessageEntry,
	projectPlanEntry,
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

describe("delivered file projection", () => {
	const deliveredDetails = {
		fileId: "aaaaaaaaaaaaaaaa",
		name: "report.xlsx",
		byteLength: 4096,
		message: "Please review",
		deliveredAt: "2026-08-18T00:00:00.000Z",
	} as const;

	it("projects deliver_file history conservatively until the session module proves availability", () => {
		const message = {
			role: "toolResult",
			toolCallId: "call-deliver",
			toolName: "deliver_file",
			isError: false,
			details: deliveredDetails,
		};
		expect(projectDeliveredFileFromToolResult(message)).toEqual({
			...deliveredDetails,
			availability: "unavailable",
		});
		const deliveredFile = { ...deliveredDetails, availability: "available" as const };

		const item = projectMessageEntry({
			entry: { type: "message", id: "tool-deliver", timestamp: CREATED_AT, message },
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			deliveredFiles: new Map([[deliveredDetails.fileId, deliveredFile]]),
			fallbackTimestamp: CREATED_AT,
		});
		expect(item?.content[0]).toMatchObject({
			type: "tool_result",
			name: "deliver_file",
			deliveredFile,
		});
	});

	it("ignores invalid deliver_file payloads", () => {
		expect(
			projectDeliveredFileFromToolResult({
				role: "toolResult",
				toolName: "deliver_file",
				isError: true,
				details: deliveredDetails,
			}),
		).toBeUndefined();
		expect(
			projectDeliveredFileFromToolResult({
				role: "toolResult",
				toolName: "deliver_file",
				isError: false,
				details: { ...deliveredDetails, fileId: "not-valid" },
			}),
		).toBeUndefined();
	});
});

describe("plan projection", () => {
	const proposalEntry = {
		id: "proposal-entry-2",
		timestamp: "2026-08-25T00:00:00.000Z",
	};
	const storedPlan = {
		entryId: "proposal-entry-2",
		parentId: "user-2",
		planId: "plan-a",
		revision: 2,
		title: "Current plan",
		markdown: "plan body",
		status: "proposed" as const,
		createdAt: "2026-08-25T00:00:00.000Z",
	};

	it("projects a plan proposal as one assistant Plan item", () => {
		const item = projectPlanEntry({
			entry: proposalEntry,
			plan: storedPlan,
			sessionId: "session-12345678",
			fallbackTimestamp: CREATED_AT,
		});
		expect(item).toMatchObject({
			itemId: proposalEntry.id,
			role: "assistant",
			state: "completed",
			content: [{ type: "plan", plan: { revision: 2, status: "proposed" } }],
		});
	});

	it("does not project raw submit_plan call/result plumbing", () => {
		const submitOnlyAssistantInput = {
			entry: {
				type: "message",
				id: "assistant-submit-only",
				timestamp: CREATED_AT,
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "submit_plan", arguments: { title: "T", markdown: "m" } },
					],
				},
			},
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		};
		const submitToolResultInput = {
			entry: {
				type: "message",
				id: "tool-submit",
				timestamp: CREATED_AT,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "submit_plan",
					isError: false,
					content: [{ type: "text", text: "submitted" }],
				},
			},
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		};
		expect(projectMessageEntry(submitOnlyAssistantInput)).toBeUndefined();
		expect(projectMessageEntry(submitToolResultInput)).toBeUndefined();
	});
});

describe("uploaded file presentation", () => {
	const project = (content: unknown) =>
		projectLiveMessage({
			itemId: "user-attachment",
			sessionId: "session-1",
			turnId: "turn-1",
			state: "completed",
			fallbackTimestamp: CREATED_AT,
			message: { role: "user", content },
		});
	it("keeps real uploads separate from literal bracketed text in live and saved messages", () => {
		const content = `Read [notes.pdf]\n\n<attachments>${JSON.stringify([
			{ name: "notes.pdf", path: "/private/owned/hash.pdf", size: 2400 },
			{ name: "说明.md", path: "/private/owned/hash.md", size: 80 },
		])}</attachments>`;
		const live = project(content)!;
		expect(live.content).toEqual([{ type: "text", text: "Read [notes.pdf]" }]);
		expect(live.attachments).toEqual([
			{ name: "notes.pdf", byteLength: 2400 },
			{ name: "说明.md", byteLength: 80 },
		]);
		expect(JSON.stringify(live)).not.toContain("/private/owned");
		const saved = projectMessageEntry({
			entry: {
				type: "message",
				id: "user-attachment",
				turnId: "turn-1",
				timestamp: CREATED_AT,
				message: { role: "user", content },
			},
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		});
		expect(saved).toEqual(live);
		expect(project("[notes.pdf]")?.attachments).toBeUndefined();
	});
	it("retains all sixteen files after a long text block, and supports file-only messages", () => {
		const files = Array.from({ length: 16 }, (_, index) => ({
			name: `file-${index}.md`,
			path: `/private/${index}`,
			size: index,
		}));
		const metadata = `<attachments>${JSON.stringify(files)}</attachments>`;
		const result = project([
			{ type: "text", text: "长".repeat(30_000) },
			{ type: "text", text: metadata },
		])!;
		expect(result.attachments).toHaveLength(16);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20 * 1024);
		expect(project(metadata)?.content).toEqual([]);
		expect(project(metadata)?.attachments).toHaveLength(16);
	});
	it("does not leak paths for parsed invalid file sizes or turn ordinary text into uploads", () => {
		const result = project(
			`<attachment>${JSON.stringify({ name: "bad.txt", path: "/private/bad", size: 1.5 })}</attachment>`,
		)!;
		expect(result.attachments).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("/private/bad");
		expect(project("explain <attachments>XML</attachments>")?.content).toEqual([
			{ type: "text", text: "explain <attachments>XML</attachments>" },
		]);
	});
});
