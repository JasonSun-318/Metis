import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { AuthStorage, MEMORY_EMBEDDING_CREDENTIAL_ID, SettingsManager } from "@metis/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySettingsService } from "../src/memory-settings.ts";

describe("MemorySettingsService", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-memory-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	function service() {
		return new MemorySettingsService({
			agentDir,
			authStorage: AuthStorage.create(join(agentDir, "auth.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
	}

	it("returns defaults with memory enabled and index engine", () => {
		expect(service().view()).toEqual({
			autoMemoryEnabled: true,
			memoryEngine: "index",
			embeddingConfigured: false,
			rerankConfigured: false,
			lastError: null,
			memoryMigrationNotice: null,
		});
	});

	it("persists memory settings and rejects enabled Extract without dedicated configuration", async () => {
		const svc = service();
		await expect(
			svc.update({
				autoMemoryEnabled: true,
				memoryEngine: "extract",
			}),
		).rejects.toThrow(/extract.*Embedding settings and credential/i);

		const manager = SettingsManager.create(agentDir, agentDir);
		manager.setEmbeddingSettings({
			name: "Embedding",
			provider: "Qwen",
			baseUrl: "https://example.test/v1",
			api: "openai-compatible",
			modelId: "embedding-model",
		});
		await manager.flushOrThrow();
		AuthStorage.create(join(agentDir, "auth.json")).set(MEMORY_EMBEDDING_CREDENTIAL_ID, {
			type: "api_key",
			key: "secret",
		});

		const updated = await service().update({
			autoMemoryEnabled: true,
			memoryEngine: "extract",
		});
		expect(updated).toMatchObject({
			autoMemoryEnabled: true,
			memoryEngine: "extract",
			embeddingConfigured: true,
		});
		expect(service().view()).toEqual(updated);
	});

	it("produces a protocol-valid response for memory/get and memory/update", async () => {
		const svc = service();
		const getRequest = {
			jsonrpc: "2.0" as const,
			id: "memory-view",
			method: "memory/get" as const,
			params: {},
		};
		expect(() =>
			validateResponseFor("client", getRequest, {
				jsonrpc: "2.0",
				id: getRequest.id,
				result: svc.view(),
			}),
		).not.toThrow();

		const updateRequest = {
			jsonrpc: "2.0" as const,
			id: "memory-update",
			method: "memory/update" as const,
			params: {
				autoMemoryEnabled: true,
				memoryEngine: "index" as const,
			},
		};
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
