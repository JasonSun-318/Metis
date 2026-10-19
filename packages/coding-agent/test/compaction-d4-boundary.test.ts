import {
	type AgentMessage,
	buildSessionContext as agentBuildSessionContext,
	collectEntriesForBranchSummary as agentCollectEntriesForBranchSummary,
	compact as agentCompact,
	estimateTokens as agentEstimateTokens,
	findCutPoint as agentFindCutPoint,
	findTurnStartIndex as agentFindTurnStartIndex,
	generateBranchSummary as agentGenerateBranchSummary,
	generateSummary as agentGenerateSummary,
	prepareCompaction as agentPrepareCompaction,
	serializeConversation as agentSerializeConversation,
} from "@metis/agent-core";
import type { AssistantMessage, Context, Model, TextContent, UserMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import {
	collectEntriesForBranchSummary as codingCollectEntriesForBranchSummary,
	compact as codingCompact,
	estimateTokens as codingEstimateTokens,
	findCutPoint as codingFindCutPoint,
	findTurnStartIndex as codingFindTurnStartIndex,
	generateBranchSummary as codingGenerateBranchSummary,
	generateSummary as codingGenerateSummary,
	prepareCompaction as codingPrepareCompaction,
	serializeConversation as codingSerializeConversation,
} from "../src/core/compaction/index.ts";
import {
	type BranchSummaryEntry,
	type CustomMessageEntry,
	buildSessionContext as codingBuildSessionContext,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.ts";

const TS = "2026-10-19T00:00:00.000Z";

type AnthropicModel = Model<"anthropic-messages">;

function createModel(overrides: Partial<AnthropicModel> = {}): AnthropicModel {
	return {
		id: "d4-model",
		name: "D4 Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	};
}

function assistantResponse(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return assistantResponse("", { content });
}

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: TS, message };
}

function customEntry(content: CustomMessageEntry["content"]): CustomMessageEntry {
	return {
		type: "custom_message",
		id: "custom-1",
		parentId: null,
		timestamp: TS,
		customType: "legacy",
		content,
		display: true,
	};
}

function branchEntry(id: string, parentId: string | null, summary: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: TS, fromId: "from", summary };
}

type AgentModels = Parameters<typeof agentGenerateSummary>[1];
type AgentCompleteSimple = AgentModels["completeSimple"];
type AgentCall = {
	context: Parameters<AgentCompleteSimple>[1];
	options: Parameters<AgentCompleteSimple>[2];
};

function fakeAgentModels(response: AssistantMessage): {
	models: AgentModels;
	calls: AgentCall[];
} {
	const calls: AgentCall[] = [];
	const completeSimple: AgentCompleteSimple = async (_model, context, options) => {
		calls.push({ context, options });
		return response;
	};
	// Partial Models port double: generateSummary only calls completeSimple.
	const models = { completeSimple } as unknown as AgentModels;
	return { models, calls };
}

type CodingStreamFn = NonNullable<Parameters<typeof codingGenerateSummary>[9]>;
type CodingCall = {
	context: Parameters<CodingStreamFn>[1];
	options: Parameters<CodingStreamFn>[2];
};
type CodingStreamResult = Awaited<ReturnType<CodingStreamFn>>;

function fakeCodingStream(response: AssistantMessage): {
	streamFn: CodingStreamFn;
	calls: CodingCall[];
} {
	const calls: CodingCall[] = [];
	const streamFn: CodingStreamFn = async (_model, context, options) => {
		calls.push({ context, options });
		// Minimal stream double: the summarizer only consumes result().
		return { result: async () => response } as unknown as CodingStreamResult;
	};
	return { streamFn, calls };
}

