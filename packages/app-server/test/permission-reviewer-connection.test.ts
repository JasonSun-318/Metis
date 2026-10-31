import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SettingsManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsService } from "../src/model-settings.ts";

type FixtureMode = "normal" | "allow-all" | "text" | "authentication-error" | "timeout";

describe("permission reviewer connection contract", () => {
	const roots: string[] = [];
	const servers: Server[] = [];
	afterEach(async () => {
		for (const server of servers.splice(0)) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	/** Minimal OpenAI-compatible streaming fixture shared by the shared and dedicated profiles. */
	async function startFixtureServer(options: { mode?: FixtureMode; holdFirstResponse?: boolean } = {}) {
		const mode = options.mode ?? "normal";
		const requests: Record<string, unknown>[] = [];
		const authorizations: string[] = [];
		const paths: string[] = [];
		let resolveFirstRequest = () => {};
		const firstRequestReceived = new Promise<void>((resolve) => {
			resolveFirstRequest = resolve;
		});
		let releaseFirstResponse = () => {};
		const firstResponseGate = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk.toString();
			});
			request.on("end", async () => {
				requests.push(JSON.parse(body));
				authorizations.push(request.headers.authorization ?? "");
				paths.push(request.url ?? "");
				if (requests.length === 1) {
					resolveFirstRequest();
					if (options.holdFirstResponse) await firstResponseGate;
				}
				if (mode === "timeout") return;
				if (mode === "authentication-error") {
					response.writeHead(401, { "Content-Type": "application/json" });
					response.end(
						JSON.stringify({ error: { message: "Unauthorized test-review-key", type: "authentication_error" } }),
					);
					return;
				}
				const decision = mode === "allow-all" || !body.includes("rm -rf /") ? "allow" : "deny";
				const delta =
					mode === "text"
						? { role: "assistant", content: "approved" }
						: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "permission-verdict",
										type: "function",
										function: {
											name: "submit_permission_review",
											arguments: JSON.stringify({ decision }),
										},
									},
								],
							};
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				for (const part of [
					{ choices: [{ index: 0, delta, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: mode === "text" ? "stop" : "tool_calls" }],
						usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
					},
				]) {
					response.write(
						`data: ${JSON.stringify({ id: "review-fixture", object: "chat.completion.chunk", created: 1, model: "review-model", ...part })}\n\n`,
					);
				}
				response.end("data: [DONE]\n\n");
			});
		});
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		return {
			authorizations,
			firstRequestReceived,
			paths,
			releaseFirstResponse,
			requests,
			url: (path: string) => `${origin}${path}`,
		};
	}

	function createService(prefix: string) {
		const agentDir = mkdtempSync(join(tmpdir(), prefix));
		roots.push(agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		return { authStorage, modelRegistry, service, settingsManager };
	}

	function dedicatedConfig(thinkingLevel: "off" | "low", baseUrl: string) {
		return {
			source: "dedicated" as const,
			name: "Local reviewer",
			api: "openai-completions" as const,
			baseUrl,
			modelId: "review-model",
			thinkingLevel,
			timeoutMs: 1000,
			maxOutputTokens: thinkingLevel === "off" ? 512 : 2048,
			reasoningMode: thinkingLevel === "off" ? ("off" as const) : ("manual" as const),
			...(thinkingLevel === "off" ? {} : { thinkingLevelMap: { low: "low" } }),
		};
	}

	async function fixture(
		thinkingLevel: "off" | "low",
		mode: FixtureMode = "normal",
		options: { readonly holdFirstResponse?: boolean } = {},
	) {
		const server = await startFixtureServer({ mode, holdFirstResponse: options.holdFirstResponse });
		const { service, settingsManager, modelRegistry } = createService("metis-review-connection-");
		const saveProvider = (credential: string, baseUrl = server.url("/v1")) =>
			service.update({
				type: "save_provider",
				provider: "review-fixture",
				name: "Review fixture",
				baseUrl,
				api: "openai-completions",
				models: [
					{
						modelId: "review-model",
						name: "Review model",
						contextWindow: 32_000,
						maxOutputTokens: 8192,
						reasoningMode: "manual",
						thinkingLevelMap: { off: "none", low: "low" },
						imageInput: false,
					},
				],
				credential: { action: "set", value: credential },
			});
		await saveProvider("test-review-key");
		settingsManager.setDefaultThinkingLevel("high");
		await service.update({
			type: "set_permission_reviewer",
			config: {
				provider: "review-fixture",
				modelId: "review-model",
				thinkingLevel,
				timeoutMs: 1000,
				maxOutputTokens: thinkingLevel === "off" ? 512 : 2048,
			},
		});
		return { saveProvider, server, service, settingsManager, modelRegistry };
	}

	async function dedicatedFixture(
		thinkingLevel: "off" | "low",
		options: { readonly withCredential?: boolean; readonly withSharedProvider?: boolean } = {},
	) {
		const server = await startFixtureServer();
		const { service, settingsManager } = createService("metis-review-dedicated-");
		if (options.withSharedProvider) {
			await service.update({
				type: "save_provider",
				provider: "permission-reviewer",
				name: "Shared fixture",
				baseUrl: server.url("/shared/v1"),
				api: "openai-completions",
				models: [
					{
						modelId: "shared-model",
						name: "Shared model",
						contextWindow: 32_000,
						maxOutputTokens: 8_192,
						reasoningMode: "off",
						imageInput: false,
					},
				],
				credential: { action: "set", value: "shared-review-key" },
			});
		}
		const config = dedicatedConfig(thinkingLevel, server.url("/v1"));
		if (options.withCredential === false) {
			settingsManager.setPermissionReviewerConfig(config);
			await settingsManager.flushOrThrow();
		} else {
			await service.update({
				type: "set_permission_reviewer",
				config,
				credential: { action: "set", value: "dedicated-review-key" },
			});
		}
		settingsManager.setDefaultThinkingLevel("high");
		return { server, service, settingsManager };
	}

	it.each(["off", "low"] as const)("uses the approval contract and the saved %s profile", async (thinkingLevel) => {
		const { server, service, settingsManager } = await fixture(thinkingLevel);
		const result = await service.testConnection({
			requestId: "00000000-0000-4000-8000-000000000001",
			kind: "permission-review",
		});
		expect(result).toMatchObject({ ok: true, thinkingLevel });
		expect(server.requests).toHaveLength(2);
		for (const request of server.requests) {
			expect(request.model).toBe("review-model");
			expect(request.tool_choice).toBe(thinkingLevel === "off" ? "required" : "auto");
			expect(request.max_tokens ?? request.max_completion_tokens).toBe(thinkingLevel === "off" ? 512 : 2048);
			expect(request.tools).toEqual([
				expect.objectContaining({ function: expect.objectContaining({ name: "submit_permission_review" }) }),
			]);
			expect(JSON.stringify(request)).not.toContain("Reply with OK");
		}
		expect(settingsManager.getAutoReviewerEnabled()).toBe(false);
		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
	});

	it.each(["off", "low"] as const)(
		"uses the approval contract and the dedicated key for a %s connection",
		async (thinkingLevel) => {
			const { server, service, settingsManager } = await dedicatedFixture(thinkingLevel, {
				withSharedProvider: true,
			});
			const result = await service.testConnection({
				requestId: "00000000-0000-4000-8000-000000000003",
				kind: "permission-review",
			});
			expect(result).toMatchObject({ ok: true, thinkingLevel });
			expect(server.requests).toHaveLength(2);
			for (const request of server.requests) {
				expect(request.model).toBe("review-model");
				expect(request.tool_choice).toBe(thinkingLevel === "off" ? "required" : "auto");
				expect(request.max_tokens ?? request.max_completion_tokens).toBe(thinkingLevel === "off" ? 512 : 2048);
				expect(request.tools).toEqual([
					expect.objectContaining({ function: expect.objectContaining({ name: "submit_permission_review" }) }),
				]);
			}
			// The shared provider key is never used for the dedicated connection.
			expect(server.authorizations).toEqual(["Bearer dedicated-review-key", "Bearer dedicated-review-key"]);
			const view = service.view();
			expect(view.providers.find((provider) => provider.provider === "permission-reviewer")).toMatchObject({
				auth: { configured: true, source: "stored" },
			});
			expect(view.permissionReviewer).toMatchObject({
				status: "configured",
				authConfigured: true,
				config: { source: "dedicated" },
			});
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
		},
	);

	it("fails without contacting the endpoint when the dedicated key is missing", async () => {
		const { server, service } = await dedicatedFixture("off", { withCredential: false });
		const result = await service.testConnection({
			requestId: "00000000-0000-4000-8000-000000000004",
			kind: "permission-review",
		});
		expect(result.ok).toBe(false);
		expect(server.requests).toHaveLength(0);
	});

	it("keeps the fixed endpoint and credential snapshot when settings change mid-test", async () => {
		const server = await startFixtureServer({ holdFirstResponse: true });
		const { service } = createService("metis-review-snapshot-");
		const config = dedicatedConfig("off", server.url("/v1"));
		await service.update({
			type: "set_permission_reviewer",
			config,
			credential: { action: "set", value: "old-review-key" },
		});
		const pending = service.testConnection({
			requestId: "00000000-0000-4000-8000-000000000005",
			kind: "permission-review",
		});
		await server.firstRequestReceived;
		await service.update({
			type: "set_permission_reviewer",
			config: { ...config, baseUrl: server.url("/new/v1") },
			credential: { action: "set", value: "new-review-key" },
		});
		server.releaseFirstResponse();

		await expect(pending).resolves.toMatchObject({ ok: true });
		expect(server.requests).toHaveLength(2);
		expect(server.paths.every((path) => path.startsWith("/v1/"))).toBe(true);
		expect(server.authorizations).toEqual(["Bearer old-review-key", "Bearer old-review-key"]);
	});

	it("keeps the shared provider endpoint and credential snapshot when settings change mid-test", async () => {
		const { saveProvider, server, service } = await fixture("off", "normal", { holdFirstResponse: true });
		const pending = service.testConnection({
			requestId: "00000000-0000-4000-8000-000000000006",
			kind: "permission-review",
		});
		await server.firstRequestReceived;
		const firstAuthorization = server.authorizations[0];
		expect(firstAuthorization).toMatch(/^Bearer /);
		await saveProvider("shared-new-key", server.url("/new/v1"));
		server.releaseFirstResponse();

		await expect(pending).resolves.toMatchObject({ ok: true });
		expect(server.authorizations).toEqual([firstAuthorization, firstAuthorization]);
		expect(server.paths.every((path) => path.startsWith("/v1/"))).toBe(true);
	});

	it("includes authentication waiting in the configured review deadline", async () => {
		const { service, modelRegistry, server } = await fixture("off");
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(() => new Promise(() => {}));
		vi.useFakeTimers();
		try {
			let result: { ok: boolean } | undefined;
			void service
				.testConnection({
					requestId: "00000000-0000-4000-8000-000000000007",
					kind: "permission-review",
				})
				.then((value) => {
					result = value;
				});
			await vi.advanceTimersByTimeAsync(1_001);
			expect(result).toMatchObject({ ok: false });
			expect(server.requests).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["allow-all", "text", "authentication-error", "timeout"] as const)(
		"fails closed for %s without correcting or retrying",
		async (mode) => {
			const { server, service } = await fixture("off", mode);
			const result = await service.testConnection({
				requestId: "00000000-0000-4000-8000-000000000002",
				kind: "permission-review",
			});
			expect(result.ok).toBe(false);
			expect(server.requests).toHaveLength(mode === "allow-all" ? 2 : 1);
			expect(result.message).not.toContain("test-review-key");
		},
	);
});
