import type { AgentEvent, AgentMessage, AgentTool } from "@metis/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionEvent, MessageEndEvent } from "../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;
type AssistantAgentMessage = ReturnType<typeof fauxAssistantMessage> & {
	responseId?: string;
	extra?: string;
};

type EmitHarness = {
	_turnIndex: number;
	_extensionRunner: {
		emit(event: ExtensionEvent): Promise<unknown>;
		emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined>;
	};
};

function createEmitHarness(): {
	mode: EmitHarness;
	emitted: ExtensionEvent[];
	messageEnds: MessageEndEvent[];
} {
	const mode = Object.create(AgentSession.prototype) as EmitHarness;
	const emitted: ExtensionEvent[] = [];
	const messageEnds: MessageEndEvent[] = [];
	mode._turnIndex = 0;
	mode._extensionRunner = {
		emit: async (event) => {
			emitted.push(event);
		},
		emitMessageEnd: async (event) => {
			messageEnds.push(event);
			return undefined;
		},
	};
	return { mode, emitted, messageEnds };
}

function emitExtensionEvent(mode: EmitHarness, event: AgentEvent): Promise<void> {
	return (
		AgentSession.prototype as unknown as {
			_emitExtensionEvent(this: EmitHarness, event: AgentEvent): Promise<void>;
		}
	)._emitExtensionEvent.call(mode, event);
}

function userMessage(text = "hello"): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function toolResult(): ToolResultAgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "echo",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 2,
	};
}

function createEchoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
}

