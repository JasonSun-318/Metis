import { formatSessionConversationQuotes } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import { projectLiveMessage, projectMessageEntry } from "../src/item-projection.ts";

describe("conversation quote presentation", () => {
	it("preserves quote snapshots in live and restored messages without metadata in the bubble", () => {
		const quotes = [
			{ sourceItemId: "answer-1", sourceRole: "assistant" as const, selectedText: "Selected original answer" },
		];
		const content = formatSessionConversationQuotes("Explain this", quotes);
		const timestamp = "2026-10-15T00:00:00Z";
		const live = projectLiveMessage({
			itemId: "user-2",
			sessionId: "session-1",
			turnId: "turn-2",
			state: "completed",
			fallbackTimestamp: timestamp,
			message: { role: "user", content },
		})!;
		expect(live.content).toEqual([{ type: "text", text: "Explain this" }]);
		expect(live.conversationQuotes).toEqual(quotes);
		const restored = projectMessageEntry({
			entry: { type: "message", id: "user-2", turnId: "turn-2", timestamp, message: { role: "user", content } },
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: timestamp,
		});
		expect(restored).toEqual(live);
		expect(live.content.some((block) => block.type === "text" && block.text.includes("conversation_quotes"))).toBe(
			false,
		);
	});
	it("bounds Unicode preview bytes and reference count without altering model text", () => {
		const quote = { sourceItemId: "user-1", sourceRole: "user" as const, selectedText: "中文".repeat(2000) };
		const prompt = formatSessionConversationQuotes("Explain", [quote]);
		const project = (content: unknown) =>
			projectLiveMessage({
				itemId: "user-2",
				sessionId: "session-1",
				state: "completed",
				fallbackTimestamp: "2026-10-15T00:00:00Z",
				message: { role: "user", content },
			})!;
		const preview = project(prompt).conversationQuotes![0]!;
		expect(Buffer.byteLength(preview.selectedText, "utf8")).toBeLessThanOrEqual(2048);
		expect(preview.selectedText).not.toContain("\ufffd");
		expect(preview.selectedTextTruncated).toBe(true);
		expect(prompt).toContain(quote.selectedText);
		const block = {
			type: "text",
			text: formatSessionConversationQuotes("Explain", Array(8).fill({ ...quote, selectedText: "short" })),
		};
		expect(project([block, block]).conversationQuotes).toHaveLength(8);
	});
});
