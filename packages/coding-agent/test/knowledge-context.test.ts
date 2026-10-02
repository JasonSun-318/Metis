import { fauxAssistantMessage } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import {
	appendKnowledgeContext,
	buildKnowledgeContext,
	KNOWLEDGE_LINKS_CUSTOM_TYPE,
	readKnowledgeLinks,
} from "../src/core/knowledge-context.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

const a = { id: "a", name: "产品资料", path: "/Users/test/资料/产品资料" };
const b = { id: "b", name: "技术笔记", path: "/Users/test/资料/技术笔记" };
describe("Knowledge conversation context", () => {
	it("injects live bindings through AgentSession without changing skills, tools or prior messages", async () => {
		const harness = await createHarness();
		try {
			const systemPrompt = harness.session.systemPrompt;
			const tools = harness.session.getActiveToolNames();
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [a] });
			await harness.session.prompt("Original request");
			const first = harness.session.messages[0];
			expect(getMessageText(first)).toBe("Original request");
			expect(JSON.stringify(convertToLlm([first]))).toContain(a.path);
			const previous = convertToLlm([...harness.session.messages]);
			harness.sessionManager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [b] });
			await harness.session.prompt("Next request");
			const next = convertToLlm([...harness.session.messages]);
			expect(next.slice(0, previous.length)).toEqual(previous);
			expect(JSON.stringify(next[previous.length])).toContain(b.path);
			expect(harness.session.systemPrompt).toBe(systemPrompt);
			expect(harness.session.getActiveToolNames()).toEqual(tools);
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
	it("keeps the visible text and old model-message prefix unchanged after links change", () => {
		const first = {
			role: "user" as const,
			content: "Find a note",
			timestamp: 1,
			hookContext: appendKnowledgeContext("existing hook", [a]),
		};
		const before = convertToLlm([first]);
		const second = {
			role: "user" as const,
			content: "Find another note",
			timestamp: 2,
			hookContext: appendKnowledgeContext(undefined, [b]),
		};
		const after = convertToLlm([first, second]);
		expect(first.content).toBe("Find a note");
		expect(after[0]).toEqual(before[0]);
		expect(JSON.stringify(after[1])).toContain(b.path);
		expect(first.hookContext).toContain("existing hook");
	});
	it("preserves captured context for replay and communicates an unlinked state", () => {
		const captured = appendKnowledgeContext(undefined, [a]);
		expect(appendKnowledgeContext(captured, [b])).toBe(captured);
		expect(buildKnowledgeContext([])).toContain("当前对话未链接知识库");
	});
});
