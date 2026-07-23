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

	it("keeps Code mode on the existing raw-item transcript", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const itemsById = new Map(turnItems.map((entry) => [entry.itemId, entry]));
		await act(async () => root.render(
			<Transcript appearance="code" hasOlder={false} itemIds={turnItems.map((entry) => entry.itemId)} itemsById={itemsById} loadingOlder={false} onLoadOlder={async () => undefined} />,
		));
		expect(container.querySelector(".execution-chain")).toBeNull();
		expect(container.querySelectorAll("[data-transcript-item]")).toHaveLength(turnItems.length);
		expect(container.querySelectorAll(".tool-block")).toHaveLength(4);
		await act(async () => root.unmount());
	});
});
