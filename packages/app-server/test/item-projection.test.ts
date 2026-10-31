import type { ItemView } from "@metis/app-protocol";
import { formatSessionFileSelections } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import {
	appendProjectedDelta,
	projectDeliveredFileFromToolResult,
	projectLiveMessage,
	projectMessageEntry,
	projectPermissionDecisions,
	projectPlanEntry,
	projectSessionEntry,
} from "../src/item-projection.ts";
import { SessionProjection } from "../src/projection/session-projection.ts";

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
	it("keeps each delivery's historical caption while refreshing file availability and size", () => {
		const current = {
			...deliveredDetails,
			message: "Revised version",
			name: "updated.xlsx",
			byteLength: 8192,
			deliveredAt: "2026-10-29T00:00:00.000Z",
			availability: "available" as const,
		};
		expect(
			projectDeliveredFileFromToolResult(
				{ role: "toolResult", toolName: "deliver_file", isError: false, details: deliveredDetails },
				new Map([[current.fileId, current]]),
			),
		).toEqual({ ...deliveredDetails, byteLength: 8192, availability: "available" });
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

describe("selected file presentation", () => {
	const selection = {
		source: "workspace" as const,
		name: "AGENTS.md",
		path: "/private/work/AGENTS.md",
		basis: "source" as const,
		selectedText: "# 1. Language\nDefault language: Chinese.",
		startLine: 1,
		endLine: 8,
	};
	const project = (content: unknown) =>
		projectLiveMessage({
			itemId: "selected-file",
			sessionId: "session-1",
			turnId: "turn-1",
			state: "completed",
			fallbackTimestamp: CREATED_AT,
			message: { role: "user", content },
		})!;
	it("preserves references in live and restored views without flattening them into text or exposing paths", () => {
		const content = formatSessionFileSelections("翻译一下 [literal.md:1–8]", [selection]);
		const live = project(content);
		expect(live.content).toEqual([{ type: "text", text: "翻译一下 [literal.md:1–8]" }]);
		expect(live.fileSelections).toEqual([
			{
				name: selection.name,
				source: selection.source,
				selectedText: selection.selectedText,
				startLine: 1,
				endLine: 8,
			},
		]);
		expect(JSON.stringify(live)).not.toContain("/private/work");
		expect(JSON.stringify(live)).not.toContain("file_selections");
		const restored = projectMessageEntry({
			entry: {
				type: "message",
				id: "selected-file",
				turnId: "turn-1",
				timestamp: CREATED_AT,
				message: { role: "user", content },
			},
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		});
		expect(restored).toEqual(live);
		expect(project("[AGENTS.md:1–8]").fileSelections).toBeUndefined();
		expect(project(formatSessionFileSelections("", [selection])).content).toEqual([]);
	});
	it("bounds UTF-8 previews and total reference count without changing the durable quote", () => {
		const quoted = { ...selection, selectedText: "中文".repeat(2000) };
		const durable = formatSessionFileSelections("Explain", [quoted]);
		const result = project(durable);
		expect(Buffer.byteLength(result.fileSelections![0]!.selectedText, "utf8")).toBeLessThanOrEqual(2048);
		expect(result.fileSelections![0]!.selectedTextTruncated).toBe(true);
		expect(result.fileSelections![0]!.selectedText).not.toContain("\ufffd");
		expect(durable).toContain(quoted.selectedText);
		const many = Array.from({ length: 3 }, () => ({
			type: "text",
			text: formatSessionFileSelections("", Array(8).fill(selection)),
		}));
		expect(project(many).fileSelections).toHaveLength(8);
	});
	it("keeps public document locations and omits private slide addressing", () => {
		const result = project(
			formatSessionFileSelections("Explain", [
				{ ...selection, target: { kind: "pdf", page: 2, endPage: 3 } },
				{
					...selection,
					target: {
						kind: "pptx",
						page: 4,
						slidePath: "ppt/slides/slide4.xml",
						objectId: "shape-1",
						objectType: "shape",
						objectName: "Title",
					},
				},
				{ ...selection, target: { kind: "spreadsheet", sheet: "Budget", range: "C5:D6" } },
			]),
		);
		expect(result.fileSelections?.map((file) => file.target)).toEqual([
			{ kind: "pdf", page: 2, endPage: 3 },
			{ kind: "pptx", page: 4, objectName: "Title" },
			{ kind: "spreadsheet", sheet: "Budget", range: "C5:D6" },
		]);
		expect(JSON.stringify(result)).not.toContain("slidePath");
	});
});

describe("final permission source projection", () => {
	it("preserves host decisions on live and restored items while ignoring provider-supplied metadata", () => {
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "bash",
					arguments: { command: "pwd" },
					permissionDecision: { source: "model" },
				},
			],
		};
		const base = {
			entry: { type: "message", id: "item-1", message, timestamp: CREATED_AT },
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: CREATED_AT,
		};
		expect(projectMessageEntry(base)?.content[0]).not.toHaveProperty("permissionDecision");
		const permissionDecisions = projectPermissionDecisions([
			{ type: "session_permission_audit", actionId: "call-1", decision: "allow", source: "model" },
			{ type: "session_permission_audit", actionId: "call-2", decision: "deny", source: "model" },
			{ type: "session_permission_audit", actionId: "call-3", decision: "allow", source: "reviewer" },
			{ type: "message", actionId: "call-1", decision: "allow", source: "full" },
		]);
		expect(permissionDecisions.size).toBe(1);
		const restored = projectMessageEntry({ ...base, permissionDecisions });
		const live = projectLiveMessage({
			itemId: "item-live",
			sessionId: "session-1",
			message,
			state: "completed",
			permissionDecisions,
			fallbackTimestamp: CREATED_AT,
		});
		expect(restored?.content[0]).toHaveProperty("permissionDecision.source", "model");
		expect(live?.content[0]).toHaveProperty("permissionDecision.source", "model");
	});
});

