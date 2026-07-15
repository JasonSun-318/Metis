import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg } from "../utilities.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});

	it("stores tool-output metadata outside the model message", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "arcmind-tool-output-jsonl-"));
		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage(assistantMsg("calling tool"));
			const message = {
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "external_search",
				content: [{ type: "text" as const, text: "preview" }],
				details: { preserved: true },
				isError: false,
				timestamp: 2,
			};
			const toolOutput = {
				truncated: true as const,
				originalBytes: 60_000,
				previewBytes: 2_048,
				fullOutputPath: "/tmp/full-output.txt",
			};

			session.appendMessage(message, toolOutput);

			const rows = readFileSync(session.getSessionFile()!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const stored = rows.find((row) => row.type === "message" && row.message?.role === "toolResult");
			expect(stored.toolOutput).toEqual(toolOutput);
			expect(stored.message).not.toHaveProperty("toolOutput");
			const restored = session.buildSessionContext().messages.find((item) => item.role === "toolResult");
			expect(restored).toEqual(message);
			expect(restored).not.toHaveProperty("toolOutput");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
