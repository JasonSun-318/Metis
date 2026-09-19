import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@metis/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import { applyContextRewrites, type ContextSource } from "../src/core/context-view.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	getMicrocompactionTarget,
	type MicrocompactionOptions,
	prepareMicrocompaction,
} from "../src/core/tool-result-microcompaction.ts";

const FIXED_BUDGET = 120_000;
const HIGH = 180_000;
const LARGE = "x".repeat(40_000);
const SHORT = "short";

function textOf(message: AgentMessage): string {
	return "content" in message && Array.isArray(message.content)
		? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("")
		: "";
}

const estimateView = (messages: readonly AgentMessage[]) =>
	FIXED_BUDGET + Math.ceil(messages.reduce((sum, message) => sum + textOf(message).length, 0) / 4);

const readResult = (callId: string, text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
	...overrides,
});

const assistantWithCalls = (...ids: string[]): AssistantMessage => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
	api: "anthropic-messages",
	provider: "anthropic",
	model: "m",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1,
});

function prepareInput(
	manager: SessionManager,
	entryIds: string[],
	view: AgentMessage[],
	overrides: Partial<Parameters<typeof prepareMicrocompaction>[0]> = {},
) {
	const tokensBefore = estimateView(view);
	const target = getMicrocompactionTarget({ used: tokensBefore, high: HIGH, growthP95: 5000 });
	expect(target).toBeDefined();
	return {
		mode: "pressure" as const,
		sources: entryIds.map((entryId, index) => ({ entryId, message: view[index]! }) satisfies ContextSource),
		view,
		batches: manager.getContextRewrites(),
		expectedLeafId: manager.getLeafId(),
		protectedEntryIds: new Set<string>(),
		target: target!,
		tokensBefore,
		...overrides,
	};
}

const optionsFor = (
	outputDir: string,
	isBuiltinTool: (name: string) => boolean = () => true,
): MicrocompactionOptions => ({
	outputDir,
	isBuiltinTool,
	estimateView,
});

async function seedTwelve(manager: SessionManager) {
	const view: AgentMessage[] = [];
	const entryIds: string[] = [];
	for (let index = 0; index < 12; index++) {
		const assistant = assistantWithCalls(`call-${index}`);
		entryIds.push(manager.appendMessage(assistant));
		view.push(assistant);
		const message = readResult(`call-${index}`, index < 7 ? LARGE : SHORT);
		entryIds.push(manager.appendMessage(message));
		view.push(message);
	}
	return { entryIds, view };
}