describe("AgentSession._emitExtensionEvent mapping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resets turnIndex before emitting agent_start", async () => {
		const { mode, emitted } = createEmitHarness();
		const indexDuringEmit: number[] = [];
		mode._turnIndex = 7;
		mode._extensionRunner.emit = async (event) => {
			indexDuringEmit.push(mode._turnIndex);
			emitted.push(event);
		};

		await emitExtensionEvent(mode, { type: "agent_start" });

		expect(indexDuringEmit).toEqual([0]);
		expect(mode._turnIndex).toBe(0);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toStrictEqual({ type: "agent_start" });
	});

	it("forwards agent_end messages by identity without extra fields", async () => {
		const { mode, emitted } = createEmitHarness();
		const messages: AgentMessage[] = [userMessage(), fauxAssistantMessage("done")];

		await emitExtensionEvent(mode, { type: "agent_end", messages });

		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toStrictEqual({ type: "agent_end", messages });
		expect((emitted[0] as { messages: AgentMessage[] }).messages).toBe(messages);
	});

	it("snapshots turnIndex and Date.now at turn_start construction", async () => {
		const { mode, emitted } = createEmitHarness();
		const now = vi.spyOn(Date, "now").mockReturnValue(111);
		mode._turnIndex = 3;
		mode._extensionRunner.emit = async (event) => {
			emitted.push(event);
			mode._turnIndex = 9;
			now.mockReturnValue(222);
		};

		await emitExtensionEvent(mode, { type: "turn_start" });

		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toStrictEqual({ type: "turn_start", turnIndex: 3, timestamp: 111 });
		expect(mode._turnIndex).toBe(9);
	});

	it("keeps turn_end message and toolResults identity and increments only after emit resolves", async () => {
		const { mode, emitted } = createEmitHarness();
		const message = fauxAssistantMessage("turn");
		const toolResults: ToolResultAgentMessage[] = [toolResult()];
		let release: () => void = () => {
			throw new Error("gate was not initialized");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const order: string[] = [];
		mode._turnIndex = 2;
		mode._extensionRunner.emit = async (event) => {
			emitted.push(event);
			order.push(`emit-start:${mode._turnIndex}`);
			await gate;
			order.push(`emit-end:${mode._turnIndex}`);
		};

		const pending = emitExtensionEvent(mode, { type: "turn_end", message, toolResults });
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(order).toEqual(["emit-start:2"]);
		expect(settled).toBe(false);
		expect(mode._turnIndex).toBe(2);
		expect(emitted[0]).toStrictEqual({ type: "turn_end", turnIndex: 2, message, toolResults });
		expect((emitted[0] as { message: AgentMessage }).message).toBe(message);
		expect((emitted[0] as { toolResults: ToolResultAgentMessage[] }).toolResults).toBe(toolResults);

		release();
		await pending;

		expect(order).toEqual(["emit-start:2", "emit-end:2"]);
		expect(mode._turnIndex).toBe(3);
	});

	it("does not increment turnIndex when a turn_end emit rejects", async () => {
		const { mode } = createEmitHarness();
		mode._turnIndex = 4;
		mode._extensionRunner.emit = async () => {
			throw new Error("turn_end extension failed");
		};

		await expect(
			emitExtensionEvent(mode, {
				type: "turn_end",
				message: fauxAssistantMessage("turn"),
				toolResults: [],
			}),
		).rejects.toThrow("turn_end extension failed");
		expect(mode._turnIndex).toBe(4);
	});

	it("maps message_start by identity without extra fields", async () => {
		const { mode, emitted } = createEmitHarness();
		const message = userMessage();

		await emitExtensionEvent(mode, { type: "message_start", message });

		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toStrictEqual({ type: "message_start", message });
		expect((emitted[0] as { message: AgentMessage }).message).toBe(message);
	});

	it("maps message_update with assistantMessageEvent identity", async () => {
		const { mode, emitted } = createEmitHarness();
		const message = fauxAssistantMessage("streaming");
		const assistantMessageEvent = {
			type: "text_delta" as const,
			contentIndex: 0,
			delta: "streaming",
			partial: message,
		};

		await emitExtensionEvent(mode, { type: "message_update", message, assistantMessageEvent });

		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toStrictEqual({ type: "message_update", message, assistantMessageEvent });
		expect((emitted[0] as { message: AgentMessage }).message).toBe(message);
		expect((emitted[0] as { assistantMessageEvent: unknown }).assistantMessageEvent).toBe(assistantMessageEvent);
	});

	it("forwards message_end and mutation only when emitMessageEnd returns a replacement", async () => {
		const { mode, emitted, messageEnds } = createEmitHarness();
		const message = fauxAssistantMessage("original");
		const replacement = fauxAssistantMessage("replacement");

		await emitExtensionEvent(mode, { type: "message_end", message });
		expect(messageEnds).toHaveLength(1);
		expect(messageEnds[0]).toStrictEqual({ type: "message_end", message });
		expect(messageEnds[0].message).toBe(message);
		expect(message.content).toEqual([{ type: "text", text: "original" }]);
		expect(emitted).toHaveLength(0);

		mode._extensionRunner.emitMessageEnd = async (event) => {
			messageEnds.push(event);
			return replacement;
		};
		await emitExtensionEvent(mode, { type: "message_end", message });

		expect(message).not.toBe(replacement);
		expect(message.content).toEqual([{ type: "text", text: "replacement" }]);
	});

	it("normalizes null or missing content on message_end replacements in the original object", async () => {
		const replacements = [
			(message: AgentMessage): AgentMessage => ({ ...message, content: null }) as unknown as AgentMessage,
			(message: AgentMessage): AgentMessage => {
				const { content: _content, ...withoutContent } = message as unknown as Record<string, unknown>;
				return withoutContent as unknown as AgentMessage;
			},
		];

		for (const buildReplacement of replacements) {
			const { mode } = createEmitHarness();
			const message = fauxAssistantMessage("original");
			mode._extensionRunner.emitMessageEnd = async () => buildReplacement(message);

			await emitExtensionEvent(mode, { type: "message_end", message });

			expect(message.content).toEqual([]);
		}
	});

	it("deletes original keys absent from the replacement and leaves the original identity intact", async () => {
		const { mode, messageEnds } = createEmitHarness();
		const original = fauxAssistantMessage("original") as AssistantAgentMessage;
		original.responseId = "old-response";
		original.extra = "stale";
		const replacement = {
			...original,
			content: [{ type: "text" as const, text: "replaced" }],
			model: "replacement-model",
		};
		delete replacement.responseId;
		delete replacement.extra;

		mode._extensionRunner.emitMessageEnd = async (event) => {
			messageEnds.push(event);
			return replacement;
		};
		await emitExtensionEvent(mode, { type: "message_end", message: original });

		expect(messageEnds[0].message).toBe(original);
		expect(original.responseId).toBeUndefined();
		expect(original.extra).toBeUndefined();
		expect(original.model).toBe("replacement-model");
		expect(original.content).toEqual([{ type: "text", text: "replaced" }]);
		expect(Object.keys(original).sort()).toEqual(Object.keys(replacement).sort());
	});

	it("does not mutate message_end message when emitMessageEnd rejects", async () => {
		const { mode } = createEmitHarness();
		const message = fauxAssistantMessage("unchanged");
		const before = structuredClone(message);
		mode._extensionRunner.emitMessageEnd = async () => {
			throw new Error("message_end extension failed");
		};

		await expect(emitExtensionEvent(mode, { type: "message_end", message })).rejects.toThrow(
			"message_end extension failed",
		);
		expect(message).toEqual(before);
	});

	it("maps tool execution events with payload identity and exact fields", async () => {
		const { mode, emitted } = createEmitHarness();
		const args = { text: "hello" };
		const partialResult = { content: [{ type: "text", text: "partial" }] };
		const result = { content: [{ type: "text", text: "done" }] };

		await emitExtensionEvent(mode, { type: "tool_execution_start", toolCallId: "call-1", toolName: "echo", args });
		await emitExtensionEvent(mode, {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "echo",
			args,
			partialResult,
		});
		await emitExtensionEvent(mode, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "echo",
			result,
			isError: false,
		});

		expect(emitted).toHaveLength(3);
		expect(emitted[0]).toStrictEqual({ type: "tool_execution_start", toolCallId: "call-1", toolName: "echo", args });
		expect(emitted[1]).toStrictEqual({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "echo",
			args,
			partialResult,
		});
		expect(emitted[2]).toStrictEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "echo",
			result,
			isError: false,
		});
		expect((emitted[0] as { args: unknown }).args).toBe(args);
		expect((emitted[1] as { partialResult: unknown }).partialResult).toBe(partialResult);
		expect((emitted[2] as { result: unknown }).result).toBe(result);
	});
});

