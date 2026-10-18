import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("completes a Mistral stream when the optional tracing dependency is unavailable", () => {
	const script = `
		import { registerHooks } from "node:module";
		let tracingImports = 0;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@opentelemetry/api") {
					tracingImports += 1;
					throw Object.assign(new Error("Optional tracing dependency is unavailable"), {
						code: "ERR_MODULE_NOT_FOUND",
					});
				}
				return nextResolve(specifier, context);
			},
		});

		const requests = [];
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			requests.push({ url: request.url, body: await request.json() });
			const chunk = {
				id: "mistral-optional-tracing",
				object: "chat.completion.chunk",
				created: 1,
				model: "mistral-small-2603",
				choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
			};
			return new Response("data: " + JSON.stringify(chunk) + "\\n\\ndata: [DONE]\\n\\n", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const { getModel, streamSimple } = await import(${JSON.stringify(new URL("../src/compat.ts", import.meta.url).href)});
		const model = { ...getModel("mistral", "mistral-small-2603"), baseUrl: "https://mistral.invalid" };
		const response = await streamSimple(model, {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		}, { apiKey: "test-key" }).result();
		console.log(JSON.stringify({ tracingImports, requests, response }));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		encoding: "utf8",
		timeout: 20_000,
	});
	if (child.error || child.status !== 0) {
		throw new Error(`Mistral probe failed: ${child.error ?? child.status}\n${child.stdout}\n${child.stderr}`);
	}
	const result = JSON.parse(child.stdout.trim());
	expect(result.tracingImports).toBeGreaterThan(0);
	expect(result.requests).toHaveLength(1);
	expect(result.requests[0]).toMatchObject({
		url: "https://mistral.invalid/v1/chat/completions",
		body: { model: "mistral-small-2603", stream: true, messages: [{ role: "user", content: "Hello" }] },
	});
	expect(result.response.stopReason).toBe("stop");
	expect(result.response.content).toEqual([{ type: "text", text: "Ready" }]);
	expect(result.response.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 });
});
