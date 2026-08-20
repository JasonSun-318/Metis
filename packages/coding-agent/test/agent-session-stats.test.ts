import { Agent } from "@metis/agent-core";
import { type AssistantMessage, getModel, type Usage } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness as createRuntimeHarness } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});

	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getSessionStats", () => {
	it("uses an estimated snapshot when restoring existing messages", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toEqual(session.getContextUsage());
			expect(stats.contextUsage?.basis).toBe("estimated_total");
			expect(stats.contextUsage?.tokens ?? 0).toBeGreaterThan(0);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.breakdown?.reduce((sum, item) => sum + item.tokens, 0)).toBe(
				stats.contextUsage?.tokens,
			);
		} finally {
			session.dispose();
		}
	});

	it("estimates current context usage immediately after compaction", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			// Totals cover ALL entries, including history compacted away (180k + 195k).
			expect(stats.tokens.input).toBe(375_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.basis).toBe("estimated_total");
			expect(stats.contextUsage?.tokens ?? 0).toBeGreaterThan(0);
			expect(stats.contextUsage?.breakdown?.reduce((sum, item) => sum + item.tokens, 0)).toBe(
				stats.contextUsage?.tokens,
			);
		} finally {
			session.dispose();
		}
	});

	it("does not reuse persisted post-compaction usage without a live request snapshot", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			// Totals cover ALL entries, including history compacted away (180k + 195k + 25k).
			expect(stats.tokens.input).toBe(400_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.basis).toBe("estimated_total");
			expect(stats.contextUsage?.tokens).not.toBe(25_000);
		} finally {
			session.dispose();
		}
	});

	it("ignores zero-usage messages when checking for post-compaction context usage", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6));
			sessionManager.appendMessage(createUserMessage("continue", 7));
			sessionManager.appendMessage(createAssistantMessage("partial", 0, 8));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.basis).toBe("estimated_total");
			expect(stats.contextUsage?.tokens ?? 0).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});

	it("promotes a prepared estimate to a reported total after a valid response", async () => {
		const harness = createRuntimeHarness({
			systemPrompt: "SYSTEM",
			responses: [{ text: "answer", usage: { input: 80, output: 20, totalTokens: 100 } }],
		});
		try {
			await harness.session.prompt("hello");
			const usage = harness.session.getContextUsage();
			expect(usage?.basis).toBe("reported_total");
			expect(usage?.tokens).toBe(100);
			expect(usage?.breakdown?.reduce((sum, item) => sum + item.tokens, 0)).toBe(100);
		} finally {
			harness.cleanup();
		}
	});

	it("calibrates fixed modules once per model and keeps them stable without usage", async () => {
		const harness = createRuntimeHarness({
			systemPrompt: "SYSTEM",
			responses: [
				{ text: "first", usage: { totalTokens: 100 } },
				{ text: "second", usage: { totalTokens: 140 } },
				{ text: "third", usage: { totalTokens: 1_000 } },
				{ text: "fourth", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
			],
		});
		const fixedCategories = new Set([
			"system_prompt",
			"tool_definitions",
			"rules",
			"skills",
			"mcp_dynamic_tools",
			"subagent_definitions",
		]);
		const fixed = (breakdown: NonNullable<ReturnType<typeof harness.session.getContextUsage>>["breakdown"]) =>
			new Map(
				breakdown?.filter((item) => fixedCategories.has(item.category)).map((item) => [item.category, item.tokens]),
			);
		try {
			await harness.session.prompt("one");
			const first = harness.session.getContextUsage();
			expect(first?.tokens).toBe(100);
			expect(fixed(first?.breakdown)).not.toEqual(new Map());

			await harness.session.prompt("two");
			const second = harness.session.getContextUsage();
			expect(second?.tokens).toBe(140);
			expect(fixed(second?.breakdown)).toEqual(fixed(first?.breakdown));

			harness.session.agent.state.model = {
				...harness.session.agent.state.model,
				id: "faux-2",
			};
			await harness.session.prompt("three");
			const third = harness.session.getContextUsage();
			expect(third?.tokens).toBe(1_000);
			expect(fixed(third?.breakdown)).not.toEqual(fixed(second?.breakdown));

			await harness.session.prompt("four");
			const fourth = harness.session.getContextUsage();
			expect(fourth?.tokens ?? 0).toBeGreaterThan(1_000);
			expect(fixed(fourth?.breakdown)).toEqual(fixed(third?.breakdown));
		} finally {
			harness.cleanup();
		}
	});

	it("invalidates a reported snapshot when the model changes", async () => {
		const harness = createRuntimeHarness({
			responses: [{ text: "answer", usage: { totalTokens: 100 } }],
		});
		try {
			await harness.session.prompt("hello");
			expect(harness.session.getContextUsage()?.basis).toBe("reported_total");
			harness.session.agent.state.model = {
				...harness.session.agent.state.model,
				id: "faux-2",
				contextWindow: 1_000_000,
			};
			const usage = harness.session.getContextUsage();
			expect(usage?.basis).toBe("estimated_total");
			expect(usage?.contextWindow).toBe(1_000_000);
			expect(usage?.percent).toBe(((usage?.tokens ?? 0) / 1_000_000) * 100);
		} finally {
			harness.cleanup();
		}
	});
});
