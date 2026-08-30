import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getMemorySqlitePath } from "../src/core/auto-memory.ts";
import { MEMORY_EMBEDDING_CREDENTIAL_ID } from "../src/core/memory/memory-service-settings.ts";
import { MemorySettingsTransaction } from "../src/core/memory/memory-settings-transaction.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTransaction() {
	const agentDir = mkdtempSync(join(tmpdir(), "metis-memory-settings-"));
	tempDirs.push(agentDir);
	const settingsManager = SettingsManager.create(agentDir, agentDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	return {
		agentDir,
		settingsManager,
		authStorage,
		transaction: new MemorySettingsTransaction({ agentDir, settingsManager, authStorage }),
	};
}

describe("MemorySettingsTransaction", () => {
	it("rejects Extract without dedicated embedding configuration and credential", async () => {
		const { transaction } = createTransaction();
		await expect(transaction.update({ autoMemoryEnabled: true, memoryEngine: "extract" })).rejects.toThrow(
			/configured Embedding settings and credential/,
		);
	});

	it("persists settings and clears derived runtime health", async () => {
		const { agentDir, authStorage, settingsManager, transaction } = createTransaction();
		settingsManager.setEmbeddingSettings({
			name: "Embedding",
			provider: "Test",
			baseUrl: "https://example.test/v1",
			api: "openai-compatible",
			modelId: "embedding-model",
		});
		await settingsManager.flushOrThrow();
		authStorage.set(MEMORY_EMBEDDING_CREDENTIAL_ID, { type: "api_key", key: "secret" });
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		store.recordHealth({
			operation: "extract",
			status: "error",
			updatedAt: new Date().toISOString(),
			reason: "old failure",
		});
		store.close();

		await expect(transaction.update({ autoMemoryEnabled: true, memoryEngine: "extract" })).resolves.toMatchObject({
			autoMemoryEnabled: true,
			memoryEngine: "extract",
			embeddingConfigured: true,
		});
		const reloaded = SettingsManager.create(agentDir, agentDir);
		expect(reloaded.getMemoryEngine()).toBe("extract");
		const healthStore = openMemoryStore(getMemorySqlitePath(agentDir));
		try {
			expect(healthStore.listHealth()).not.toContainEqual(expect.objectContaining({ operation: "extract" }));
		} finally {
			healthStore.close();
		}
	});
});
