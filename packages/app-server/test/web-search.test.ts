import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { AuthStorage, SettingsManager } from "@metis/coding-agent/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSearchService } from "../src/web-search.ts";

describe("WebSearchService", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-web-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	function service() {
		return new WebSearchService({
			settingsManager: SettingsManager.create(agentDir, agentDir),
			authStorage: AuthStorage.create(join(agentDir, "auth.json")),
		});
	}

	it("returns defaults with no configured credential", () => {
		const svc = service();
		expect(svc.view()).toEqual({
			enabled: false,
			provider: "brave",
			authConfigured: false,
			configuredProviders: [],
		});
	});

	it("reveals only the requested provider's stored API key", async () => {
		const svc = service();
		await svc.update({ enabled: true, provider: "brave", credential: { action: "set", value: "brave-key" } });
		expect(svc.reveal({ provider: "brave" })).toEqual({ credential: "brave-key" });
		expect(svc.reveal({ provider: "tavily" })).toEqual({ credential: null });
	});

	it("persists enable, provider, and credential and clears them", async () => {
		const svc = service();
		const updated = await svc.update({
			enabled: true,
			provider: "serpapi",
			credential: { action: "set", value: "serp-key" },
		});
		expect(updated).toEqual({
			enabled: true,
			provider: "serpapi",
			authConfigured: true,
			configuredProviders: ["serpapi"],
			authSource: "stored",
		});

		// keep 不清除凭据，只改 provider
		const kept = await svc.update({
			enabled: true,
			provider: "tavily",
			credential: { action: "keep" },
		});
		expect(kept).toMatchObject({ provider: "tavily", enabled: true });
		// provider 切换后，serpapi 的凭据仍在，但当前 provider 的凭据未配置
		expect(kept.authConfigured).toBe(false);
		expect(kept.configuredProviders).toEqual(["serpapi"]);

		// 重新给当前 provider 设置凭据，再 remove
		await svc.update({ enabled: true, provider: "tavily", credential: { action: "set", value: "tavily-key" } });
		const cleared = await svc.update({ enabled: false, provider: "tavily", credential: { action: "remove" } });
		expect(cleared).toEqual({
			enabled: false,
			provider: "tavily",
			authConfigured: false,
			configuredProviders: ["serpapi"],
		});
	});

	it("produces a protocol-valid response for webSearch/get and webSearch/update", async () => {
		const svc = service();
		const request = {
			jsonrpc: "2.0" as const,
			id: "web-search-view",
			method: "webSearch/get" as const,
			params: {},
		};
		expect(() =>
			validateResponseFor("client", request, {
				jsonrpc: "2.0",
				id: request.id,
				result: svc.view(),
			}),
		).not.toThrow();

		const updateRequest = {
			jsonrpc: "2.0" as const,
			id: "web-search-update",
			method: "webSearch/update" as const,
			params: { enabled: true, provider: "brave", credential: { action: "set", value: "brave-key" } },
		} as const;
		const updateResult = await svc.update(updateRequest.params);
		expect(() =>
			validateResponseFor("client", updateRequest, {
				jsonrpc: "2.0",
				id: updateRequest.id,
				result: updateResult,
			}),
		).not.toThrow();
	});
});
