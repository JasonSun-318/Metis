import type { Model } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "test",
	name: "Test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => vi.unstubAllGlobals());

function response(events: ProxyAssistantMessageEvent[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))),
	);
	return streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://example.invalid" });
}

describe("proxy stream terminal events", () => {
	it.each(
		(
			[
				[],
				[
					{ type: "start" },
					{ type: "text_start", contentIndex: 0 },
					{ type: "text_delta", contentIndex: 0, delta: "partial" },
				],
			] as ProxyAssistantMessageEvent[][]
		).map((events) => ({ events })),
	)(
		"settles incomplete EOF with an error ($events)",
		async ({ events }) => {
			const stream = response(events);
			const received = [];
			for await (const event of stream) received.push(event);
			expect(received.at(-1)).toMatchObject({ type: "error", reason: "error" });
			await expect(stream.result()).resolves.toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("terminal event"),
			});
		},
		1000,
	);

	it("preserves a successful terminal event", async () => {
		const stream = response([{ type: "done", reason: "stop", usage }]);
		await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("preserves an error terminal event", async () => {
		const stream = response([{ type: "error", reason: "error", errorMessage: "upstream failed", usage }]);
		await expect(stream.result()).resolves.toMatchObject({ stopReason: "error", errorMessage: "upstream failed" });
	});

	it("settles an aborted stream and cancels its reader", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new ReadableStream({ cancel }))),
		);
		const stream = streamProxy(
			model,
			{ messages: [] },
			{ authToken: "test", proxyUrl: "https://example.invalid", signal: controller.signal },
		);
		await Promise.resolve();
		controller.abort();
		await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
		expect(cancel).toHaveBeenCalledOnce();
	});
});
