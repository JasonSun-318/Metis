/**
 * Task 13 acceptance matrix (docs/plans/2026-09-19-prompt-cache-execution-plan.md
 * §19). Every case drives a real AgentSession — real journal, settings, tools —
 * and/or the real provider serializers via loopback wire capture. No behavior
 * under test is replaced by reducers or hardcoded simulations.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@metis/agent-core";
import type { AssistantMessage, Context, StreamOptions, ToolResultMessage } from "@metis/ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@metis/ai";
import { registerFauxProvider } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CapturedWire,
	captureWire,
	normalizeCachePayload,
	type PromptCacheWireApi,
} from "../../ai/test/prompt-cache-fixtures.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type CacheSessionFixture, createCacheSession } from "./cache-session-fixtures.ts";

// biome-ignore lint/suspicious/noExportsInTest: the execution plan requires this exact exported registry name
export const cacheAcceptanceCases = [
	"thirty-planned-tool-rounds",
	"anthropic-more-than-twenty-blocks",
	"plan-revision-accepted-and-cancelled",
	"resume-same-directory",
	"branch-before-and-after-prune",
	"compaction-followed-by-task-update-and-resume",
	"hook-mutates-prefix-and-suffix",
	"archive-failure-and-journal-failure",
	"committed-request-network-failure",
	"deferred-tools-and-unsupported-provider",
] as const;

const BIG = (index: number) => `big-${index}-${"x".repeat(100_000)}`;
const SHORT = "short";
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
const lastContextText = (context: Context) => textOf(context.messages[context.messages.length - 1]);

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

const tasksResult = (callId: string, tasks: { task: string; completed: boolean }[]): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "set_tasks",
	content: [{ type: "text", text: `<task_list>${tasks.map((t) => t.task).join(",")}</task_list>` }],
	details: { tasks },
	isError: false,
	timestamp: Date.now(),
});

function countMarkers(api: PromptCacheWireApi, value: unknown): number {
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countMarkers(api, item), 0);
	const record = value as Record<string, unknown>;
	const marker = api === "anthropic-messages" ? "cache_control" : "prompt_cache_breakpoint";
	let count = record[marker] !== undefined ? 1 : 0;
	for (const key of Object.keys(record)) count += countMarkers(api, record[key]);
	return count;
}

const wireCompat = (api: PromptCacheWireApi) =>
	api === "openai-responses" ? { supportsExplicitPromptCacheMode: true } : undefined;

function wireMessages(api: PromptCacheWireApi, body: Record<string, unknown>): unknown[] {
	const normalized = normalizeCachePayload(api, body);
	return (api === "anthropic-messages" ? normalized.messages : normalized.input) as unknown[];
}

/**
 * Route the session's request through the real provider serializer over a
 * loopback server, forward the adapter's cache observation exactly as a real
 * adapter reports it (so checkpoints persist onto the assistant message), then
 * complete the turn. `wire` collects every captured request body.
 */
function useWireBackedStream(
	fixture: CacheSessionFixture,
	api: PromptCacheWireApi,
	wire: CapturedWire[],
	extra?: () => Partial<StreamOptions>,
): void {
	fixture.agent.streamFn = (requestModel, context, options) => {
		fixture.captured.push(JSON.parse(JSON.stringify(context)) as Context);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				const captured = await captureWire(
					api,
					context,
					{ cacheRetention: "short", ...extra?.() },
					wireCompat(api),
				);
				wire.push(captured);
				for (const observation of captured.observations) options?.onPromptCachePrepared?.(observation);
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("done"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				});
			} catch (error) {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) }),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				});
			}
			stream.end();
		});
		return stream;
	};
}

