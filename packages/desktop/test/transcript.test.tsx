// @vitest-environment jsdom

import type { ItemContentBlockView, ItemView } from "@arcmind/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { shouldAdjustTranscriptScroll, shouldFollowTranscript, Transcript } from "../src/renderer/components/Transcript.tsx";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "turn-1";
const LONG_THINKING = "用户希望查看桌面内容。我需要先取得目录访问，然后运行命令确认文件列表。".repeat(12);

function item(
	itemId: string,
	role: ItemView["role"],
	content: ItemContentBlockView[],
	state: ItemView["state"] = "completed",
): ItemView {
	return {
		itemId,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		role,
		state,
		content,
		createdAt: "2026-07-22T00:00:00.000Z",
		...(state === "completed" ? { completedAt: "2026-07-22T00:00:01.000Z" } : {}),
	};
}

const turnItems: ItemView[] = [
	item("user-1", "user", [{ type: "text", text: "看看桌面有什么" }]),
	item("assistant-plan", "assistant", [
		{ type: "thinking", text: LONG_THINKING },
		{ type: "text", text: "我需要先请求访问你的桌面文件夹才能查看里面的内容。" },
		{
			type: "tool_call",
			toolCallId: "tool-folder",
			name: "request_cowork_directory",
			state: "completed",
		},
	]),
	item("folder-result", "tool", [
		{ type: "tool_result", toolCallId: "tool-folder", name: "request_cowork_directory", isError: false, output: "/Users/ent/Desktop" },
	]),
	item("assistant-command", "assistant", [
		{ type: "thinking", text: "目录已经连接，现在列出其中的文件。" },
		{
			type: "tool_call",
			toolCallId: "tool-command",
			name: "bash",
			state: "completed",
			inputPreview: JSON.stringify({ command: "ls -la /Users/ent/Desktop" }),
		},
	]),
	item("command-result", "tool", [
		{ type: "tool_result", toolCallId: "tool-command", name: "bash", isError: false, output: "file.txt" },
	]),
	item("assistant-synthesis", "assistant", [{ type: "thinking", text: "文件列表已经取得，整理为简洁回答。" }]),
	item("assistant-final", "assistant", [{ type: "text", text: "桌面上有 file.txt。" }]),
];

afterEach(() => document.body.replaceChildren());