it("keeps a live permission decision in readItems reconnect output", () => {
	const projection = new SessionProjection({
		session: {
			sessionId: "session-1",
			mode: "code",
			cwdOrigin: "user-selected",
			cwd: "/tmp/project",
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			state: "idle",
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
		items: [
			{
				itemId: "item-1",
				sessionId: "session-1",
				role: "assistant",
				state: "completed",
				createdAt: CREATED_AT,
				content: [{ type: "tool_call", toolCallId: "call-1", name: "bash", state: "completed" }],
			},
		],
	});
	expect(projection.setPermissionDecision("foreign-call", "model")).toEqual([]);
	const changed = projection.setPermissionDecision("call-1", "rule");
	expect(changed).toHaveLength(1);
	const result = projection.readItems({ sessionId: "session-1", limit: 20 });
	expect(result.items[0]?.content[0]).toHaveProperty("permissionDecision.source", "rule");
});

describe("managed permission decision details", () => {
	it("projects saved rule identities and preserves legacy records without guessing a rule", () => {
		const decisions = projectPermissionDecisions([
			{ type: "session_permission_audit", actionId: "legacy", decision: "allow", source: "rule" },
			{
				type: "session_permission_audit",
				actionId: "managed",
				decision: "allow",
				source: "rule",
				ruleIds: ["C03"],
				matchedRule: { id: "C03", name: "ls", scope: "workspace" },
			},
			{
				type: "session_permission_audit",
				actionId: "remembered",
				decision: "allow",
				source: "rule",
				ruleIds: ["a".repeat(64)],
				matchedRule: { id: "a".repeat(64), name: "publish", scope: "session" },
			},
			{
				type: "session_permission_audit",
				actionId: "manual",
				decision: "allow",
				source: "user",
				manualReason: "write",
			},
		]);
		expect([...decisions.values()]).toEqual([
			"rule",
			{ source: "rule", ruleIds: ["C03"], matchedRule: { id: "C03", name: "ls", scope: "workspace" } },
			{
				source: "rule",
				ruleIds: ["a".repeat(64)],
				matchedRule: { id: "a".repeat(64), name: "publish", scope: "session" },
			},
			{ source: "user", outcome: "allow", manualReason: "write" },
		]);
	});

	it("does not forward malformed rule metadata from a stored journal", () => {
		const decisions = projectPermissionDecisions([
			{
				type: "session_permission_audit",
				actionId: "malformed",
				decision: "allow",
				source: "rule",
				matchedRule: { id: "C03", name: "ls", scope: "workspace", secret: "hidden" },
			},
		]);
		expect([...decisions.values()]).toEqual(["rule"]);
	});

	it("publishes the same matched rule detail for a live tool row", () => {
		const projection = new SessionProjection({
			session: {
				sessionId: "test-session",
				mode: "code",
				cwdOrigin: "user-selected",
				cwd: "/tmp/project",
				createdAt: CREATED_AT,
				updatedAt: CREATED_AT,
				state: "idle",
				archived: false,
				unread: false,
				useMemory: true,
				contributeMemory: true,
			},
		});
		const item: ItemView = {
			itemId: "assistant-managed",
			sessionId: "test-session",
			turnId: "turn-1",
			role: "assistant",
			state: "streaming",
			createdAt: CREATED_AT,
			content: [{ type: "tool_call", toolCallId: "managed", name: "bash", state: "running" }],
		};
		projection.apply({ type: "item/started", item });
		const updated = projection.setPermissionDecision("managed", "rule", {
			ruleIds: ["C03"],
			matchedRule: { id: "C03", name: "ls", scope: "workspace" },
		});
		expect(updated[0]?.content[0]).toMatchObject({
			permissionDecision: {
				source: "rule",
				ruleIds: ["C03"],
				matchedRule: { id: "C03", name: "ls", scope: "workspace" },
			},
		});
	});
});

it("restores manual allow, deny and unavailable outcomes without treating execution as approval", () => {
	const decisions = projectPermissionDecisions([
		{
			type: "session_permission_audit",
			actionId: "allow-session",
			source: "user",
			decision: "allow",
			remember: "session",
			reason: "authorization.allowed",
		},
		{
			type: "session_permission_audit",
			actionId: "deny-project",
			source: "user",
			decision: "deny",
			remember: "project",
			reason: "review.deny",
		},
		{
			type: "session_permission_audit",
			actionId: "expired",
			source: "user",
			decision: "deny",
			reason: "review.unavailable",
		},
		{
			type: "session_permission_audit",
			actionId: "rule-denied",
			source: "policy",
			decision: "deny",
			reason: "rule.deny",
		},
	]);
	expect(decisions.get("allow-session")).toEqual({ source: "user", outcome: "allow", remember: "session" });
	expect(decisions.get("deny-project")).toEqual({ source: "user", outcome: "deny", remember: "project" });
	expect(decisions.get("expired")).toEqual({ source: "user", outcome: "unavailable" });
	expect(decisions.has("rule-denied")).toBe(false);
});

describe("inline interaction history", () => {
	it("keeps complete task and answer snapshots beyond the generic output preview", () => {
		const tasks = Array.from({ length: 100 }, (_, index) => ({
			task: `${index}: ${"待办".repeat(200)}`,
			completed: false,
		}));
		const answers = Array.from({ length: 4 }, (_, index) => ({
			question: `Question ${index}`,
			selected: [],
			customAnswer: "回答".repeat(2000),
		}));
		for (const [toolName, details, field, expected] of [
			["set_tasks", { tasks }, "tasks", tasks],
			["ask_user", { cancelled: false, answers }, "userAnswers", answers],
		] as const) {
			const projected = projectLiveMessage({
				itemId: toolName,
				sessionId: "session-1",
				turnId: "turn-1",
				state: "completed",
				fallbackTimestamp: CREATED_AT,
				message: {
					role: "toolResult",
					toolCallId: toolName,
					toolName,
					isError: false,
					details,
					content: [{ type: "text", text: JSON.stringify(expected) }],
				},
			});
			const block = projected?.content[0];
			expect(block?.type).toBe("tool_result");
			if (block?.type !== "tool_result") throw new Error("Missing tool result");
			expect(block[field]).toEqual(expected);
			expect(Buffer.byteLength(block.output)).toBeLessThanOrEqual(16 * 1024);
		}
	});
});
