import type { AuthStorage } from "../auth-storage.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { clearMemoryHealth, getLatestMemoryError } from "./memory-health.ts";
import { MEMORY_EMBEDDING_CREDENTIAL_ID, MEMORY_RERANK_CREDENTIAL_ID } from "./memory-service-settings.ts";

export interface MemorySettingsUpdate {
	readonly autoMemoryEnabled?: boolean;
	readonly memoryEngine?: "index" | "extract";
}

export interface MemorySettingsView {
	readonly autoMemoryEnabled: boolean;
	readonly memoryEngine: "index" | "extract";
	readonly embeddingConfigured: boolean;
	readonly rerankConfigured: boolean;
	readonly lastError: string | null;
	readonly memoryMigrationNotice: string | null;
}

/** Validates, persists, and reports global long-term-memory settings as one transaction boundary. */
export class MemorySettingsTransaction {
	private readonly agentDir?: string;
	private readonly authStorage: AuthStorage;
	private readonly settingsManager: SettingsManager;

	constructor(options: {
		readonly agentDir?: string;
		readonly authStorage: AuthStorage;
		readonly settingsManager: SettingsManager;
	}) {
		this.agentDir = options.agentDir;
		this.authStorage = options.authStorage;
		this.settingsManager = options.settingsManager;
	}

	view(): MemorySettingsView {
		let lastError: string | null = null;
		if (this.agentDir) {
			try {
				lastError = getLatestMemoryError(this.agentDir);
			} catch {
				// Health is derived state; settings remain readable if SQLite is temporarily unavailable.
			}
		}
		return {
			autoMemoryEnabled: this.settingsManager.getAutoMemoryEnabled(),
			memoryEngine: this.settingsManager.getMemoryEngine(),
			embeddingConfigured:
				this.settingsManager.getEmbeddingSettings() !== undefined &&
				this.authStorage.get(MEMORY_EMBEDDING_CREDENTIAL_ID)?.type === "api_key",
			rerankConfigured:
				this.settingsManager.getRerankSettings() !== undefined &&
				this.authStorage.get(MEMORY_RERANK_CREDENTIAL_ID)?.type === "api_key",
			lastError,
			memoryMigrationNotice: this.settingsManager.getMemoryMigrationNotice() ?? null,
		};
	}

	async update(update: MemorySettingsUpdate): Promise<MemorySettingsView> {
		await this.settingsManager.throwPendingWriteError();
		const autoMemoryEnabled = update.autoMemoryEnabled ?? this.settingsManager.getAutoMemoryEnabled();
		const memoryEngine = update.memoryEngine ?? this.settingsManager.getMemoryEngine();
		if (autoMemoryEnabled && memoryEngine === "extract") {
			const apiKey = await this.authStorage.getApiKey(MEMORY_EMBEDDING_CREDENTIAL_ID, {
				includeFallback: false,
			});
			if (!this.settingsManager.getEmbeddingSettings() || !apiKey) {
				throw new Error(
					'Cannot enable memory engine "extract" without configured Embedding settings and credential.',
				);
			}
		}

		this.settingsManager.setMemorySettings(autoMemoryEnabled, memoryEngine);
		await this.settingsManager.flushOrThrow();
		if (this.agentDir) {
			try {
				clearMemoryHealth(this.agentDir, "extract", "backfill");
			} catch {
				// Health is derived state; settings are already durable.
			}
		}
		return this.view();
	}
}