describe("TranscriptTurn", () => {
	it("matches the collapsed, capped, show-more, and nested-command states", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={turnItems} />));

		const chain = container.querySelector<HTMLDetailsElement>("details.execution-chain");
		expect(chain).not.toBeNull();
		expect(chain!.open).toBe(false);
		expect(chain!.querySelector(":scope > summary")?.textContent).toContain("Ran a command, used a tool");
		expect(chain!.querySelector(".execution-chain-caret")).not.toBeNull();
		expect(chain!.querySelector(".tool-step-static")?.textContent).toContain("Asked to access a folder");
		expect(chain!.querySelector("details.tool-step:not(.tool-step-command)")).toBeNull();
		expect(chain!.querySelector(".tool-step-command > summary")?.textContent).toContain("Ran command");
		expect(container.querySelector(".turn-thought-label")).toBeNull();
		const intermediate = [...container.querySelectorAll("p")].find((node) => node.textContent?.startsWith("我需要先请求访问"));
		expect(intermediate).toBeDefined();
		expect(chain!.contains(intermediate!)).toBe(false);

		const final = [...container.querySelectorAll("p")].find((node) => node.textContent === "桌面上有 file.txt。");
		expect(final).toBeDefined();
		expect(final!.closest("[data-transcript-answer]")).not.toBeNull();
		expect(chain!.contains(final!)).toBe(false);

		await act(async () => chain!.querySelector(":scope > summary")!.click());
		expect(chain!.open).toBe(true);
		expect(chain!.textContent).toContain("用户希望查看桌面内容");
		expect(chain!.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(true);
		expect(chain!.querySelector(".execution-chain-done")).toBeNull();
		const showMore = [...chain!.querySelectorAll("button")].find((node) => node.textContent === "Show more");
		expect(showMore).toBeDefined();
		await act(async () => showMore!.click());
		expect(chain!.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(false);
		const showLess = [...chain!.querySelectorAll("button")].find((node) => node.textContent === "Show less");
		expect(showLess).toBeDefined();
		const done = chain!.querySelector(".execution-chain-done");
		expect(done).not.toBeNull();
		expect(done!.compareDocumentPosition(showLess!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		await act(async () => showLess!.click());
		expect(chain!.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(true);

		const command = chain!.querySelector<HTMLDetailsElement>("details.tool-step-command");
		expect(command).not.toBeNull();
		expect(command!.open).toBe(false);

		await act(async () => command!.querySelector("summary")!.click());
		expect(command!.open).toBe(true);
		expect(command!.textContent).toContain("ls -la /Users/ent/Desktop");
		expect(command!.textContent).toContain("file.txt");

		await act(async () => chain!.querySelector(":scope > summary")!.click());
		expect(chain!.open).toBe(false);
		expect(chain!.querySelector(".execution-chain-content")?.classList.contains("is-capped")).toBe(true);

		await act(async () => root.unmount());
	});

	it("does not add a thought process to a plain answer", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={[
			item("plain-user", "user", [{ type: "text", text: "你好" }]),
			item("plain-answer", "assistant", [{ type: "text", text: "你好！" }]),
		]} />));
		expect(container.querySelector(".execution-chain")).toBeNull();
		expect(container.querySelector(".turn-thought-label")).toBeNull();
		expect(container.textContent).toContain("你好！");
		await act(async () => root.unmount());
	});

	it("does not repeat a thinking echo as intermediate assistant text", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const echoedPrefix = "我需要先检查当前工具并确认配置。".repeat(8);
		await act(async () => root.render(<TranscriptTurn items={[
			item("echo-user", "user", [{ type: "text", text: "检查工具" }]),
			item("echo-assistant", "assistant", [
				{ type: "thinking", text: `${echoedPrefix}重新启动会话或重新加载配置` },
				{ type: "text", text: `${echoedPrefix}重新启动会话或重新配置\n` },
				{ type: "tool_call", toolCallId: "echo-tool", name: "read", state: "completed" },
			]),
			item("echo-result", "tool", [
				{ type: "tool_result", toolCallId: "echo-tool", name: "read", isError: false, output: "ok" },
			]),
			item("echo-final", "assistant", [{ type: "text", text: "工具检查完成。" }]),
		]} />));

		expect(container.querySelector(".turn-intermediate")).toBeNull();
		expect(container.querySelector(".execution-chain")?.textContent).toContain("重新加载配置");
		expect(container.querySelector("[data-transcript-answer]")?.textContent).toContain("工具检查完成。");
		await act(async () => root.unmount());
	});

	it("does not flash a streaming thinking echo as the final answer", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const echoed = "我需要先检查当前工具并确认配置。".repeat(8);
		await act(async () => root.render(<TranscriptTurn items={[
			item("stream-echo-user", "user", [{ type: "text", text: "检查工具" }]),
			item("stream-echo-assistant", "assistant", [
				{ type: "thinking", text: echoed },
				{ type: "text", text: echoed },
			], "streaming"),
		]} />));

		expect(container.querySelector("[data-transcript-answer]")).toBeNull();
		expect(container.querySelector(".execution-chain")?.textContent).toContain(echoed);
		await act(async () => root.render(<TranscriptTurn items={[
			item("stream-echo-user", "user", [{ type: "text", text: "检查工具" }]),
			item("stream-echo-assistant", "assistant", [
				{ type: "thinking", text: echoed },
				{ type: "text", text: echoed },
				{ type: "tool_call", toolCallId: "stream-echo-tool", name: "read", state: "running" },
			], "streaming"),
		]} />));
		expect(container.querySelector(".execution-chain")?.textContent).toContain(echoed);
		expect(container.querySelector(".turn-intermediate")).toBeNull();
		await act(async () => root.unmount());
	});

	it("does not invent a result for a running tool call", async () => {
		const running = [
			turnItems[0]!,
			item("assistant-running", "assistant", [
				{ type: "thinking", text: "我正在读取桌面目录。" },
				{ type: "tool_call", toolCallId: "tool-running", name: "bash", state: "running", inputPreview: "pwd" },
			], "streaming"),
		];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={running} />));
		const command = container.querySelector<HTMLDetailsElement>(".tool-step-command");
		expect(command?.textContent).toContain("Running command");
		expect(command?.querySelector(".tool-step-output")).toBeNull();
		await act(async () => root.unmount());
	});

	it("renders assistant Markdown without executing raw HTML or unsafe links", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<TranscriptTurn items={[
			item("markdown-user", "user", [{ type: "text", text: "Format this" }]),
			item("markdown-answer", "assistant", [{
				type: "text",
				text: "**Bold**\n\n- one\n- two\n\n```ts\nconst safe = true;\n```\n\n[docs](https://example.com) [bad](javascript:alert(1)) [protocol-relative](//example.com) <script>boom()</script>",
			}]),
		]} />));

		const answer = container.querySelector("[data-transcript-answer]")!;
		expect(answer.querySelector("strong")?.textContent).toBe("Bold");
		expect([...answer.querySelectorAll("li")].map((node) => node.textContent)).toEqual(["one", "two"]);
		expect(answer.querySelector("pre code")?.textContent).toContain("const safe = true;");
		expect(answer.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')).not.toBeNull();
		expect([...answer.querySelectorAll("a")].find((node) => node.textContent === "bad")?.hasAttribute("href")).toBe(false);
		expect([...answer.querySelectorAll("a")].find((node) => node.textContent === "protocol-relative")?.hasAttribute("href")).toBe(false);
		expect(answer.querySelector("script")).toBeNull();
		expect(answer.textContent).toContain("<script>boom()</script>");
		await act(async () => root.unmount());
	});

	it("defers Markdown parsing until a streaming answer settles", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (state: ItemView["state"]) => root.render(<TranscriptTurn items={[
			item("stream-user", "user", [{ type: "text", text: "Stream" }]),
			item("stream-answer", "assistant", [{ type: "text", text: "**Working**" }], state),
		]} />);

		await act(async () => render("streaming"));
		expect(container.querySelector("[data-transcript-answer] strong")).toBeNull();
		expect(container.querySelector("[data-transcript-answer]")?.textContent).toBe("**Working**");
		await act(async () => render("completed"));
		expect(container.querySelector("[data-transcript-answer] strong")?.textContent).toBe("Working");
		await act(async () => root.unmount());
	});
});

