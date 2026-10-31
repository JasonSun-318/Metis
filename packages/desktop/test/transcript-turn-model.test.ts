import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import {
	actionSummary,
	buildCodeTurnPresentation,
	buildTurnPresentation,
	commandText,
	isInternalAgentCoordinationItem,
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
	it.each([false, true])("keeps delivery and final thinking in one activity group (error: %s)", (isError) => {
		const deliveredFile = {
			fileId: "deck",
			sourcePath: "/workspace/deck.pptx",
			name: "deck.pptx",
			byteLength: 120,
			deliveredAt: "2026-10-30T00:00:00Z",
			availability: "available" as const,
		};
		const table = "| 页面 | 内容 |\n| --- | --- |\n| 1 | 简介 |";
		const view = buildTurnPresentation([
			turnItems[0]!,
			item("build-deck", "assistant", [{ type: "thinking", text: "制作并检查文件。" }, call("bash", "make deck")]),
			item("build-result", "tool", [result("bash", "ok")]),
			item("delivery", "assistant", [call("deliver_file", { path: "/workspace/deck.pptx" })]),
			item("delivery-result", "tool", [
				{
					...result("deliver_file", isError ? "failed" : "delivered", isError),
					...(!isError ? { deliveredFile } : {}),
				},
			]),
			item("final-deck", "assistant", [
				{ type: "thinking", text: "整理最终说明。" },
				{ type: "text", text: table },
			]),
		]);
		expect(view.segments.map((segment) => segment.type)).toEqual(["user", "activity", "answer"]);
		expect(view.segments[1]?.type === "activity" && view.segments[1].calls.map((tool) => tool.name)).toEqual([
			"bash",
			"deliver_file",
		]);
		expect(
			view.segments[1]?.type === "activity" && view.segments[1].blocks.filter((block) => block.type === "thinking"),
		).toHaveLength(2);
		expect(view.results.get("call-deliver_file")?.isError).toBe(isError);
		expect(view.deliveredFiles).toEqual(isError ? [] : [deliveredFile]);
		expect(view.final?.content).toContainEqual({ type: "text", text: table });
	});

	it.each(["", " \n\t"])("does not split a continuous tool sequence on blank assistant text %j", (blank) => {
		const steps = Array.from({ length: 20 }, (_, index) => [
			item(`assistant-step-${index}`, "assistant", [
				{ type: "thinking", text: `检查第 ${index + 1} 项。` },
				{ type: "text", text: blank },
				{ type: "tool_call", toolCallId: `tool-${index}`, name: "bash", state: "completed" },
			]),
			item(`result-${index}`, "tool", [
				{ type: "tool_result", toolCallId: `tool-${index}`, name: "bash", isError: false, output: "ok" },
			]),
		]).flat();
		const table = "| 项目 | 状态 |\n| --- | --- |\n| 检查 | 完成 |";
		const view = buildTurnPresentation([
			turnItems[0]!,
			...steps,
			item("public-table", "assistant", [{ type: "text", text: table }, call("ask_user", {}, "completed")]),
		]);
		expect(view.segments.map((segment) => segment.type)).toEqual(["user", "activity", "intermediate", "activity"]);
		expect(view.segments[1]?.type === "activity" && view.segments[1].calls).toHaveLength(20);
		expect(view.results.size).toBe(20);
		expect(view.segments[2]).toMatchObject({ blocks: [{ type: "text", text: table }] });
	});

	it("does not select an empty trailing assistant item as the final reply", () => {
		const entries = [...turnItems, item("empty-tail", "assistant", [{ type: "text", text: " \n" }])];
		expect(buildTurnPresentation(entries).final?.itemId).toBe("assistant-final");
		expect(buildCodeTurnPresentation(entries).final?.itemId).toBe("assistant-final");
	});

	it("keeps a public table outside activity before a same-message confirmation tool", () => {
		const table = "| 页面 | 内容 |\n| --- | --- |\n| 1 | 简介 |";
		const view = buildTurnPresentation([
			item("table-user", "user", [{ type: "text", text: "先确认结构" }]),
			item("table-assistant", "assistant", [
				{ type: "thinking", text: "整理结构后询问用户。" },
				{ type: "text", text: table },
				call("ask_user", { questions: [{ question: "这个结构可以吗？" }] }, "running"),
			]),
		]);
		expect(view.segments.map((segment) => segment.type)).toEqual(["user", "activity", "intermediate", "activity"]);
		expect(view.segments[2]).toMatchObject({ type: "intermediate", blocks: [{ type: "text", text: table }] });
		expect(
			view.segments.flatMap((segment) => (segment.type === "activity" ? segment.blocks : [])),
		).not.toContainEqual({ type: "text", text: table });
	});

	it("keeps streamed public text outside execution when a later tool arrives", () => {
		const progress = item("progress", "assistant", [{ type: "text", text: "我会先检查项目。" }]);
		const before = buildTurnPresentation([turnItems[0]!, progress]);
		expect(before.segments.at(-1)?.type).toBe("answer");
		const after = buildTurnPresentation([
			turnItems[0]!,
			{ ...progress, content: [...progress.content, call("bash", { command: "pwd" }, "running")] },
		]);
		expect(after.segments.map((segment) => segment.type)).toEqual(["user", "intermediate", "activity"]);
		expect(after.segments[1]).toMatchObject({ blocks: [{ type: "text", text: "我会先检查项目。" }] });
	});

	it("keeps a failed assistant notice visible without calling its partial output a final answer", () => {
		const failure: ItemView = {
			...item("provider-failure", "assistant", [
				{ type: "text", text: "Partial unfinished output" },
				{ type: "notice", level: "error", text: "The model provider could not complete the request." },
			]),
			state: "interrupted",
		};
		const failed = [turnItems[0]!, failure];
		const chat = buildTurnPresentation(failed);
		expect(chat.final).toBeUndefined();
		expect(chat.segments.map((segment) => segment.type)).toEqual(["user", "intermediate", "notice"]);
		expect(chat.segments.at(-1)).toMatchObject({ type: "notice", block: { level: "error" } });
		const code = buildCodeTurnPresentation(failed);
		expect(code.final).toBeUndefined();
		expect(code.segments.at(-1)).toMatchObject({ type: "content", answer: false });
		expect(JSON.stringify(code.segments)).toContain("The model provider could not complete the request.");

		const recovered = [...failed, turnItems.at(-1)!];
		const recoveredChat = buildTurnPresentation(recovered);
		expect(recoveredChat.final?.itemId).toBe("assistant-final");
		expect(recoveredChat.segments.map((segment) => segment.type)).toEqual([
			"user",
			"intermediate",
			"notice",
			"answer",
		]);
		expect(buildCodeTurnPresentation(recovered).final?.itemId).toBe("assistant-final");
	});

	it("excludes only identified mailbox events without changing their durable content or the final answer", () => {
		const mailbox: ItemView = {
			...item("mailbox-terminal", "system", [{ type: "text", text: "Worker: done\nInternal result" }]),
			origin: { kind: "system", eventId: "terminal-event" },
			agentTargetId: "22222222-2222-4222-8222-222222222222",
		};
		const intervention: ItemView = {
			...mailbox,
			itemId: "mailbox-intervention",
			agentMessageId: "human-message",
			content: [{ type: "text", text: "You sent a message to Worker: stop" }],
		};
		const items = [...turnItems.slice(0, -1), intervention, turnItems.at(-1)!, mailbox];
		expect(buildTurnPresentation(items)).toEqual(buildTurnPresentation(turnItems));
		expect(buildCodeTurnPresentation(items)).toEqual(buildCodeTurnPresentation(turnItems));
		expect(items).toHaveLength(turnItems.length + 2);
		expect(mailbox.content).toEqual([{ type: "text", text: "Worker: done\nInternal result" }]);
		expect(isInternalAgentCoordinationItem(mailbox)).toBe(true);
		expect(isInternalAgentCoordinationItem(intervention)).toBe(true);
		expect(isInternalAgentCoordinationItem({ ...mailbox, agentTargetId: undefined })).toBe(false);
		expect(isInternalAgentCoordinationItem({ ...mailbox, origin: undefined })).toBe(false);
		expect(isInternalAgentCoordinationItem({ ...mailbox, role: "user" })).toBe(false);
		expect(isInternalAgentCoordinationItem({ ...mailbox, role: "assistant" })).toBe(false);
	});

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
		expect(view.segments[1]?.type === "activity" && view.segments[1].blocks.map((block) => block.type)).toEqual([
			"thinking",
		]);
		expect(view.segments[2]?.type === "intermediate" && view.segments[2].blocks[0]?.text).toBe(
			"我需要先请求访问你的桌面文件夹才能查看里面的内容。",
		);
		expect(view.final?.itemId).toBe("assistant-final");
		expect(view.results.get("tool-command")?.output).toBe("file.txt");
		expect(view.segments[3]?.type === "activity" && actionSummary(view.segments[3].calls)).toBe("Ran a command");

		const code = buildCodeTurnPresentation(turnItems);
		expect(code.segments.map((segment) => segment.type)).toEqual(["user", "tools", "content"]);
		expect(JSON.stringify(code.segments)).not.toContain("我需要先请求");
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

	it("presents memory_search recalls as note hits", () => {
		const running = toolTranscriptPresentation(
			call("memory_search", { query: "deploy freeze" }, "running"),
			undefined,
		);
		expect(running.label).toBe("Searching memory");

		const recalled = toolTranscriptPresentation(
			call("memory_search", { query: "deploy freeze" }),
			result(
				"memory_search",
				"2 memory note(s) matched:\n- [project/project] deploy-freeze — Deploy freeze policy (score 0.92, updated 2026-09-16)\n- [global/user] release-checklist — Release checklist (score 0.71, updated 2026-09-10)",
			),
		);
		expect(recalled.label).toBe("Recalled 2 memory notes");
		expect(recalled.detailLines).toEqual([
			{ label: "Query", value: "deploy freeze" },
			{ value: "- [project/project] deploy-freeze — Deploy freeze policy (score 0.92, updated 2026-09-16)" },
			{ value: "- [global/user] release-checklist — Release checklist (score 0.71, updated 2026-09-10)" },
		]);
		expect(recalled.rawOutput).toBeUndefined();

		const empty = toolTranscriptPresentation(
			call("memory_search", { query: "nothing" }),
			result("memory_search", "No memory notes matched."),
		);
		expect(empty.label).toBe("Searched memory");
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

	it("collects delivered files while retaining tool anchors for approvals", () => {
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
		expect(view.segments.flatMap((segment) => (segment.type === "activity" ? segment.calls : []))).toHaveLength(1);
		expect(
			buildCodeTurnPresentation(items).segments.flatMap((segment) =>
				segment.type === "tools" ? segment.calls : [],
			),
		).toHaveLength(1);
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