function promptFrom(call: { context: Context }): string {
	const content = call.context.messages[0]?.content;
	if (content === undefined || typeof content === "string") return content ?? "";
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function emptyFileOps(): Parameters<typeof codingCompact>[0]["fileOps"] {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

const settings: Parameters<typeof codingPrepareCompaction>[1] = {
	enabled: true,
	reserveTokens: 2000,
	keepRecentTokens: 20,
};

describe("compaction agent/coding boundary", () => {
	it("preserves existing circular tool-call serialization fallback and throw", () => {
		const circular: Record<string, unknown> = { path: "a.ts" };
		circular.self = circular;
		const message = assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: circular }]);

		expect(agentSerializeConversation([message])).toBe(
			'[Assistant tool calls]: read(path="a.ts", self=[unserializable])',
		);
		expect(agentEstimateTokens(message)).toBe(5);
		expect(() => codingSerializeConversation([message])).toThrow(TypeError);
		expect(() => codingSerializeConversation([message])).toThrow(/Converting circular structure to JSON/);
		expect(() => codingEstimateTokens(message)).toThrow(TypeError);
		expect(() => codingEstimateTokens(message)).toThrow(/Converting circular structure to JSON/);
	});

	it("preserves existing custom and branch cut-point budgets plus turn-start scanning", () => {
		const u = entry("u", null, user("hi"));
		const a = entry("a", "u", assistant([{ type: "text", text: "hello" }]));
		const custom = customEntry("x".repeat(4000));
		custom.parentId = "a";
		const tail = entry("tail", "custom-1", assistant([{ type: "text", text: "ok" }]));

		expect(agentFindCutPoint([u, a, custom, tail], 0, 4, 2)).toEqual({
			firstKeptEntryIndex: 1,
			turnStartIndex: 0,
			isSplitTurn: true,
		});
		expect(codingFindCutPoint([u, a, custom, tail], 0, 4, 2)).toEqual({
			firstKeptEntryIndex: 2,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const branch = branchEntry("branch", "u", "branch summary");
		const branchTail = entry("branch-tail", "branch", assistant([{ type: "text", text: "a" }]));
		expect(agentFindCutPoint([u, branch, branchTail], 0, 3, 0)).toEqual({
			firstKeptEntryIndex: 1,
			turnStartIndex: 1,
			isSplitTurn: true,
		});
		expect(codingFindCutPoint([u, branch, branchTail], 0, 3, 0)).toEqual({
			firstKeptEntryIndex: 2,
			turnStartIndex: 1,
			isSplitTurn: true,
		});

		const customRole = entry("custom-role", "u", {
			role: "custom",
			customType: "legacy",
			content: "x",
			display: true,
			timestamp: 0,
		});
		const customTail = entry("custom-tail", "custom-role", assistant([{ type: "text", text: "a" }]));
		expect(agentFindTurnStartIndex([u, customRole, customTail], 2, 0)).toBe(0);
		expect(codingFindTurnStartIndex([u, customRole, customTail], 2, 0)).toBe(1);

		const branchRole = entry("branch-role", "u", {
			role: "branchSummary",
			summary: "branch",
			fromId: "from",
			timestamp: 0,
		});
		const branchRoleTail = entry("branch-role-tail", "branch-role", assistant([{ type: "text", text: "a" }]));
		expect(agentFindTurnStartIndex([u, branchRole, branchRoleTail], 2, 0)).toBe(0);
		expect(codingFindTurnStartIndex([u, branchRole, branchRoleTail], 2, 0)).toBe(1);
	});

	it("preserves existing legacy custom and null message projection", () => {
		// Legacy sessions can omit custom content and null user content; the public
		// fixture types model the valid shape, so these two malformed values are
		// narrowed locally where the parser-compatible fixture is constructed.
		const custom = customEntry(undefined as unknown as CustomMessageEntry["content"]);
		const nullUser = entry("null-user", "custom-1", user(null as unknown as UserMessage["content"]));

		const agentContext = agentBuildSessionContext([custom, nullUser]);
		const agentCustom = agentContext.messages[0];
		const agentUser = agentContext.messages[1];
		expect(agentCustom?.role).toBe("custom");
		expect(agentUser?.role).toBe("user");
		if (agentCustom?.role !== "custom" || agentUser?.role !== "user") throw new Error("unexpected projection");
		expect(agentCustom.content).toBeUndefined();
		expect(agentUser.content).toBeNull();

		const codingContext = codingBuildSessionContext([custom, nullUser]);
		const codingCustom = codingContext.messages[0];
		const codingUser = codingContext.messages[1];
		expect(codingCustom?.role).toBe("custom");
		expect(codingUser?.role).toBe("user");
		if (codingCustom?.role !== "custom" || codingUser?.role !== "user") throw new Error("unexpected projection");
		expect(codingCustom.content).toEqual([]);
		expect(codingUser.content).toEqual([]);
	});

	it("preserves existing legacy attachment text and image projection through summary conversion", async () => {
		const legacySingular =
			'<attachment>\n\t{"name":"  first.txt  ","path":"/tmp/first","size":1,"mime":"text/plain","extra":{"nested":true}}\n</attachment>';
		const legacyPlural =
			'<attachments>[{"name":"a.txt","path":"/tmp/a","size":2,"mime":"x"},{"name":"b.txt","path":"/tmp/b","size":3}]</attachments>';
		const malformed = "<attachment>{not json}</attachment>";
		const message = user([
			{ type: "text", text: `${legacySingular}\n${legacyPlural}\n${malformed} tail` },
			{ type: "image", mimeType: "image/png", data: "IMAGE_DATA" },
		]);
		const agent = fakeAgentModels(assistantResponse("X"));
		const coding = fakeCodingStream(assistantResponse("X"));

		const agentResult = await agentGenerateSummary([message], agent.models, createModel(), 2000);
		const codingResult = await codingGenerateSummary(
			[message],
			createModel(),
			2000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			coding.streamFn,
		);
		const agentPrompt = promptFrom(agent.calls[0]);
		const codingPrompt = promptFrom(coding.calls[0]);

		expect(agentResult).toMatchObject({ ok: true, value: "X" });
		expect(codingResult).toBe("X");
		for (const prompt of [agentPrompt, codingPrompt]) {
			expect(prompt).toContain(legacySingular);
			expect(prompt).toContain(legacyPlural);
			expect(prompt).toContain(malformed);
			expect(prompt).not.toContain("IMAGE_DATA");
			expect(prompt).not.toContain("[first.txt]");
			expect(prompt).toContain("<conversation>");
		}
	});

	it("preserves existing summary abort and error transport", async () => {
		const abortedAgent = fakeAgentModels(assistantResponse("", { stopReason: "aborted", errorMessage: "stop" }));
		const abortedCoding = fakeCodingStream(assistantResponse("", { stopReason: "aborted", errorMessage: "stop" }));
		const abortedAgentResult = await agentGenerateSummary(
			[user("Summarize this.")],
			abortedAgent.models,
			createModel(),
			2000,
		);
		expect(abortedAgentResult).toMatchObject({ ok: false, error: { code: "aborted", message: "stop" } });
		const abortedCodingResult = await codingGenerateSummary(
			[user("Summarize this.")],
			createModel(),
			2000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			abortedCoding.streamFn,
		);
		expect(abortedCodingResult).toBe("");

		const errorAgent = fakeAgentModels(assistantResponse("", { stopReason: "error", errorMessage: "boom" }));
		const errorCoding = fakeCodingStream(assistantResponse("", { stopReason: "error", errorMessage: "boom" }));
		const errorAgentResult = await agentGenerateSummary(
			[user("Summarize this.")],
			errorAgent.models,
			createModel(),
			2000,
		);
		expect(errorAgentResult).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: boom" },
		});
		await expect(
			codingGenerateSummary(
				[user("Summarize this.")],
				createModel(),
				2000,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				errorCoding.streamFn,
			),
		).rejects.toThrow("Summarization failed: boom");
	});

	it("preserves existing branch abort and no-content result shapes", async () => {
		const emptyAgent = fakeAgentModels(assistantResponse(""));
		const emptyCoding = fakeCodingStream(assistantResponse(""));
		const agentEmpty = await agentGenerateBranchSummary([], {
			models: emptyAgent.models,
			model: createModel(),
			signal: new AbortController().signal,
		});
		expect(agentEmpty).toMatchObject({
			ok: true,
			value: { summary: "No content to summarize", readFiles: [], modifiedFiles: [] },
		});
		const codingEmpty = await codingGenerateBranchSummary([], {
			model: createModel(),
			signal: new AbortController().signal,
			streamFn: emptyCoding.streamFn,
		});
		expect(codingEmpty).toEqual({ summary: "No content to summarize" });

		const abortedAgent = fakeAgentModels(assistantResponse("", { stopReason: "aborted", errorMessage: "stopped" }));
		const abortedCoding = fakeCodingStream(assistantResponse("", { stopReason: "aborted", errorMessage: "stopped" }));
		const agentAborted = await agentGenerateBranchSummary([entry("u", null, user("one"))], {
			models: abortedAgent.models,
			model: createModel(),
			signal: new AbortController().signal,
		});
		expect(agentAborted).toMatchObject({
			ok: false,
			error: { name: "BranchSummaryError", code: "aborted", message: "stopped" },
		});
		const codingAborted = await codingGenerateBranchSummary([entry("u", null, user("one"))], {
			model: createModel(),
			signal: new AbortController().signal,
			streamFn: abortedCoding.streamFn,
		});
		expect(codingAborted).toEqual({ aborted: true });
	});

	it("preserves existing compact invalid-id validation order", async () => {
		const preparation = {
			firstKeptEntryId: "",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 0,
			fileOps: emptyFileOps(),
			settings,
		};
		const agent = fakeAgentModels(assistantResponse("X"));
		const coding = fakeCodingStream(assistantResponse("X"));

		const agentResult = await agentCompact(preparation, agent.models, createModel());
		expect(agentResult).toMatchObject({
			ok: false,
			error: { code: "invalid_session", message: "First kept entry has no UUID - session may need migration" },
		});
		expect(agent.calls).toHaveLength(0);

		await expect(
			codingCompact(
				preparation,
				createModel(),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				coding.streamFn,
			),
		).rejects.toThrow("First kept entry has no UUID - session may need migration");
		expect(coding.calls).toHaveLength(1);
	});

	it("preserves existing prepareCompaction result and missing-id behavior", () => {
		const thinkingEntry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: "thinking",
			parentId: null,
			timestamp: TS,
			thinkingLevel: "high",
		};
		const modelEntry: ModelChangeEntry = {
			type: "model_change",
			id: "model",
			parentId: "thinking",
			timestamp: TS,
			provider: "openai",
			modelId: "gpt",
		};
		const metadataEntries: SessionEntry[] = [thinkingEntry, modelEntry];
		const agentPrepared = agentPrepareCompaction(metadataEntries, settings);
		expect(agentPrepared).toMatchObject({
			ok: true,
			value: {
				firstKeptEntryId: "thinking",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 0,
			},
		});
		expect(codingPrepareCompaction(metadataEntries, settings)).toBeUndefined();

		// Legacy malformed session entry: id is absent at runtime.
		const missingId = { ...entry("missing", null, user("no id")), id: undefined } as unknown as SessionEntry;
		const agentMissing = agentPrepareCompaction([missingId], settings);
		expect(agentMissing).toMatchObject({
			ok: false,
			error: { name: "CompactionError", code: "invalid_session" },
		});
		expect(codingPrepareCompaction([missingId], settings)).toBeUndefined();
	});

	it("preserves existing empty branch-summary prepare projection", () => {
		const branch = branchEntry("branch", null, "");
		const u = entry("u", "branch", user("u"));
		const a = entry("a", "u", assistant([{ type: "text", text: "a" }]));
		const narrow = { enabled: true, reserveTokens: 100, keepRecentTokens: 0 };

		const agentPrepared = agentPrepareCompaction([branch, u, a], narrow);
		expect(agentPrepared).toMatchObject({
			ok: true,
			value: { firstKeptEntryId: "a", isSplitTurn: true },
		});
		if (!agentPrepared.ok || !agentPrepared.value) throw new Error("expected agent preparation");
		expect(agentPrepared.value.messagesToSummarize.map((message) => message.role)).toEqual(["branchSummary"]);
		expect(agentPrepared.value.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);

		const codingPrepared = codingPrepareCompaction([branch, u, a], narrow);
		expect(codingPrepared).toMatchObject({
			firstKeptEntryId: "a",
			messagesToSummarize: [],
			isSplitTurn: true,
		});
		expect(codingPrepared?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
	});

	it("preserves existing hookContext summary prompt projection", async () => {
		const message = user("hello");
		message.hookContext = "HOOK";
		const agent = fakeAgentModels(assistantResponse("X"));
		const coding = fakeCodingStream(assistantResponse("X"));

		const agentResult = await agentGenerateSummary([message], agent.models, createModel(), 2000);
		const codingResult = await codingGenerateSummary(
			[message],
			createModel(),
			2000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			coding.streamFn,
		);
		const agentPrompt = promptFrom(agent.calls[0]);
		const codingPrompt = promptFrom(coding.calls[0]);

		expect(agentResult).toMatchObject({ ok: true, value: "X" });
		expect(codingResult).toBe("X");
		expect(agentPrompt).not.toContain("HOOK");
		expect(codingPrompt).toContain("hello\n\nHOOK");
		expect(agentPrompt).toContain("[User]: hello");
		expect(codingPrompt).toContain("[User]: hello\n\nHOOK");
	});

	it("preserves existing normal summary request parameters and output", async () => {
		const message = user("Summarize this.");
		const model = createModel({ reasoning: true });
		const agent = fakeAgentModels(assistantResponse("## Goal\nX"));
		const coding = fakeCodingStream(assistantResponse("## Goal\nX"));

		const agentResult = await agentGenerateSummary(
			[message],
			agent.models,
			model,
			2000,
			undefined,
			"focus",
			"OLD",
			"medium",
		);
		const codingResult = await codingGenerateSummary(
			[message],
			model,
			2000,
			undefined,
			undefined,
			undefined,
			"focus",
			"OLD",
			"medium",
			coding.streamFn,
		);
		const agentCall = agent.calls[0];
		const codingCall = coding.calls[0];
		const agentPrompt = promptFrom(agentCall);
		const codingPrompt = promptFrom(codingCall);

		expect(agentResult).toMatchObject({ ok: true, value: "## Goal\nX" });
		expect(codingResult).toBe("## Goal\nX");
		expect(agentCall.options?.maxTokens).toBe(1600);
		expect(codingCall.options?.maxTokens).toBe(1600);
		expect(agentCall.options?.reasoning).toBe("medium");
		expect(codingCall.options?.reasoning).toBe("medium");
		for (const prompt of [agentPrompt, codingPrompt]) {
			expect(prompt).toContain("<previous-summary>\nOLD\n</previous-summary>");
			expect(prompt).toContain("Additional focus: focus");
			expect(prompt).toContain("[User]: Summarize this.");
		}
		expect(agentCall.context.systemPrompt).toContain("context summarization assistant");
		expect(codingCall.context.systemPrompt).toContain("context summarization assistant");
		expect(agentCall.context.systemPrompt).toContain("Do NOT continue the conversation.");
		expect(codingCall.context.systemPrompt).toContain("Do NOT continue the conversation.");
	});

	it("preserves existing missing-entry branch collection behavior", async () => {
		const root = { type: "message", id: "root", parentId: null, timestamp: TS, message: user("root") };
		const target = { type: "message", id: "target", parentId: "root", timestamp: TS, message: user("target") };
		const oldPathEntry = { type: "message", id: "old", parentId: "root", timestamp: TS, message: user("old") };
		const agentSession = {
			getBranch: async (id: string) => (id === "old" ? [root, oldPathEntry] : [root, target]),
			getEntry: async () => undefined,
		};
		const codingSession = {
			getBranch: (id: string) => (id === "old" ? [root, oldPathEntry] : [root, target]),
			getEntry: () => undefined,
		};

		// Partial session port doubles: only getBranch/getEntry are read here.
		const agentPort = agentSession as unknown as Parameters<typeof agentCollectEntriesForBranchSummary>[0];
		const codingPort = codingSession as unknown as Parameters<typeof codingCollectEntriesForBranchSummary>[0];
		await expect(agentCollectEntriesForBranchSummary(agentPort, "old", "target")).rejects.toThrow(
			"Entry old not found",
		);
		const codingResult = codingCollectEntriesForBranchSummary(codingPort, "old", "target");
		expect(codingResult).toEqual({ entries: [], commonAncestorId: "root" });
	});
});