describe("Transcript", () => {
	it("only compensates row resizing when the entire row is above the viewport", () => {
		expect(shouldAdjustTranscriptScroll(80, 82)).toBe(true);
		expect(shouldAdjustTranscriptScroll(582, 82)).toBe(false);
	});

	it("follows streaming output only while the viewport is near the end", () => {
		expect(shouldFollowTranscript(1_000, 352, 600)).toBe(true);
		expect(shouldFollowTranscript(1_000, 351, 600)).toBe(false);
	});

	it("groups a Chat turn and preserves disclosure state across streaming updates", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const itemIds = turnItems.map((entry) => entry.itemId);
		const itemsById = new Map(turnItems.map((entry) => [entry.itemId, entry]));
		await act(async () => root.render(
			<Transcript appearance="chat" hasOlder={false} itemIds={itemIds} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
		const chain = container.querySelector<HTMLDetailsElement>(".execution-chain")!;
		await act(async () => chain.querySelector("summary")!.click());
		expect(chain.open).toBe(true);

		itemsById.set("assistant-plan", {
			...itemsById.get("assistant-plan")!,
			content: itemsById.get("assistant-plan")!.content.map((block) =>
				block.type === "thinking" ? { ...block, text: `${block.text}正在执行。` } : block,
			),
		});
		await act(async () => root.render(
			<Transcript appearance="chat" hasOlder={false} itemIds={itemIds} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		expect(container.querySelector<HTMLDetailsElement>(".execution-chain")!.open).toBe(true);
		expect(container.textContent).toContain("正在执行。");
		await act(async () => root.unmount());
	});

	it("groups a Code turn and renders a compact tool execution disclosure", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const itemsById = new Map(turnItems.map((entry) => [entry.itemId, entry]));
		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={turnItems.map((entry) => entry.itemId)} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		expect(container.querySelector(".execution-chain")).toBeNull();
		expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
		expect(container.querySelector(".code-turn-user")?.textContent).toContain("看看桌面有什么");
		expect(container.querySelector(".code-execution > summary")?.textContent).toContain("Ran a command, used a tool");
		expect(container.querySelector(".code-turn-answer")?.textContent).toContain("桌面上有 file.txt");
		expect(container.textContent).not.toContain(LONG_THINKING);

		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		expect(execution.open).toBe(false);
		expect(execution.querySelector(".code-execution-card")).toBeNull();
		await act(async () => execution.querySelector(":scope > summary")!.click());
		expect(execution.open).toBe(true);
		const command = execution.querySelector<HTMLDetailsElement>(".code-command-shell")!;
		expect(command.open).toBe(true);
		expect(command.textContent).toContain("ls -la /Users/ent/Desktop");
		expect(command.textContent).toContain("file.txt");
		await act(async () => root.unmount());
	});

	it("groups consecutive Code tools in the current turn until public assistant text appears", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const withCodeTurn = (entry: ItemView): ItemView => ({ ...entry, turnId: "code-turn" });
		const codeItems = [
			withCodeTurn(item("code-user", "user", [{ type: "text", text: "重试并检查工具" }])),
			withCodeTurn(item("code-tool-1", "assistant", [
				{ type: "tool_call", toolCallId: "tool-1", name: "read", state: "completed" },
			])),
			withCodeTurn(item("code-result-1", "tool", [
				{ type: "tool_result", toolCallId: "tool-1", name: "read", isError: false, output: "one" },
			])),
			withCodeTurn(item("code-tool-2", "assistant", [
				{ type: "tool_call", toolCallId: "tool-2", name: "grep", state: "completed" },
			])),
			withCodeTurn(item("code-result-2", "tool", [
				{ type: "tool_result", toolCallId: "tool-2", name: "grep", isError: false, output: "two" },
			])),
			withCodeTurn(item("code-tool-3", "assistant", [
				{ type: "tool_call", toolCallId: "tool-3", name: "web_fetch", state: "completed" },
			])),
			withCodeTurn(item("code-result-3", "tool", [
				{ type: "tool_result", toolCallId: "tool-3", name: "web_fetch", isError: false, output: "three" },
			])),
		];
		const itemsById = new Map(codeItems.map((entry) => [entry.itemId, entry]));

		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={codeItems.map((entry) => entry.itemId)} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));

		expect(container.querySelectorAll(".code-execution")).toHaveLength(1);
		expect(container.querySelector(".code-execution > summary")?.textContent).toContain("Used 3 tools");

		const separatedItems = [
			...codeItems.slice(0, 5),
			withCodeTurn(item("code-public-text", "assistant", [{ type: "text", text: "前两个工具完成，继续检查。" }])),
			...codeItems.slice(5),
		];
		const separatedById = new Map(separatedItems.map((entry) => [entry.itemId, entry]));
		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={separatedItems.map((entry) => entry.itemId)} itemsById={separatedById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		expect(container.querySelectorAll(".code-execution")).toHaveLength(2);
		expect(container.textContent).toContain("前两个工具完成，继续检查。");
		await act(async () => root.unmount());
	});

	it("keeps Code disclosure state across streaming updates and never invents tool output", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const running = item("assistant-code-running", "assistant", [
			{ type: "tool_call", toolCallId: "code-running", name: "bash", state: "running", inputPreview: "pwd" },
		], "streaming");
		const itemIds = [turnItems[0]!.itemId, running.itemId];
		const itemsById = new Map([turnItems[0]!, running].map((entry) => [entry.itemId, entry]));

		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={itemIds} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		expect(execution.open).toBe(true);
		expect(execution.textContent).toContain("Running a command");
		expect(execution.querySelector(".code-command-output")).toBeNull();

		itemsById.set(running.itemId, {
			...running,
			content: [{ type: "tool_call", toolCallId: "code-running", name: "bash", state: "running", inputPreview: "pwd && whoami" }],
		});
		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={itemIds} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		expect(container.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
		expect(container.querySelector<HTMLDetailsElement>(".code-execution")!.open).toBe(true);
		expect(container.textContent).toContain("pwd && whoami");
		await act(async () => root.unmount());
	});

	it("renders Code errors and completed Markdown tables without exposing thinking", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const codeItems = [
			item("code-error-user", "user", [{ type: "text", text: "Count files" }]),
			item("code-error-call", "assistant", [
				{ type: "thinking", text: LONG_THINKING },
				{ type: "tool_call", toolCallId: "code-error", name: "bash", state: "completed", inputPreview: "find data" },
			]),
			item("code-error-result", "tool", [
				{ type: "tool_result", toolCallId: "code-error", name: "bash", isError: true, output: "Permission denied" },
			]),
			item("code-error-final", "assistant", [{ type: "text", text: "| Type | Count |\n| --- | ---: |\n| video | 10 |" }]),
		];
		const itemsById = new Map(codeItems.map((entry) => [entry.itemId, entry]));
		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={codeItems.map((entry) => entry.itemId)} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		const execution = container.querySelector<HTMLDetailsElement>(".code-execution")!;
		await act(async () => execution.querySelector(":scope > summary")!.click());
		expect(container.querySelector(".code-command-output-error")?.textContent).toContain("Permission denied");
		expect(container.querySelector(".code-turn-answer table")?.textContent).toContain("video");
		expect(container.textContent).not.toContain(LONG_THINKING);
		await act(async () => root.unmount());
	});
});
