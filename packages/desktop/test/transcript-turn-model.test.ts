import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { actionSummary, buildTurnPresentation, commandText } from "../src/renderer/components/transcript-turn-model.ts";

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

describe("transcript turn presentation", () => {
	it("separates public answer text from thinking and pairs tool results", () => {
		const view = buildTurnPresentation(turnItems);
		expect(view.users.map((entry) => entry.itemId)).toEqual(["user-1"]);
		expect(view.activity.some((block) => block.type === "thinking")).toBe(true);
		expect(view.intermediateText.map((block) => block.text)).toEqual([
			"我需要先请求访问你的桌面文件夹才能查看里面的内容。",
		]);
		expect(view.final?.itemId).toBe("assistant-final");
		expect(view.results.get("tool-command")?.output).toBe("file.txt");
		expect(actionSummary(view.calls)).toBe("Ran a command");
	});

	it("extracts display-safe command previews", () => {
		expect(commandText(JSON.stringify({ command: "find data -type f" }))).toBe("find data -type f");
		expect(commandText(JSON.stringify({ cmd: "pwd" }))).toBe("pwd");
		expect(commandText("pwd")).toBe("pwd");
	});
});
