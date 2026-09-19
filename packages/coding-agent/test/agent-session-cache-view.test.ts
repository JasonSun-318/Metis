import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@metis/agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@metis/ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@metis/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CacheSessionFixture, createCacheSession } from "./cache-session-fixtures.ts";

const BIG = (index: number) => `big-${index}-${"x".repeat(100_000)}`;
const LARGE = "x".repeat(100_000);
const SHORT = "short";

/** Result texts for a pressure scenario: unique large candidates + protected recent tail. */
const pressureTexts = (largeCount = 8, shortCount = 5): string[] => [
	...Array.from({ length: largeCount }, (_, index) => BIG(index)),
	...Array(shortCount).fill(SHORT),
];

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => (block as { text?: string }).text ?? "")
		.join("");
}

const contextText = (context: Context) => context.messages.map((m) => textOf(m)).join("\n");

const readResult = (callId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: Date.now(),
});

const assistantWithCalls = (...ids: string[]): AssistantMessage => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `/f/${id}` } })),
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
});

/** Durable seeded history: journal entries + identical objects in agent state. */
function seedRoundTrips(fixture: CacheSessionFixture, texts: readonly string[], offset = 0): void {
	texts.forEach((text, index) => {
		const callId = `call-${offset + index}`;
		for (const message of [assistantWithCalls(callId), readResult(callId, text)] as const) {
			fixture.manager.appendMessage(message);
			fixture.agent.state.messages.push(message);
		}
	});
}

const artifactFiles = (fixture: CacheSessionFixture): string[] => {
	const dir = fixture.manager.getToolOutputDir();
	return dir ? readdirSync(dir) : [];
};

const sourceText = (fixture: CacheSessionFixture, entryId: string): string =>
	textOf((fixture.manager.getEntry(entryId) as { message?: AgentMessage } | undefined)?.message);

