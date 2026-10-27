import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@metis/ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	appendKnowledgeContext,
	buildKnowledgeContext,
	filterKnowledgeContext,
	KNOWLEDGE_LINKS_CUSTOM_TYPE,
	latestKnowledgeContext,
	readKnowledgeLinks,
} from "../src/core/knowledge-context.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

const a = { id: "a", name: "产品资料", path: "/Users/test/资料/产品资料" };
const b = { id: "b", name: "技术笔记", path: "/Users/test/资料/技术笔记" };
const userMessage = (hookContext?: string) => ({
	role: "user" as const,
	content: "request",
	timestamp: 1,
	...(hookContext ? { hookContext } : {}),
});

describe("Knowledge conversation context", () => {
	it("attaches context through AgentSession only when links change, keeping the old prefix", async () => {
		const harness = await createHarness();
		try {
			const systemPrompt = harness.session.systemPrompt;
			const tools = harness.session.getActiveToolNames();
			harness.setResponses(["1", "2", "3", "4", "5", "6"].map((text) => fauxAssistantMessage(text)));
			const promptAndReadContext = async (text: string) => {
				await harness.session.prompt(text);
				const message = [...harness.session.messages]
					.reverse()
					.find((candidate) => candidate.role === "user" && getMessageText(candidate) === text);
				return (message as { hookContext?: string } | undefined)?.hookContext;
			};

			expect(await promptAndReadContext("Before linking")).toBeUndefined();
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			expect(await promptAndReadContext("Linked A")).toBe(buildKnowledgeContext([a]));
			const previous = convertToLlm([...harness.session.messages]);
			expect(await promptAndReadContext("Still A")).toBeUndefined();
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [b] });
			expect(await promptAndReadContext("Linked B")).toBe(buildKnowledgeContext([b]));
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [] });
			expect(await promptAndReadContext("Unlinked")).toBe(buildKnowledgeContext([]));
			expect(await promptAndReadContext("Still unlinked")).toBeUndefined();

			const next = convertToLlm([...harness.session.messages]);
			expect(next.slice(0, previous.length)).toEqual(previous);
			expect(harness.session.systemPrompt).toBe(systemPrompt);
			expect(harness.session.getActiveToolNames()).toEqual(tools);
		} finally {
			await harness.cleanup();
		}
	});

	it("re-attaches the links when compaction right before a prompt drops the last block", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("1"), fauxAssistantMessage("2")]);
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			await harness.session.prompt("Linked A");
			// Simulate the pre-prompt compaction replacing history with a summary.
			const session = harness.session as unknown as {
				_checkCompaction: () => Promise<boolean>;
				agent: { state: { messages: unknown[] } };
			};
			// Only the pre-prompt check is replaced; later checks run for real.
			vi.spyOn(session, "_checkCompaction").mockImplementationOnce(async () => {
				session.agent.state.messages = [{ role: "compactionSummary", summary: "earlier work", timestamp: 1 }];
				return false;
			});
			await harness.session.prompt("After compaction");
			const message = harness.session.messages.find(
				(candidate) => candidate.role === "user" && getMessageText(candidate) === "After compaction",
			) as { hookContext?: string } | undefined;
			expect(message?.hookContext).toBe(buildKnowledgeContext([a]));
		} finally {
			await harness.cleanup();
		}
	});

	it("records independent conversation links and reflects multiple absolute paths", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a, b] });
		expect(readKnowledgeLinks(manager.getBranch())).toEqual([a, b]);
		expect(readKnowledgeLinks(SessionManager.inMemory("/tmp").getBranch())).toEqual([]);
		const context = buildKnowledgeContext(readKnowledgeLinks(manager.getBranch()));
		expect(context).toContain(a.path);
		expect(context).toContain(b.path);
		manager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [] });
		expect(readKnowledgeLinks(manager.getBranch())).toEqual([]);
	});

	it("keeps hook context and appends the block after it when links change", () => {
		const context = appendKnowledgeContext("existing hook", [a], []);
		expect(context).toBe(`existing hook\n\n${buildKnowledgeContext([a])}`);
		expect(latestKnowledgeContext([userMessage(context)])).toBe(buildKnowledgeContext([a]));
		expect(appendKnowledgeContext("existing hook", [a], [userMessage(context)])).toBe("existing hook");
	});

	it("skips unlinked sessions, including older sessions that repeated the unlinked block", () => {
		expect(appendKnowledgeContext(undefined, [], [])).toBeUndefined();
		const legacyUnlinked = "<knowledge_context>\n当前对话未链接知识库，知识库暂不可用。\n</knowledge_context>";
		expect(appendKnowledgeContext(undefined, [], [userMessage(legacyUnlinked)])).toBeUndefined();
		expect(appendKnowledgeContext(undefined, [a], [userMessage(legacyUnlinked)])).toBe(buildKnowledgeContext([a]));
	});

	it("re-attaches linked context once compaction has removed the previous block", () => {
		const compacted = [{ role: "compactionSummary", summary: "earlier work", timestamp: 1 }, userMessage()];
		expect(appendKnowledgeContext(undefined, [a], compacted)).toBe(buildKnowledgeContext([a]));
	});

	it("preserves captured context for replay and communicates an unlinked state", () => {
		const captured = buildKnowledgeContext([a]);
		expect(appendKnowledgeContext(captured, [b], [])).toBe(captured);
		expect(appendKnowledgeContext(undefined, [], [userMessage(captured)])).toBe(buildKnowledgeContext([]));
		expect(buildKnowledgeContext([])).toContain("当前对话已取消链接知识库");
	});

	it("resolves persisted links by registered identity and authoritative metadata", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a, b] });
		const renamed = { ...b, name: "更新名称" };
		expect(readKnowledgeLinks(manager.getBranch(), [renamed])).toEqual([renamed]);
		expect(readKnowledgeLinks(manager.getBranch(), [])).toEqual([]);
		expect(readKnowledgeLinks(manager.getBranch(), [{ ...a, id: "new-id" }])).toEqual([]);
	});

	it("removes deleted libraries from prepared context while retaining other hooks and accepted links", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a, b] });
		const captured = `before hook\n\n${buildKnowledgeContext([a, b])}\n\nafter hook`;
		expect(filterKnowledgeContext(captured, [b], manager.getBranch())).toBe(
			`before hook\n\n${buildKnowledgeContext([b])}\n\nafter hook`,
		);
		expect(filterKnowledgeContext(captured, [a, b], manager.getBranch())).toBe(captured);
		expect(filterKnowledgeContext(buildKnowledgeContext([a]), [{ ...a, id: "new-id" }], manager.getBranch())).toBe(
			buildKnowledgeContext([]),
		);
	});

	it("does not revive an old id from legacy context when its directory is registered again", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
		const legacy = `<knowledge_context>\n当前对话已链接知识库：\n${JSON.stringify({ name: a.name, path: a.path })}\n</knowledge_context>`;
		expect(filterKnowledgeContext(legacy, [a], manager.getBranch())).toBe(legacy);
		expect(filterKnowledgeContext(legacy, [{ ...a, id: "new-id" }], manager.getBranch())).toBe(
			buildKnowledgeContext([]),
		);
	});

	it("filters a prepared prompt after removal without losing its extension hook", async () => {
		const harness = await createHarness({ withAgentDir: true });
		try {
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a, b] });
			await writeFile(join(harness.tempDir, "knowledge-libraries.json"), JSON.stringify({ libraries: [b] }));
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("prepared", {
				hookEvaluated: true,
				hookContext: `extension hook\n\n${buildKnowledgeContext([a, b])}`,
			});
			const user = harness.session.messages.find((message) => message.role === "user") as
				| { hookContext?: string }
				| undefined;
			expect(user?.hookContext).toBe(`extension hook\n\n${buildKnowledgeContext([b])}`);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps the provider history prefix stable while registered links are unchanged", async () => {
		const harness = await createHarness({ withAgentDir: true });
		try {
			await writeFile(join(harness.tempDir, "knowledge-libraries.json"), JSON.stringify({ libraries: [a] }));
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			const requests: unknown[][] = [];
			harness.setResponses(
				["first", "second"].map((answer) => async (context: Context) => {
					requests.push(structuredClone(context.messages));
					return fauxAssistantMessage(answer);
				}),
			);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
			expect(JSON.stringify(requests[1].at(-1))).not.toContain("<knowledge_context>");
		} finally {
			await harness.cleanup();
		}
	});

	it("overrides a queued old block at provider time without rewriting its history", async () => {
		const harness = await createHarness({ withAgentDir: true });
		let release!: () => void;
		let started!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const requests: unknown[] = [];
		try {
			const catalog = join(harness.tempDir, "knowledge-libraries.json");
			await writeFile(catalog, JSON.stringify({ libraries: [a] }));
			harness.setResponses([
				async () => {
					started();
					await gate;
					return fauxAssistantMessage("first");
				},
				async (context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("queued");
				},
			]);
			const running = harness.session.prompt("first request");
			await firstStarted;
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			await harness.session.prompt("queued request", { streamingBehavior: "followUp" });
			await writeFile(catalog, JSON.stringify({ libraries: [] }));
			release();
			await running;
			expect(requests).toHaveLength(1);
			const last = (requests[0] as unknown[]).at(-1);
			expect(JSON.stringify(last)).toContain("当前对话已取消链接知识库");
			const queued = harness.session.messages.find(
				(message) => message.role === "user" && getMessageText(message) === "queued request",
			) as { hookContext?: string } | undefined;
			// The accepted message is not rewritten just to update the provider view.
			expect(queued?.hookContext).toBe(buildKnowledgeContext([a]));
			expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		} finally {
			release();
			await harness.cleanup();
		}
	});

	it("keeps host-less catalog compatibility and rejects a corrupt catalog before model execution", async () => {
		const harness = await createHarness({ withAgentDir: true });
		try {
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not execute")]);
			await harness.session.prompt("without catalog");
			const user = harness.session.messages.find((message) => message.role === "user") as
				| { hookContext?: string }
				| undefined;
			expect(user?.hookContext).toBe(buildKnowledgeContext([a]));
			await writeFile(join(harness.tempDir, "knowledge-libraries.json"), '{"libraries":false}');
			await expect(harness.session.prompt("corrupt catalog")).rejects.toThrow("Invalid knowledge directory catalog");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not make unrelated conversations depend on the knowledge directory catalog", async () => {
		const harness = await createHarness({ withAgentDir: true });
		try {
			await writeFile(join(harness.tempDir, "knowledge-libraries.json"), "{");
			harness.setResponses([fauxAssistantMessage("normal response")]);
			await harness.session.prompt("ordinary request");
			expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("declares removal after compaction even when an old block remains only inside the summary", async () => {
		const harness = await createHarness({ withAgentDir: true });
		try {
			const catalog = join(harness.tempDir, "knowledge-libraries.json");
			await writeFile(catalog, JSON.stringify({ libraries: [a] }));
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			const requests: unknown[] = [];
			harness.setResponses([
				async (context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			harness.session.agent.state.messages = [
				{ role: "compactionSummary", summary: buildKnowledgeContext([a]), tokensBefore: 1, timestamp: 1 },
			];
			await writeFile(catalog, JSON.stringify({ libraries: [] }));
			await harness.session.prompt("after removal");
			expect(JSON.stringify((requests[0] as unknown[]).at(-1))).toContain("当前对话已取消链接知识库");
		} finally {
			await harness.cleanup();
		}
	});
});
