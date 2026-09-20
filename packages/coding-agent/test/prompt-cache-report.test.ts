import type { PromptCacheRequestSnapshot } from "@metis/ai";
import { fauxAssistantMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import { buildPromptCacheReport, comparePromptCacheRequests } from "../src/core/prompt-cache-report.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const fp = (digest: string) => ({ digest, bytes: 10 });
const snapshot = (): PromptCacheRequestSnapshot => ({
	version: 1,
	boundary: "adapter-payload",
	api: "openai-completions",
	provider: "GLM",
	model: "glm-5.3-flash",
	endpointDigest: "e",
	capturedAt: 1,
	settings: fp("s"),
	system: fp("y"),
	tools: fp("t"),
	history: fp("h"),
	messages: [fp("m")],
	messageCount: 1,
	complete: true,
});

describe("cache request report", () => {
	it("distinguishes missing evidence, appends, setting changes and history edits", () => {
		const a = snapshot();
		expect(comparePromptCacheRequests(undefined, a).status).toBe("missing-snapshot");
		expect(comparePromptCacheRequests(a, a).status).toBe("identical");
		expect(
			comparePromptCacheRequests(a, { ...a, messages: [...a.messages, fp("new")], messageCount: 2 }).status,
		).toBe("append");
		expect(comparePromptCacheRequests(a, { ...a, system: fp("changed") })).toMatchObject({
			status: "request-changed",
			changedSections: ["system"],
		});
		expect(comparePromptCacheRequests(a, { ...a, messages: [fp("changed")] })).toMatchObject({
			status: "request-changed",
			firstChangedMessage: 0,
		});
		expect(comparePromptCacheRequests(a, { ...a, complete: false }).status).toBe("truncated-snapshot");
		expect(comparePromptCacheRequests(a, { ...a, model: "other" }).status).toBe("model-or-api-change");
		expect(comparePromptCacheRequests(a, { ...a, endpointDigest: "other" }).status).toBe("endpoint-change");
	});
	it("replays 0%, 0%, 38.946% without inventing a cause when request evidence is missing", () => {
		const entries: SessionEntry[] = [
			[16061, 0],
			[16358, 0],
			[10033, 6400],
		].map(([input, cacheRead], index) => ({
			type: "message",
			id: String(index),
			parentId: null,
			timestamp: new Date(index * 1000).toISOString(),
			message: {
				...fauxAssistantMessage("private-response"),
				usage: { ...fauxAssistantMessage("").usage, input: input!, cacheRead: cacheRead!, cacheReported: true },
			},
		}));
		const rows = buildPromptCacheReport(entries);
		expect(rows.map((row) => row.hitPercent)).toEqual([0, 0, (6400 / 16433) * 100]);
		expect(rows[2]?.comparison.status).toBe("missing-snapshot");
		expect(JSON.stringify(rows)).not.toContain("private-response");
		const last = entries[2]!;
		if (last.type === "message" && last.message.role === "assistant") {
			last.message.usage.cacheReported = false;
			expect(buildPromptCacheReport(entries)[2]?.hitPercent).toBeNull();
			last.message.stopReason = "error";
			entries.push({ ...last, id: "new", message: fauxAssistantMessage("done"), cacheRequest: snapshot() });
			expect(buildPromptCacheReport(entries).at(-1)?.comparison.status).toBe("previous-request-failed");
		}
	});
});