describe("AgentSession durable context view", () => {
	let root: string;
	let fixture: CacheSessionFixture;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-cache-view-"));
	});
	afterEach(() => {
		fixture?.close();
		rmSync(root, { recursive: true, force: true });
	});

	const pressureFixture = (options?: Parameters<typeof createCacheSession>[1]) => {
		fixture = createCacheSession(root, { contextWindow: 80_000, ...options });
		fixture.settings.applyOverrides({ promptCache: { microcompaction: "pressure" } });
		return fixture;
	};

	it("commits a durable batch before the request and sends the rewritten view", async () => {
		pressureFixture();
		// 8 large candidates + 5 protected recent results.
		seedRoundTrips(fixture, pressureTexts());

		await fixture.session.prompt("hello");

		expect(fixture.captured).toHaveLength(1);
		const batches = fixture.manager.getContextRewrites();
		expect(batches).toHaveLength(1);
		expect(batches[0]!.replacements.length).toBeGreaterThan(0);
		const text = contextText(fixture.captured[0]!);
		expect(text).toContain("<tool-result-cleared>");
		// Only the durably replaced sources are cleared on the wire.
		for (const replacement of batches[0]!.replacements) {
			expect(text).not.toContain(sourceText(fixture, replacement.sourceEntryId));
		}
		expect(text).toContain(SHORT);
		// Original state messages keep the full content.
		const stateText = fixture.agent.state.messages.map((m) => textOf(m)).join("");
		for (let index = 0; index < 8; index++) expect(stateText).toContain(`big-${index}-`);
		expect(artifactFiles(fixture).length).toBe(batches[0]!.replacements.length);
	});

	it("does not create new files or batches while below the pressure watermark", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());
		await fixture.session.prompt("hello");
		expect(fixture.manager.getContextRewrites()).toHaveLength(1);
		const filesAfterFirst = artifactFiles(fixture).length;

		seedRoundTrips(fixture, Array(30).fill(SHORT), 13);
		await fixture.session.prompt("again");

		expect(fixture.captured).toHaveLength(2);
		expect(fixture.manager.getContextRewrites()).toHaveLength(1);
		expect(artifactFiles(fixture)).toHaveLength(filesAfterFirst);
	});

	it("keeps the legal original view when archiving fails", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());
		// Block artifact creation: the output dir path is occupied by a file.
		const outputDir = fixture.manager.getToolOutputDir()!;
		mkdirSync(dirname(outputDir), { recursive: true });
		writeFileSync(outputDir, "blocked");

		await fixture.session.prompt("hello");

		expect(fixture.captured).toHaveLength(1);
		expect(fixture.manager.getContextRewrites()).toHaveLength(0);
		expect(contextText(fixture.captured[0]!)).toContain("big-0-");
	});

	it("sends no request on the new view when the journal commit fails", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());
		vi.spyOn(fixture.manager, "appendContextRewrite").mockImplementation(() => {
			throw new Error("journal sync failure");
		});

		await fixture.session.prompt("hello").catch(() => {});
		await fixture.agent.waitForIdle();

		expect(fixture.captured).toHaveLength(0);
		expect(fixture.manager.getContextRewrites()).toHaveLength(0);
	});

	it("replays a committed batch after a provider error without re-archiving", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());
		const defaultStream = fixture.agent.streamFn!;
		fixture.agent.streamFn = (requestModel, context) => {
			fixture.captured.push(JSON.parse(JSON.stringify(context)) as Context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...fauxAssistantMessage("", { stopReason: "error", errorMessage: "network down" }),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				});
				stream.end();
			});
			return stream;
		};

		await fixture.session.prompt("hello").catch(() => {});
		await fixture.agent.waitForIdle();
		expect(fixture.manager.getContextRewrites()).toHaveLength(1);
		const files = artifactFiles(fixture).length;
		expect(files).toBeGreaterThan(0);

		fixture.agent.streamFn = defaultStream;
		await fixture.session.prompt("again");

		expect(fixture.captured).toHaveLength(2);
		expect(fixture.manager.getContextRewrites()).toHaveLength(1);
		expect(artifactFiles(fixture)).toHaveLength(files);
		expect(contextText(fixture.captured[1]!)).toContain("<tool-result-cleared>");
	});

	it("only inherits the rewrite on branches that include the batch entry", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());
		const leafBeforePrompt = fixture.manager.getLeafId();
		await fixture.session.prompt("hello");
		const leafAfter = fixture.manager.getLeafId();
		expect(fixture.manager.getContextRewrites()).toHaveLength(1);

		fixture.manager.branch(leafBeforePrompt!);
		expect(fixture.manager.getContextRewrites()).toHaveLength(0);
		fixture.manager.branch(leafAfter!);
		expect(fixture.manager.getContextRewrites()).toHaveLength(1);
	});

	it("keeps extension-transformed content for a source a batch would have replaced", async () => {
		pressureFixture({
			configureAgent: (agent) => {
				const base = agent.transformContext;
				agent.transformContext = async (messages, signal) => {
					const out = base ? await base(messages, signal) : messages;
					return out.map((m) =>
						m.role === "toolResult" && m.toolCallId === "call-0"
							? ({ ...m, content: [{ type: "text" as const, text: "hook rewrote" }] } as AgentMessage)
							: m,
					);
				};
			},
		});
		seedRoundTrips(fixture, pressureTexts());

		await fixture.session.prompt("hello");

		const text = contextText(fixture.captured[0]!);
		expect(text).toContain("hook rewrote");
		expect(text).not.toContain("big-0-");
		expect(text).toContain("<tool-result-cleared>");
		const batches = fixture.manager.getContextRewrites();
		expect(batches).toHaveLength(1);
		for (const replacement of batches[0]!.replacements) {
			expect(text).not.toContain(sourceText(fixture, replacement.sourceEntryId));
		}
	});

	it("delivers a staged mailbox event and a prune batch exactly once in the same request", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());
		fixture.session.enqueueAgentMailboxEvent({
			eventId: "evt-1",
			taskId: "task-1",
			agentId: "agent-1",
			parentSessionId: fixture.manager.getSessionId(),
			name: "sub",
			type: "terminal",
			status: "done",
			finalMessage: "mailbox payload",
			completedAt: new Date().toISOString(),
		});

		await fixture.session.prompt("hello");

		expect(fixture.manager.getContextRewrites()).toHaveLength(1);
		const text = contextText(fixture.captured[0]!);
		expect(text).toContain("agent_mailbox_event");
		expect(text).toContain("mailbox payload");
		expect(fixture.session.getPendingAgentMailboxEventIds()).toHaveLength(0);
		const mailboxMessages = fixture.manager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent_mailbox" &&
					textOf({ content: entry.content }).includes("mailbox payload"),
			);
		expect(mailboxMessages).toHaveLength(1);
	});

	it("does not add an LLM summarization call when compaction is disabled", async () => {
		pressureFixture();
		fixture.settings.applyOverrides({ compaction: { enabled: false } });
		seedRoundTrips(fixture, [LARGE, LARGE, SHORT]);
		const defaultStream = fixture.agent.streamFn!;
		fixture.agent.streamFn = (requestModel, context) => {
			const stream = defaultStream(requestModel, context);
			return stream;
		};
		// Report usage above the compaction threshold on the response.
		fixture.agent.streamFn = (requestModel, context) => {
			fixture.captured.push(JSON.parse(JSON.stringify(context)) as Context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("done"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						usage: {
							input: 70_000,
							output: 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 70_010,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
				stream.end();
			});
			return stream;
		};

		await fixture.session.prompt("hello");

		expect(fixture.captured).toHaveLength(1);
	});

	it("does not lose queued user follow-ups or duplicate tool execution", async () => {
		pressureFixture();
		seedRoundTrips(fixture, pressureTexts());

		await fixture.session.prompt("first");
		await fixture.session.prompt("second", { streamingBehavior: "followUp" });
		await fixture.agent.waitForIdle();

		const userTexts = fixture.manager
			.getBranch()
			.filter((entry) => {
				if (entry.type !== "message") return false;
				const message = (entry as { message?: AgentMessage }).message;
				return message?.role === "user" && textOf(message).match(/first|second/);
			})
			.map((entry) => textOf((entry as { message?: AgentMessage }).message));
		expect(userTexts.filter((t) => t.includes("first"))).toHaveLength(1);
		expect(userTexts.filter((t) => t.includes("second"))).toHaveLength(1);
	});
});
