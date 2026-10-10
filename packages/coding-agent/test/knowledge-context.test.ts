import { fauxAssistantMessage } from "@metis/ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	appendKnowledgeContext,
	buildKnowledgeContext,
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
});
