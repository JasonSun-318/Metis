import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultMessage } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { DeliverFileDetails } from "../src/core/deliver-file.ts";
import { createTestSession, type TestSessionContext } from "./utilities.ts";

const sessions: TestSessionContext[] = [];

function fixture() {
	const value = createTestSession({ withAgentDir: true });
	sessions.push(value);
	return value;
}

async function stage(value: TestSessionContext) {
	const source = join(value.tempDir, "deliver.txt");
	writeFileSync(source, "durable delivery");
	const toolCallId = "call-durable-delivery";
	const result = await value.session
		.deliveredArtifacts!.createToolDefinition()
		.execute(toolCallId, { path: source }, undefined, undefined, {} as never);
	const message: ToolResultMessage<DeliverFileDetails> = {
		role: "toolResult",
		toolCallId,
		toolName: "deliver_file",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	};
	return message;
}

async function processMessageEnd(value: TestSessionContext, message: ToolResultMessage): Promise<void> {
	await (
		value.session as unknown as {
			_processAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		}
	)._processAgentEvent({ type: "message_end", message });
}

afterEach(() => {
	for (const value of sessions.splice(0, sessions.length)) value.cleanup();
});

describe("AgentSession delivered artifact persistence", () => {
	it("publishes a successful delivery only after its journal fact and file are committed", async () => {
		const value = fixture();
		const message = await stage(value);
		const observed: AgentSessionEvent[] = [];
		value.session.subscribe((event) => {
			observed.push(event);
			if (event.type !== "message_end" || event.message !== message) return;
			expect(value.sessionManager.getBranch()).toContainEqual(expect.objectContaining({ type: "message", message }));
			expect(value.session.deliveredArtifacts?.resolve(message.details!.fileId)).toBeDefined();
		});

		await processMessageEnd(value, message);
		expect(observed).toContainEqual(expect.objectContaining({ type: "message_end", message }));
	});

	it("does not publish success and deletes the staged file when journal append fails", async () => {
		const value = fixture();
		const message = await stage(value);
		const observed: AgentSessionEvent[] = [];
		value.session.subscribe((event) => observed.push(event));
		vi.spyOn(value.sessionManager, "appendMessage").mockImplementationOnce(() => {
			throw new Error("append failed");
		});

		await expect(processMessageEnd(value, message)).rejects.toThrow("append failed");
		expect(observed).not.toContainEqual(expect.objectContaining({ type: "message_end", message }));
		const deliveredDir = join(
			value.tempDir,
			"agent",
			"attachments",
			value.sessionManager.getSessionId(),
			"delivered",
		);
		expect(existsSync(deliveredDir) ? readdirSync(deliveredDir) : []).toEqual([]);
	});
});
