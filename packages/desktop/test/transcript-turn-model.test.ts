import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import {
	actionSummary,
	buildCodeTurnPresentation,
	buildTurnPresentation,
	commandText,
	messageText,
	type ToolCallBlock,
	type ToolResultBlock,
	toolTranscriptPresentation,
} from "../src/renderer/components/transcript-turn-model.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "turn-model";

function item(itemId: string, role: ItemView["role"], content: ItemContentBlockView[]): ItemView {
	return {
		itemId,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		role,
		state: "completed",
		content,
		createdAt: "2026-07-28T00:00:00.000Z",
		completedAt: "2026-07-28T00:00:01.000Z",
	};
}

const turnItems: ItemView[] = [
	item("user-1", "user", [{ type: "text", text: "看看桌面有什么" }]),
	item("assistant-status", "assistant", [
		{ type: "thinking", text: "需要先取得目录访问权限。" },
		{ type: "text", text: "我需要先请求访问你的桌面文件夹才能查看里面的内容。" },
		{
			type: "tool_call",
			toolCallId: "tool-command",
			name: "run_command",
			state: "completed",
			inputPreview: JSON.stringify({ command: "find data -type f" }),
		},
	]),
	item("tool-result", "tool", [
		{ type: "tool_result", toolCallId: "tool-command", name: "run_command", isError: false, output: "file.txt" },
	]),
	item("assistant-final", "assistant", [{ type: "text", text: "桌面上有 file.txt" }]),
];

function call(name: string, input: unknown, state: ToolCallBlock["state"] = "completed"): ToolCallBlock {
	return {
		type: "tool_call",
		toolCallId: `call-${name}`,
		name,
		state,
		inputPreview: typeof input === "string" ? input : JSON.stringify(input),
	};
}

function result(name: string, output: string, isError = false): ToolResultBlock {
	return { type: "tool_result", toolCallId: `call-${name}`, name, isError, output };
}