describe("prepareMicrocompaction", () => {
	it("prepares, commits, and replays a batch; no second batch below the watermark", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-microbatch-"));
		const outputDir = join(root, "tool-results");
		const manager = SessionManager.inMemory();
		try {
			const { entryIds, view } = await seedTwelve(manager);
			const input = prepareInput(manager, entryIds, view);
			const batch = await prepareMicrocompaction(input, optionsFor(outputDir));
			expect(batch).toBeDefined();
			expect(batch!.tokensAfter).toBeLessThanOrEqual(input.target.low);
			expect(input.tokensBefore - batch!.tokensAfter).toBeGreaterThanOrEqual(input.target.minimumGain);

			const rewritten = new Set(batch!.replacements.map((r) => r.sourceEntryId));
			expect(batch!.replacements.length).toBeGreaterThanOrEqual(4);
			const resultIds = entryIds.filter((_, index) => index % 2 === 1);
			for (const entryId of resultIds.slice(7)) expect(rewritten.has(entryId)).toBe(false); // recent five protected
			manager.appendContextRewrite(batch!);
			const filesAfterCommit = readdirSync(outputDir).length;
			expect(filesAfterCommit).toBe(batch!.replacements.length);

			// New short result arrives; replay stays below the high watermark.
			const extraAssistant = assistantWithCalls("call-12");
			const extraAssistantId = manager.appendMessage(extraAssistant);
			const extra = readResult("call-12", SHORT);
			const extraId = manager.appendMessage(extra);
			const allSources: ContextSource[] = [
				...entryIds.map((entryId, index) => ({ entryId, message: view[index]! })),
				{ entryId: extraAssistantId, message: extraAssistant },
				{ entryId: extraId, message: extra },
			];
			const replayed = applyContextRewrites(allSources, manager.getContextRewrites());
			const replayedTexts = replayed.map((m) => textOf(m));
			for (const replacement of batch!.replacements) {
				const index = entryIds.indexOf(replacement.sourceEntryId);
				expect(replayedTexts[index]).toBe(replacement.content.map((b) => b.text).join(""));
			}
			const used = estimateView(replayed);
			expect(used).toBeLessThan(HIGH);
			expect(getMicrocompactionTarget({ used, high: HIGH, growthP95: 5000 })).toBeUndefined();
			expect(manager.getContextRewrites()).toHaveLength(1);
			expect(readdirSync(outputDir)).toHaveLength(filesAfterCommit);
			manager.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rearms immediately when a large output pushes usage past high again", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-microbatch-"));
		const outputDir = join(root, "tool-results");
		const manager = SessionManager.inMemory();
		try {
			const { entryIds, view } = await seedTwelve(manager);
			const batch = await prepareMicrocompaction(prepareInput(manager, entryIds, view), optionsFor(outputDir));
			manager.appendContextRewrite(batch!);

			const extraSources: ContextSource[] = [];
			for (let index = 0; index < 4; index++) {
				const extraAssistant = assistantWithCalls(`extra-${index}`);
				const extraAssistantId = manager.appendMessage(extraAssistant);
				const extra = readResult(`extra-${index}`, LARGE);
				const extraId = manager.appendMessage(extra);
				extraSources.push(
					{ entryId: extraAssistantId, message: extraAssistant },
					{ entryId: extraId, message: extra },
				);
			}
			const allSources: ContextSource[] = [
				...entryIds.map((entryId, index) => ({ entryId, message: view[index]! })),
				...extraSources,
			];
			const replayed = applyContextRewrites(allSources, manager.getContextRewrites());
			const used = estimateView(replayed);
			const target = getMicrocompactionTarget({ used, high: HIGH, growthP95: 5000 });
			expect(target).toBeDefined(); // no cooldown blocks capacity protection
			manager.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["error-result", "readback-source"] as const)(
		"returns undefined when the only large candidates are protected (%s)",
		async (mode) => {
			const root = mkdtempSync(join(tmpdir(), "metis-microbatch-"));
			const outputDir = join(root, "tool-results");
			const manager = SessionManager.inMemory();
			try {
				const view: AgentMessage[] = [];
				const entryIds: string[] = [];
				const resultIds: string[] = [];
				for (let index = 0; index < 12; index++) {
					const assistant = assistantWithCalls(`call-${index}`);
					entryIds.push(manager.appendMessage(assistant));
					view.push(assistant);
					const message = readResult(`call-${index}`, index < 7 ? LARGE : SHORT, {
						isError: mode === "error-result" && index < 7,
					});
					entryIds.push(manager.appendMessage(message));
					resultIds.push(entryIds[entryIds.length - 1]!);
					view.push(message);
				}
				const protectedEntryIds = mode === "readback-source" ? new Set(resultIds.slice(0, 7)) : new Set<string>();
				const before = view.map((m) => textOf(m));
				const batch = await prepareMicrocompaction(
					prepareInput(manager, entryIds, view, { protectedEntryIds }),
					optionsFor(outputDir),
				);
				expect(batch).toBeUndefined();
				expect(view.map((m) => textOf(m))).toEqual(before);
				manager.close();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it.each(["recent-five", "pending-tool-group"] as const)(
		"keeps protected entries out of replacements (%s)",
		async (mode) => {
			const root = mkdtempSync(join(tmpdir(), "metis-microbatch-"));
			const outputDir = join(root, "tool-results");
			const manager = SessionManager.inMemory();
			try {
				const view: AgentMessage[] = [];
				const entryIds: string[] = [];
				if (mode === "pending-tool-group") {
					const assistant = assistantWithCalls("group-a", "group-b");
					entryIds.push(manager.appendMessage(assistant));
					view.push(assistant);
					const grouped = readResult("group-a", LARGE);
					entryIds.push(manager.appendMessage(grouped));
					view.push(grouped);
					for (let index = 0; index < 6; index++) {
						const peer = assistantWithCalls(`call-${index}`);
						entryIds.push(manager.appendMessage(peer));
						view.push(peer);
						const message = readResult(`call-${index}`, LARGE);
						entryIds.push(manager.appendMessage(message));
						view.push(message);
					}
					for (let index = 0; index < 5; index++) {
						const peer = assistantWithCalls(`late-${index}`);
						entryIds.push(manager.appendMessage(peer));
						view.push(peer);
						const message = readResult(`late-${index}`, SHORT);
						entryIds.push(manager.appendMessage(message));
						view.push(message);
					}
				} else {
					const seeded = await seedTwelve(manager);
					entryIds.push(...seeded.entryIds);
					view.push(...seeded.view);
				}
				const batch = await prepareMicrocompaction(prepareInput(manager, entryIds, view), optionsFor(outputDir));
				expect(batch).toBeDefined();
				const rewritten = new Set(batch!.replacements.map((r) => r.sourceEntryId));
				if (mode === "recent-five") {
					const resultIds = entryIds.filter((_, index) => index % 2 === 1);
					for (const entryId of resultIds.slice(7)) expect(rewritten.has(entryId)).toBe(false);
				} else {
					expect(rewritten.has(entryIds[1]!)).toBe(false); // group-b still pending
				}
				manager.close();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("does not compact results whose tool name is shadowed by a non-builtin", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-microbatch-"));
		const outputDir = join(root, "tool-results");
		const manager = SessionManager.inMemory();
		try {
			const { entryIds, view } = await seedTwelve(manager);
			const batch = await prepareMicrocompaction(
				prepareInput(manager, entryIds, view),
				optionsFor(outputDir, (name) => name !== "read"), // MCP tool shadows "read"
			);
			expect(batch).toBeUndefined();
			expect(entryIds.every((id) => manager.getEntry(id) !== undefined)).toBe(true);
			manager.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
