import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SettingsManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import { buildModelListUrl, discoverModels } from "../src/model-discovery.ts";
import { ModelSettingsService } from "../src/model-settings.ts";

interface TestServer {
	readonly url: string;
	readonly requests: Array<{ url: string; headers: IncomingMessage["headers"] }>;
	close(): Promise<void>;
}

const servers: TestServer[] = [];
const tempDirs: string[] = [];

async function listen(
	handler: (request: IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<TestServer> {
	const requests: TestServer["requests"] = [];
	const server: Server = createServer((request, response) => {
		requests.push({ url: request.url ?? "", headers: request.headers });
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
	const testServer: TestServer = {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
	servers.push(testServer);
	return testServer;
}

function temporaryAgentDir(): string {
	const dir = join(tmpdir(), `metis-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildModelListUrl", () => {
	it("preserves base paths and adds the list endpoint", () => {
		expect(buildModelListUrl("https://proxy.example/v1/", "openai-completions").toString()).toBe(
			"https://proxy.example/v1/models",
		);
		expect(buildModelListUrl("https://proxy.example/openai/v1", "openai-responses").toString()).toBe(
			"https://proxy.example/openai/v1/models",
		);
	});

	it("adds /v1 for the official Anthropic root and pages with after_id", () => {
		const first = buildModelListUrl("https://api.anthropic.com", "anthropic-messages");
		expect(first.pathname).toBe("/v1/models");
		expect(first.searchParams.get("limit")).toBe("100");
		const next = buildModelListUrl("https://api.anthropic.com", "anthropic-messages", "last-id");
		expect(next.searchParams.get("after_id")).toBe("last-id");
	});

	it("rejects embedded credentials and non-HTTP URLs", () => {
		expect(() => buildModelListUrl("https://user:pass@example.test/v1", "openai-completions")).toThrow(
			/embedded credentials/,
		);
		expect(() => buildModelListUrl("file:///tmp/models", "openai-completions")).toThrow(/HTTP or HTTPS/);
	});
});

describe("discoverModels", () => {
	it("paginates, dedupes by id, and reads only explicit capabilities", async () => {
		const server = await listen((request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			response.setHeader("content-type", "application/json");
			if (url.searchParams.get("after_id") === "page-1") {
				response.end(
					JSON.stringify({
						data: [
							{ id: "b", display_name: "B duplicate", capabilities: { vision: false } },
							{
								id: "c",
								display_name: "C",
								context_length: 200_000,
								max_completion_tokens: 8_192,
								architecture: { input_modalities: ["text", "image"] },
							},
						],
						has_more: false,
					}),
				);
				return;
			}
			response.end(
				JSON.stringify({
					data: [
						{
							id: "a",
							display_name: "A",
							context_window: 128_000,
							max_output_tokens: 16_384,
							architecture: { input_modalities: ["text"] },
						},
						{ id: "b", display_name: "B" },
						{ id: "vision-by-name", display_name: "Vision Model" },
					],
					has_more: true,
					last_id: "page-1",
				}),
			);
		});

		const result = await discoverModels(
			{ baseUrl: `${server.url}/v1`, api: "anthropic-messages" },
			{ apiKey: "server-secret" },
		);
		expect(result.models).toEqual([
			{ modelId: "a", name: "A", contextWindow: 128_000, maxOutputTokens: 16_384, imageInput: false },
			{ modelId: "b", name: "B" },
			{ modelId: "vision-by-name", name: "Vision Model" },
			{ modelId: "c", name: "C", contextWindow: 200_000, maxOutputTokens: 8_192, imageInput: true },
		]);
		expect(server.requests).toHaveLength(2);
		expect(server.requests[0]?.headers["x-api-key"]).toBe("server-secret");
		expect(server.requests[1]?.url).toContain("after_id=page-1");
		expect(server.requests[1]?.url).toContain("limit=100");
	});

	it("uses a saved provider API key without writing config files", async () => {
		const server = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: [{ id: "saved-model", name: "Saved Model" }] }));
		});
		const agentDir = temporaryAgentDir();
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(modelsPath, '{\n  "providers": {}\n}\n');
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.set("saved-provider", { type: "api_key", key: "saved-discovery-key" });
		const authBefore = readFileSync(join(agentDir, "auth.json"), "utf8");
		const modelsBefore = readFileSync(modelsPath, "utf8");
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, modelsPath),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});

		const result = await service.discover({
			provider: "saved-provider",
			baseUrl: `${server.url}/v1`,
			api: "openai-completions",
		});
		expect(result.models).toEqual([{ modelId: "saved-model", name: "Saved Model" }]);
		expect(server.requests[0]?.headers.authorization).toBe("Bearer saved-discovery-key");
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe(authBefore);
		expect(readFileSync(modelsPath, "utf8")).toBe(modelsBefore);
	});

	it("rejects embedded URL credentials before any request", async () => {
		const result = await discoverModels({
			baseUrl: "http://user:pass@127.0.0.1:9/v1",
			api: "openai-completions",
		});
		expect(result.models).toEqual([]);
		expect(result.warnings?.[0]).toMatch(/must not contain embedded credentials/);
		expect(result.warnings?.join(" ")).not.toContain("pass");
	});

	it("returns a sanitized warning on timeout", async () => {
		const server = await listen((_request, response) => {
			setTimeout(() => response.end(JSON.stringify({ data: [] })), 500);
		});
		const result = await discoverModels(
			{ baseUrl: `${server.url}/v1`, api: "openai-responses" },
			{ apiKey: "timeout-secret", timeoutMs: 30 },
		);
		expect(result.models).toEqual([]);
		expect(result.warnings?.[0]).toMatch(/timed out after 30 ms/);
		expect(result.warnings?.join(" ")).not.toContain("timeout-secret");
	});

	it("rejects oversized responses", async () => {
		const server = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: Array.from({ length: 100 }, (_, index) => ({ id: `model-${index}` })) }));
		});
		const result = await discoverModels(
			{ baseUrl: `${server.url}/v1`, api: "openai-completions" },
			{ maxBodyBytes: 128 },
		);
		expect(result.models).toEqual([]);
		expect(result.warnings?.[0]).toMatch(/exceeded the 128 byte limit/);
	});

	it("refuses cross-origin redirects without contacting the target", async () => {
		const target = await listen((_request, response) => response.end(JSON.stringify({ data: [{ id: "leak" }] })));
		const source = await listen((_request, response) => {
			response.statusCode = 302;
			response.setHeader("location", `${target.url}/v1/models`);
			response.end();
		});
		const result = await discoverModels(
			{ baseUrl: `${source.url}/v1`, api: "openai-completions" },
			{ apiKey: "redirect-secret" },
		);
		expect(result.models).toEqual([]);
		expect(result.warnings?.[0]).toMatch(/another origin/);
		expect(target.requests).toHaveLength(0);
	});

	it("does not leak the draft key through request errors", async () => {
		const result = await discoverModels(
			{ baseUrl: "http://127.0.0.1:9/v1", api: "openai-responses" },
			{
				apiKey: "draft-secret-key",
				fetch: async () => {
					throw new Error("network failed for draft-secret-key");
				},
			},
		);
		expect(result.warnings?.join(" ")).not.toContain("draft-secret-key");
	});
});