describe("transcript turn presentation", () => {
	it("separates public answer text from thinking and pairs tool results", () => {
		const view = buildTurnPresentation(turnItems);
		expect(view.users.map((entry) => entry.itemId)).toEqual(["user-1"]);
		expect(view.segments.map((segment) => segment.type)).toEqual([
			"user",
			"activity",
			"intermediate",
			"activity",
			"answer",
		]);
		expect(view.segments[1]?.type === "activity" && view.segments[1].blocks[0]?.type).toBe("thinking");
		expect(view.segments[2]?.type === "intermediate" && view.segments[2].blocks.map((block) => block.text)).toEqual([
			"我需要先请求访问你的桌面文件夹才能查看里面的内容。",
		]);
		expect(view.final?.itemId).toBe("assistant-final");
		expect(view.results.get("tool-command")?.output).toBe("file.txt");
		expect(view.segments[3]?.type === "activity" && actionSummary(view.segments[3].calls)).toBe("Ran a command");
	});

	it("extracts display-safe command previews", () => {
		expect(commandText(JSON.stringify({ command: "find data -type f" }))).toBe("find data -type f");
		expect(commandText(JSON.stringify({ cmd: "pwd" }))).toBe("pwd");
		expect(commandText("pwd")).toBe("pwd");
	});

	it("keeps operation and external tool details available", () => {
		expect(
			toolTranscriptPresentation(
				call("grep", { pattern: "token", path: "src" }),
				result("grep", "src/auth.ts:12: token"),
			),
		).toMatchObject({
			rawInput: JSON.stringify({ pattern: "token", path: "src" }),
			rawOutput: "src/auth.ts:12: token",
			rawOutputIsError: false,
		});
		expect(
			toolTranscriptPresentation(
				call("mcp__docs__search", { query: "refresh token" }),
				result("mcp__docs__search", "external result"),
			),
		).toMatchObject({ rawOutput: "external result" });
	});

	it("summarizes set_tasks without inventing execution results", () => {
		const presentation = toolTranscriptPresentation(
			call("set_tasks", {
				tasks: [
					{ task: "Inspect implementation", completed: true },
					{ task: "Run validation", completed: false },
				],
			}),
			result("set_tasks", "<task_list>\n- [x] Inspect implementation\n- [ ] Run validation\n</task_list>"),
		);
		expect(presentation.label).toBe("Updated task list · 1/2 completed");
		expect(presentation.detailLines.map((line) => line.value)).toEqual([
			"✓ Inspect implementation",
			"○ Run validation",
		]);
		expect(presentation.rawInput).toBeUndefined();
		expect(presentation.rawOutput).toBeUndefined();
	});

	it("shows only ask_user questions and answers", () => {
		const presentation = toolTranscriptPresentation(
			call("ask_user", {
				questions: [
					{
						question: "How should Metis answer?",
						multiple: false,
						options: [
							{ label: "Concise", description: "Short response" },
							{ label: "Detailed", description: "Long response" },
						],
					},
				],
			}),
			result(
				"ask_user",
				`User answers:\n${JSON.stringify(
					[
						{
							question: "How should Metis answer?",
							selected: ["Concise"],
							customAnswer: "Summary first",
						},
					],
					null,
					2,
				)}`,
			),
		);
		expect(presentation.label).toBe("Asked user");
		expect(presentation.detailLines).toEqual([
			{ label: "Question", value: "How should Metis answer?" },
			{ label: "Answer", value: "Concise · Summary first" },
		]);
		expect(JSON.stringify(presentation)).not.toMatch(/multiple|options|description|selected/iu);
	});

	it("presents the asynchronous spawn receipt without legacy mode fields or identifiers", () => {
		const spawned = toolTranscriptPresentation(
			call("spawn_agent", {
				name: "Login flow audit",
				task: "Inspect refresh-token handling",
				agentType: "explorer",
			}),
			result(
				"spawn_agent",
				JSON.stringify({
					agentId: "child-secret",
					taskId: "task-secret",
					name: "Login flow audit",
					status: "running",
				}),
			),
		);
		expect(spawned.label).toBe("Spawned agent · Login flow audit");
		expect(spawned.detailLines).toEqual([
			{ label: "Task", value: "Inspect refresh-token handling" },
			{ label: "Status", value: "running" },
		]);
		expect(JSON.stringify(spawned)).not.toMatch(/child-secret|task-secret|agentType/iu);
	});

	it("summarizes the remaining agent controls", () => {
		const inspected = toolTranscriptPresentation(
			call("inspect_agents", { agentId: "child-secret" }),
			result(
				"inspect_agents",
				[
					'Agent "Login flow audit" (child-secret) · explorer · done',
					"Task task-secret · Inspect token refresh",
					"",
					"[LLM] Refresh path checked",
					"[Tool success] read",
				].join("\n"),
			),
		);
		expect(inspected.label).toBe("Inspected 1 agents");
		expect(inspected.detailLines.map((line) => line.value)).toEqual([
			'Agent "Login flow audit" (child-secret) · explorer · done',
			"Task task-secret · Inspect token refresh",
			"[LLM] Refresh path checked",
			"[Tool success] read",
		]);

		const messaged = toolTranscriptPresentation(
			call("followup_task", {
				agentId: "child-secret",
				task: "Verify the regression",
			}),
			result("followup_task", JSON.stringify({ agentId: "child-secret", status: "queued" })),
		);
		expect(messaged.label).toBe("Sent agent follow-up");
		expect(messaged.detailLines).toEqual([
			{ label: "Task", value: "Verify the regression" },
			{ label: "Status", value: "queued" },
		]);

		const interrupted = toolTranscriptPresentation(
			call("interrupt_agent", { agentId: "child-secret" }),
			result(
				"interrupt_agent",
				JSON.stringify({
					agentId: "child-secret",
					name: "Login flow audit",
					status: "stopped",
					taskSummary: "Inspect refresh",
				}),
			),
		);
		expect(interrupted.label).toBe("Interrupted agent · Login flow audit");
		expect(interrupted.detailLines).toContainEqual({ label: "Task", value: "Inspect refresh" });
		expect(JSON.stringify(interrupted)).not.toContain("child-secret");

		const waited = toolTranscriptPresentation(
			call("wait_agents", { agentIds: ["child-secret"] }),
			result("wait_agents", "Login flow audit · done"),
		);
		expect(waited.label).toBe("Waited for agents");
		expect(waited.detailLines).toEqual([{ value: "Login flow audit · done" }]);
	});

	it("summarizes tool search and folder access without structural JSON", () => {
		const search = toolTranscriptPresentation(
			call("tool_search", { query: "PDF extraction", limit: 8 }),
			result("tool_search", "read_pdf: Read PDF files\nextract_tables: Extract tables"),
		);
		expect(search.detailLines).toEqual([
			{ label: "Query", value: "PDF extraction" },
			{ label: "Matches", value: "read_pdf, extract_tables" },
		]);
		expect(JSON.stringify(search)).not.toMatch(/serverName|rawName|modelName/iu);

		const folder = toolTranscriptPresentation(
			call("request_cowork_directory", {}),
			result("request_cowork_directory", "/Users/ent/Desktop"),
		);
		expect(folder.detailLines).toEqual([{ label: "Folder", value: "/Users/ent/Desktop" }]);
	});

	it("never falls back to structured JSON for failed or orphan internal tools", () => {
		const failed = toolTranscriptPresentation(
			call("ask_user", { questions: [] }),
			result("ask_user", JSON.stringify({ internal_error_code: "ASK_FAILED", details: { retry: false } }), true),
		);
		expect(failed.label).toBe("Failed to ask user");
		expect(JSON.stringify(failed)).not.toContain("internal_error_code");

		const shortFailure = toolTranscriptPresentation(
			call("spawn_agent", { name: "Audit", task: "Inspect", tools: [], background: true }),
			result("spawn_agent", "Permission denied", true),
		);
		expect(shortFailure.detailLines).toContainEqual({ value: "Permission denied" });

		const orphan = toolTranscriptPresentation(
			undefined,
			result(
				"interrupt_agent",
				JSON.stringify({
					agentId: "child-secret",
					name: "Login flow audit",
					status: "stopped",
					taskSummary: "Inspect refresh",
				}),
			),
		);
		expect(orphan.label).toBe("Interrupted agent · Login flow audit");
		expect(JSON.stringify(orphan)).not.toMatch(/child-secret|private\/internal/iu);

		const malformed = toolTranscriptPresentation(
			undefined,
			result("inspect_agents", JSON.stringify({ journal: [{ secret: "hidden" }] })),
		);
		expect(malformed.detailLines).toEqual([{ value: "Details unavailable" }]);
		expect(JSON.stringify(malformed)).not.toContain("hidden");
	});

	it("collects deliver_file results and hides them from activity", () => {
		const deliveredFile = {
			fileId: "aaaaaaaaaaaaaaaa",
			name: "report.xlsx",
			byteLength: 4096,
			deliveredAt: "2026-08-18T00:00:00.000Z",
			availability: "available" as const,
		};
		const items: ItemView[] = [
			item("user-deliver", "user", [{ type: "text", text: "send the file" }]),
			item("assistant-deliver", "assistant", [
				{
					type: "tool_call",
					toolCallId: "call-deliver",
					name: "deliver_file",
					state: "completed",
					inputPreview: JSON.stringify({ path: "report.xlsx" }),
				},
			]),
			item("tool-deliver", "tool", [
				{
					type: "tool_result",
					toolCallId: "call-deliver",
					name: "deliver_file",
					isError: false,
					output: "Delivered",
					deliveredFile,
				},
			]),
			item("assistant-final-deliver", "assistant", [{ type: "text", text: "文件已发送。" }]),
		];
		const view = buildTurnPresentation(items);
		expect(view.deliveredFiles).toEqual([deliveredFile]);
		expect(
			view.segments.every(
				(segment) => segment.type !== "activity" || segment.calls.every((call) => call.name !== "deliver_file"),
			),
		).toBe(true);
	});

	it("places a same-turn steer after earlier assistant content", () => {
		const items: ItemView[] = [
			item("user-1", "user", [{ type: "text", text: "写一篇介绍" }]),
			item("assistant-1", "assistant", [{ type: "text", text: "这是第一段。" }]),
			item("user-steer", "user", [{ type: "text", text: "改成更短" }]),
		];
		const chat = buildTurnPresentation(items);
		expect(chat.segments.map((segment) => segment.type)).toEqual(["user", "answer", "user"]);
		expect(
			chat.segments.map((segment) =>
				segment.type === "user" || segment.type === "answer" ? segment.item.itemId : segment.type,
			),
		).toEqual(["user-1", "assistant-1", "user-steer"]);
		expect(chat.final?.itemId).toBe("assistant-1");

		const code = buildCodeTurnPresentation(items);
		expect(code.segments.map((segment) => segment.type)).toEqual(["user", "content", "user"]);
		expect(code.segments[1]?.type === "content" && code.segments[1].answer).toBe(true);
		expect(code.segments[2]?.type === "user" && code.segments[2].item.itemId).toBe("user-steer");
	});

	it("keeps a later assistant reply after the steer", () => {
		const items: ItemView[] = [
			item("user-1", "user", [{ type: "text", text: "写一篇介绍" }]),
			item("assistant-1", "assistant", [{ type: "text", text: "这是第一段。" }]),
			item("user-steer", "user", [{ type: "text", text: "改成更短" }]),
			item("assistant-2", "assistant", [{ type: "text", text: "更短的介绍。" }]),
		];
		const chat = buildTurnPresentation(items);
		expect(chat.segments.map((segment) => segment.type)).toEqual(["user", "intermediate", "user", "answer"]);
		expect(chat.final?.itemId).toBe("assistant-2");
		expect(chat.segments[1]?.type === "intermediate" && chat.segments[1].blocks.map((block) => block.text)).toEqual([
			"这是第一段。",
		]);

		const code = buildCodeTurnPresentation(items);
		expect(code.segments.map((segment) => segment.type)).toEqual(["user", "content", "user", "content"]);
		expect(code.segments[1]?.type === "content" && code.segments[1].answer).toBe(false);
		expect(code.segments[3]?.type === "content" && code.segments[3].answer).toBe(true);
	});

	it("keeps plan blocks out of ordinary assistant text presentation", () => {
		const items: ItemView[] = [
			item("plan-item", "assistant", [
				{
					type: "plan",
					plan: {
						planId: "plan-1",
						revision: 1,
						title: "Safe plan",
						markdown: "# Plan",
						status: "proposed",
						createdAt: "2026-08-18T00:00:00.000Z",
					},
				},
			]),
		];
		const chat = buildTurnPresentation(items);
		expect(chat.segments).toEqual([]);
		const code = buildCodeTurnPresentation(items);
		expect(code.segments).toEqual([]);
		expect(messageText(items[0]!)).toBe("");
	});
});