describe("prompt-cache acceptance matrix", () => {
	let root: string;
	let fixture: CacheSessionFixture | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-cache-acceptance-"));
	});
	afterEach(() => {
		fixture?.close();
		fixture = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	const pressureFixture = (options?: Parameters<typeof createCacheSession>[1]) => {
		const f = createCacheSession(root, { contextWindow: 80_000, ...options });
		f.settings.applyOverrides({ promptCache: { microcompaction: "pressure" } });
		return f;
	};

	it("thirty-planned-tool-rounds", async () => {
		const h = createCacheSession(root);
		fixture = h;
		await h.session.setCollaborationMode("plan");
		h.manager.submitPlan({ title: "acceptance plan", markdown: "# Steps\n1. do the thing" });
		seedRoundTrips(
			h,
			Array.from({ length: 30 }, (_, i) => `planned-${i}-${"y".repeat(500)}`),
		);

		await h.session.prompt("request A");
		await h.session.prompt("request B");
		expect(h.captured).toHaveLength(2);

		// The complete plan rides at the tail of every request as a volatile view.
		for (const context of h.captured) {
			expect(lastContextText(context)).toContain("do the thing");
			const origins = context.cacheHints?.origins ?? [];
			expect(origins).toHaveLength(context.messages.length);
			expect(origins[origins.length - 1]?.kind).toBe("volatile");
			expect(origins.slice(0, -1).every((origin) => origin.kind === "stable")).toBe(true);
		}

		// The projection is request-local: no message entry ever persists it.
		const planCopies = h.manager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" &&
					textOf((entry as { message?: AgentMessage }).message).includes("do the thing"),
			);
		expect(planCopies).toHaveLength(0);

		// Unmodified history produces identical wire prefix frames; only the
		// volatile tail (plan + new turn) differs between the two requests.
		const wire1 = await captureWire("anthropic-messages", h.captured[0]!, { cacheRetention: "short" });
		const wire2 = await captureWire("anthropic-messages", h.captured[1]!, { cacheRetention: "short" });
		const m1 = wireMessages("anthropic-messages", wire1.body);
		const m2 = wireMessages("anthropic-messages", wire2.body);
		// Second request prefix = first request minus its volatile plan tail.
		expect(m2.slice(0, m1.length - 1)).toEqual(m1.slice(0, -1));
		expect(wire1.body.system).toEqual(wire2.body.system);
		expect(countMarkers("anthropic-messages", wire2.body)).toBeGreaterThan(0);
	});

	it("anthropic-more-than-twenty-blocks", async () => {
		const h = createCacheSession(root);
		fixture = h;
		// 25 assistant tool-call messages + 25 results + turn text: far more than
		// the provider's four-marker budget.
		seedRoundTrips(
			h,
			Array.from({ length: 25 }, (_, i) => `block-${i}-${"z".repeat(2_000)}`),
		);
		const wire: CapturedWire[] = [];
		useWireBackedStream(h, "anthropic-messages", wire);

		await h.session.prompt("go");
		expect(wire).toHaveLength(1);
		const markers = countMarkers("anthropic-messages", wire[0]!.body);
		expect(markers).toBeGreaterThan(0);
		expect(markers).toBeLessThanOrEqual(4);
		expect(wire[0]!.observations[0]?.checkpoint).toBeDefined();

		// The observed checkpoint persists onto the assistant message and is
		// offered as the previous boundary of the next request.
		const assistantEntries = h.manager
			.getBranch()
			.filter(
				(entry) => entry.type === "message" && (entry as { message?: AgentMessage }).message?.role === "assistant",
			);
		const recorded = (assistantEntries.at(-1) as { cacheCheckpoint?: unknown } | undefined)?.cacheCheckpoint;
		expect(recorded).toBeDefined();

		await h.session.prompt("next");
		expect(wire).toHaveLength(2);
		expect(h.captured[1]!.cacheHints?.previous).toEqual(recorded);
		expect(wire[1]!.observations[0]?.reason).toMatch(/append|suffix/);
		expect(countMarkers("anthropic-messages", wire[1]!.body)).toBeLessThanOrEqual(4);
	});

	it("plan-revision-accepted-and-cancelled", async () => {
		const h = createCacheSession(root);
		fixture = h;
		await h.session.setCollaborationMode("plan");
		const toolNames = (context: Context) => (context.tools ?? []).map((tool) => tool.name);

		h.manager.submitPlan({ title: "v1", markdown: "revision-1-body" });
		await h.session.prompt("p1");
		expect(lastContextText(h.captured[0]!)).toContain("revision-1-body");
		// Plan mode keeps write tools out of the request entirely.
		expect(toolNames(h.captured[0]!)).not.toContain("write");

		const v2 = h.manager.submitPlan({ title: "v2", markdown: "revision-2-body" });
		await h.session.prompt("p2");
		expect(lastContextText(h.captured[1]!)).toContain("revision-2-body");
		expect(lastContextText(h.captured[1]!)).not.toContain("revision-1-body");

		h.manager.acceptPlan({ planId: v2.planId, revision: v2.revision });
		await h.session.setCollaborationMode("default");
		await h.session.prompt("p3");
		expect(lastContextText(h.captured[2]!)).not.toContain("revision-2-body");
		expect(toolNames(h.captured[2]!)).toContain("write");

		await h.session.setCollaborationMode("plan");
		const v3 = h.manager.submitPlan({ title: "v3", markdown: "revision-3-body" });
		await h.session.prompt("p4");
		expect(lastContextText(h.captured[3]!)).toContain("revision-3-body");

		h.manager.cancelPlan({ planId: v3.planId, revision: v3.revision });
		await h.session.prompt("p5");
		expect(lastContextText(h.captured[4]!)).not.toContain("revision-3-body");
	});

	it("resume-same-directory", async () => {
		const first = pressureFixture();
		seedRoundTrips(first, pressureTexts());
		await first.session.prompt("hello");
		expect(first.manager.getContextRewrites()).toHaveLength(1);
		const filesBefore = artifactFiles(first).length;
		expect(filesBefore).toBeGreaterThan(0);
		const file = first.manager.getSessionFile()!;
		first.close();

		const reopened = SessionManager.open(file);
		expect(reopened.getContextRewrites()).toHaveLength(1);
		const second = createCacheSession(root, {
			contextWindow: 80_000,
			manager: reopened,
		});
		second.settings.applyOverrides({ promptCache: { microcompaction: "pressure" } });
		fixture = second;

		await second.session.prompt("again");
		expect(second.captured).toHaveLength(1);
		const text = contextText(second.captured[0]!);
		// The committed batch replays: rewritten prefix, no re-archiving.
		expect(text).toContain("<tool-result-cleared>");
		expect(text).not.toContain("big-0-");
		expect(second.manager.getContextRewrites()).toHaveLength(1);
		expect(artifactFiles(second)).toHaveLength(filesBefore);
	});

	it("branch-before-and-after-prune", async () => {
		const h = pressureFixture();
		fixture = h;
		seedRoundTrips(h, pressureTexts());
		const leafBefore = h.manager.getLeafId()!;
		await h.session.prompt("hello");
		const leafAfter = h.manager.getLeafId()!;
		expect(h.manager.getContextRewrites()).toHaveLength(1);

		// Stop new pruning so the branch views differ only by batch visibility;
		// committed batches still replay on branches that contain them.
		h.settings.applyOverrides({ promptCache: { microcompaction: "off" } });
		h.manager.branch(leafBefore);
		expect(h.manager.getContextRewrites()).toHaveLength(0);
		await h.session.prompt("pre-prune branch");
		const prePrune = contextText(h.captured[1]!);
		expect(prePrune).toContain("big-0-");
		expect(prePrune).not.toContain("<tool-result-cleared>");
		expect(h.manager.getContextRewrites()).toHaveLength(0);

		h.manager.branch(leafAfter);
		expect(h.manager.getContextRewrites()).toHaveLength(1);
		await h.session.prompt("post-prune branch");
		const postPrune = contextText(h.captured[2]!);
		expect(postPrune).toContain("<tool-result-cleared>");
		expect(postPrune).not.toContain("big-0-");
	});

	it("compaction-followed-by-task-update-and-resume", async () => {
		const h = createCacheSession(root);
		h.manager.appendMessage(assistantWithCalls("tasks-1"));
		h.manager.appendMessage(tasksResult("tasks-1", [{ task: "tasks-at-compaction", completed: false }]));
		const kept = h.manager.appendMessage({ role: "user", content: "retained-marker", timestamp: 2 });
		// Same APIs the session's compaction path calls: freeze the carry, append.
		const carry = h.manager.computeCompactionCarry(kept);
		h.manager.appendCompaction("SUMMARY-MARKER", kept, 1000, undefined, false, carry);
		const beforeUpdate = h.manager.buildSessionContext().messages;

		// A later task update appends; it must not rewrite the preserved prefix.
		h.manager.appendMessage(assistantWithCalls("tasks-2"));
		h.manager.appendMessage(tasksResult("tasks-2", [{ task: "post-compaction-update", completed: false }]));
		const afterUpdate = h.manager.buildSessionContext().messages;
		expect(afterUpdate.slice(0, beforeUpdate.length)).toEqual(beforeUpdate);

		const file = h.manager.getSessionFile()!;
		h.close();
		const reopened = SessionManager.open(file);
		const replayed = reopened.buildSessionContext().messages;
		expect(replayed).toEqual(afterUpdate);
		const carries = replayed.filter((m) => m.role === "custom" && m.customType === "latest_tasks");
		expect(JSON.stringify(carries)).toContain("tasks-at-compaction");
		expect(JSON.stringify(carries)).not.toContain("post-compaction-update");

		const second = createCacheSession(root, { manager: reopened });
		fixture = second;
		await second.session.prompt("continue after reopen");
		expect(second.captured).toHaveLength(1);
		const text = contextText(second.captured[0]!);
		expect(text).toContain("SUMMARY-MARKER");
		expect(text).toContain("tasks-at-compaction");
	});

	it("hook-mutates-prefix-and-suffix", async () => {
		const h = createCacheSession(root);
		fixture = h;
		// The volatile plan projection gives each request a mutable tail.
		await h.session.setCollaborationMode("plan");
		h.manager.submitPlan({ title: "plan", markdown: "plan-body" });
		seedRoundTrips(h, ["hook-seed-1", "hook-seed-2"]);

		let hook: "none" | "suffix" | "prefix" = "none";
		const wire: CapturedWire[] = [];
		useWireBackedStream(h, "anthropic-messages", wire, () => ({
			onPayload: (params) => {
				if (hook === "none") return;
				const needle = hook === "suffix" ? "plan-body" : "hook-seed-1";
				// tool_result blocks nest their text one level deeper; recurse.
				const mutate = (value: unknown): boolean => {
					if (Array.isArray(value)) return value.some(mutate);
					if (value !== null && typeof value === "object") {
						const record = value as Record<string, unknown>;
						for (const key of ["text", "content"] as const) {
							const field = record[key];
							if (typeof field === "string" && field.includes(needle)) {
								record[key] = `(hook) ${field}`;
								return true;
							}
						}
						for (const key of Object.keys(record)) if (mutate(record[key])) return true;
					}
					return false;
				};
				mutate((params as { messages?: unknown[] }).messages ?? []);
			},
		}));

		await h.session.prompt("baseline request");
		const checkpoint = wire[0]!.observations[0]?.checkpoint;
		expect(checkpoint).toBeDefined();

		// A mutation confined to the volatile suffix keeps the boundary valid;
		// the persisted checkpoint is offered on the next request.
		hook = "suffix";
		await h.session.prompt("suffix request");
		expect(JSON.stringify(wire[1]!.body)).toContain("(hook)");
		expect(h.captured[1]!.cacheHints?.previous).toEqual(checkpoint);
		expect(wire[1]!.observations[0]?.checkpoint).toBeDefined();
		expect(wire[1]!.observations[0]?.reason).toMatch(/append|suffix/);

		// Mutating a history frame revokes the boundary: hook-change, no checkpoint.
		hook = "prefix";
		await h.session.prompt("prefix request");
		expect(JSON.stringify(wire[2]!.body)).toContain("(hook) hook-seed-1");
		expect(wire[2]!.observations[0]?.reason).toBe("hook-change");
		expect(wire[2]!.observations[0]?.checkpoint).toBeUndefined();
	});

	it("archive-failure-and-journal-failure", async () => {
		// Archive failure: the batch cannot commit, so the request keeps the
		// legal original view (full text on the wire).
		const blocked = pressureFixture();
		seedRoundTrips(blocked, pressureTexts());
		const outputDir = blocked.manager.getToolOutputDir()!;
		mkdirSync(dirname(outputDir), { recursive: true });
		writeFileSync(outputDir, "blocked");
		await blocked.session.prompt("hello");
		expect(blocked.captured).toHaveLength(1);
		expect(blocked.manager.getContextRewrites()).toHaveLength(0);
		expect(contextText(blocked.captured[0]!)).toContain("big-0-");
		blocked.close();
		fixture = undefined;

		// Journal failure: the batch never commits, so no request goes out on the
		// new view at all. Fresh session on the same project root.
		rmSync(outputDir);
		const h = pressureFixture();
		fixture = h;
		seedRoundTrips(h, pressureTexts());
		vi.spyOn(h.manager, "appendContextRewrite").mockImplementation(() => {
			throw new Error("journal sync failure");
		});
		await h.session.prompt("hello").catch(() => {});
		await h.agent.waitForIdle();
		expect(h.captured).toHaveLength(0);
		expect(h.manager.getContextRewrites()).toHaveLength(0);
	});

	it("committed-request-network-failure", async () => {
		const h = pressureFixture();
		fixture = h;
		seedRoundTrips(h, pressureTexts());
		const defaultStream = h.agent.streamFn!;
		h.agent.streamFn = (requestModel, context) => {
			h.captured.push(JSON.parse(JSON.stringify(context)) as Context);
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

		// The batch commits before the request; the provider error must not roll it back.
		await h.session.prompt("hello").catch(() => {});
		await h.agent.waitForIdle();
		expect(h.manager.getContextRewrites()).toHaveLength(1);
		const files = artifactFiles(h).length;
		expect(files).toBeGreaterThan(0);

		h.agent.streamFn = defaultStream;
		await h.session.prompt("again");
		expect(h.captured).toHaveLength(2);
		expect(h.manager.getContextRewrites()).toHaveLength(1);
		expect(artifactFiles(h)).toHaveLength(files);
		expect(contextText(h.captured[1]!)).toContain("<tool-result-cleared>");
	});

	it("deferred-tools-and-unsupported-provider", async () => {
		// Deferred tool-search items close a source: the breakpoint retreats to
		// the last markable block and never lands inside the tool-search group.
		const assistant = assistantWithCalls("call-1");
		const tool = {
			name: "deferred_tool",
			description: "deferred",
			parameters: { type: "object" as const, properties: {} },
		};
		const { body } = await captureWire(
			"openai-responses",
			{
				tools: [tool],
				messages: [
					assistant,
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: 2,
						addedToolNames: ["deferred_tool"],
					},
					{ role: "user", content: "plan", timestamp: 3 },
				],
				cacheHints: {
					origins: [
						{ id: "entry:a", kind: "stable" },
						{ id: "entry:r", kind: "stable" },
						{ id: "request:plan", kind: "volatile" },
					],
				},
			},
			{ cacheRetention: "short" },
			{ supportsExplicitPromptCacheMode: true, supportsToolSearch: true },
		);
		const input = body.input as Record<string, unknown>[];
		const marked = input.filter((item) => countMarkers("openai-responses", item) > 0);
		expect(marked).toHaveLength(1);
		expect(marked[0]!.type).toBe("function_call_output");
		expect(
			input.every((item) => item.type !== "tool_search_call" || countMarkers("openai-responses", item) === 0),
		).toBe(true);

		// A provider without explicit cache support sends the identical body as a
		// hint-less request: no breakpoint fields, no errors.
		const hintless = await captureWire("openai-responses", {
			messages: [{ role: "user", content: "plain", timestamp: 1 }],
		});
		const hinted = await captureWire("openai-responses", {
			messages: [{ role: "user", content: "plain", timestamp: 1 }],
			cacheHints: { origins: [{ id: "entry:u", kind: "stable" }] },
		});
		expect(normalizeCachePayload("openai-responses", hinted.body)).toEqual(
			normalizeCachePayload("openai-responses", hintless.body),
		);
		expect(countMarkers("openai-responses", hinted.body)).toBe(0);

		// Session-level: a model without cache support completes a normal request.
		const faux = registerFauxProvider();
		try {
			const h = createCacheSession(root, {
				configureAgent: (agent) => {
					agent.state.model = faux.getModel();
				},
			});
			fixture = h;
			h.auth.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			await h.session.prompt("hello");
			expect(h.captured).toHaveLength(1);
			expect(h.session.agent.state.messages.at(-1)?.role).toBe("assistant");
		} finally {
			faux.unregister();
		}
	});
});
