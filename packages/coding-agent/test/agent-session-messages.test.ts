import type { AgentMessage } from "@metis/agent-core";
import type { AssistantMessage, Message } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import {
	findLastAssistantMessage,
	getLastAssistantText,
	getUserMessageText,
	normalizePromptGuidelines,
	normalizePromptSnippet,
	replaceMessageInPlace,
} from "../src/core/agent-session-messages.ts";

function userMessage(content: unknown): Message {
	return { role: "user", content, timestamp: 0 } as unknown as Message;
}

function assistantMessage(overrides: Record<string, unknown> = {}): AssistantMessage {
	return {
		role: "assistant",
		provider: "provider",
		model: "model",
		timestamp: 0,
		content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		...overrides,
	} as unknown as AssistantMessage;
}

function agentMessage(message: AssistantMessage): AgentMessage {
	return message as unknown as AgentMessage;
}

describe("agent session messages", () => {
	it("extracts user text from strings and text blocks", () => {
		expect(getUserMessageText(userMessage("hello"))).toBe("hello");
		expect(
			getUserMessageText(
				userMessage([
					{ type: "text", text: "one " },
					{ type: "image", data: "x", mediaType: "image/png" },
					{ type: "text", text: "two" },
				]),
			),
		).toBe("one two");
		expect(getUserMessageText(assistantMessage())).toBe("");
	});

	it("finds the last assistant message", () => {
		const first = assistantMessage({ timestamp: 1 });
		const last = assistantMessage({ timestamp: 2 });
		expect(findLastAssistantMessage([userMessage("hi"), agentMessage(first), agentMessage(last)])).toBe(last);
		expect(findLastAssistantMessage([userMessage("hi")])).toBeUndefined();
	});

	it("replaces a message object in place and keeps identity", () => {
		const target = assistantMessage({ content: [{ type: "text", text: "old" }] });
		const replacement = assistantMessage({ content: [{ type: "text", text: "new" }] });
		replaceMessageInPlace(target as unknown as AgentMessage, replacement as unknown as AgentMessage);
		expect(target).not.toBe(replacement);
		expect(target).toEqual(replacement);
		const same = assistantMessage();
		replaceMessageInPlace(same as unknown as AgentMessage, same as unknown as AgentMessage);
		expect(same).toEqual(assistantMessage());
	});

	it("normalizes prompt snippets and guidelines", () => {
		expect(normalizePromptSnippet(undefined)).toBeUndefined();
		expect(normalizePromptSnippet("  a\n b\t c  ")).toBe("a b c");
		expect(normalizePromptSnippet("   ")).toBeUndefined();
		expect(normalizePromptGuidelines(undefined)).toEqual([]);
		expect(normalizePromptGuidelines([" a ", "", "b", "a"])).toEqual(["a", "b"]);
	});

	it("returns the last non-empty assistant text", () => {
		const aborted = assistantMessage({ stopReason: "aborted", content: [] });
		const withText = assistantMessage({ content: [{ type: "text", text: " answer " }] });
		expect(getLastAssistantText([agentMessage(withText), agentMessage(aborted)])).toBe("answer");
		expect(getLastAssistantText([agentMessage(aborted)])).toBeUndefined();
		expect(getLastAssistantText([])).toBeUndefined();
	});
});