describe("AgentSession extension event integration", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("awaits turn_end handlers before publishing the session turn_end event", async () => {
		let release: () => void = () => {
			throw new Error("gate was not initialized");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let enteredResolve: () => void = () => {
			throw new Error("entry was not initialized");
		};
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		const extensionTurns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(metis) => {
					metis.on("turn_start", (event) => {
						extensionTurns.push(`start:${event.turnIndex}`);
					});
					metis.on("turn_end", async (event) => {
						extensionTurns.push(`end:${event.turnIndex}`);
						enteredResolve();
						await gate;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		const promptPromise = harness.session.prompt("hi");
		await entered;

		try {
			expect(extensionTurns).toEqual(["start:0", "end:0"]);
			expect(harness.eventsOfType("turn_end")).toHaveLength(0);
		} finally {
			release();
			await promptPromise;
		}

		expect(harness.eventsOfType("turn_end")).toHaveLength(1);
	});

	it("reports throwing turn_end handlers and continues later handlers and turns", async () => {
		const turnStarts: number[] = [];
		const turnEnds: number[] = [];
		const harness = await createHarness({
			tools: [createEchoTool()],
			extensionFactories: [
				(metis) => {
					metis.on("turn_start", (event) => {
						turnStarts.push(event.turnIndex);
					});
					metis.on("turn_end", () => {
						throw new Error("boom");
					});
					metis.on("turn_end", (event) => {
						turnEnds.push(event.turnIndex);
					});
				},
			],
		});
		harnesses.push(harness);
		const extensionErrors: string[] = [];
		const offError = harness.session.extensionRunner.onError((error) => {
			extensionErrors.push(error.error);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "one" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		try {
			await harness.session.prompt("run");
		} finally {
			offError();
		}

		expect(extensionErrors).toEqual(["boom", "boom"]);
		expect(turnStarts).toEqual([0, 1]);
		expect(turnEnds).toEqual([0, 1]);
		expect(harness.eventsOfType("turn_end")).toHaveLength(2);
	});

	it("keeps the original message object when a message_end replacement is published", async () => {
		let original: AgentMessage | undefined;
		let subscriberMessage: AgentMessage | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(metis) => {
					metis.on("message_end", (event) => {
						if (event.message.role !== "assistant") return undefined;
						original = event.message;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "replaced" }],
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				subscriberMessage = event.message;
			}
		});
		harness.setResponses([fauxAssistantMessage("original")]);

		await harness.session.prompt("hi");

		const assistant = harness.session.messages.find((message) => message.role === "assistant");
		expect(original).toBeDefined();
		expect(subscriberMessage).toBe(original);
		expect(assistant).toBe(original);
		expect((assistant as { content: unknown }).content).toEqual([{ type: "text", text: "replaced" }]);
	});
});
