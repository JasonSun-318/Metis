import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { SettingsManager } from "@metis/coding-agent";
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
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
	}

	it("returns defaults with memory enabled and index engine", () => {
		expect(service().view()).toEqual({
			autoMemoryEnabled: true,
			memoryEngine: "index",
			memoryEmbeddingModel: "",
			memoryRerankModel: "",
		});
	});

	it("persists memory settings and rejects extract without an embedding model", async () => {
		const svc = service();
		await expect(
			svc.update({
				autoMemoryEnabled: true,
				memoryEngine: "extract",
				memoryEmbeddingModel: "  ",
				memoryRerankModel: "",
			}),
		).rejects.toThrow(/extract.*memoryEmbeddingModel/i);

		const updated = await svc.update({
			autoMemoryEnabled: false,
			memoryEngine: "extract",
			memoryEmbeddingModel: "openai/text-embedding-3-small",
			memoryRerankModel: "openai/rerank",
		});
		expect(updated).toEqual({
			autoMemoryEnabled: false,
			memoryEngine: "extract",
			memoryEmbeddingModel: "openai/text-embedding-3-small",
			memoryRerankModel: "openai/rerank",
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
				memoryEmbeddingModel: "openai/text-embedding-3-small",
				memoryRerankModel: "",
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
