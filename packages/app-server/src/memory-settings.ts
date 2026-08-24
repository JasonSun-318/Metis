import type { ClientParams, ClientResult } from "@metis/app-protocol";
import {
	type AuthStorage,
	clearMemoryHealth,
	getLatestMemoryError,
	MEMORY_EMBEDDING_CREDENTIAL_ID,
	MEMORY_RERANK_CREDENTIAL_ID,
	type SettingsManager,
} from "@metis/coding-agent";

/** Exposes global long-term memory engine settings to the desktop. */
export class MemorySettingsService {
	private readonly agentDir: string;
	private readonly authStorage: AuthStorage;
	private readonly settingsManager: SettingsManager;

	constructor(options: {
		readonly agentDir: string;
		readonly authStorage: AuthStorage;
		readonly settingsManager: SettingsManager;
	}) {
		this.agentDir = options.agentDir;
		this.authStorage = options.authStorage;
		this.settingsManager = options.settingsManager;
	}

	view(): ClientResult<"memory/get"> {
		let lastError: string | null = null;
		try {
			lastError = getLatestMemoryError(this.agentDir);
		} catch {
			// Health is derived state; settings remain readable if SQLite is temporarily unavailable.
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

	async update(params: ClientParams<"memory/update">): Promise<ClientResult<"memory/get">> {
		await this.settingsManager.throwPendingWriteError();
		if (
			params.autoMemoryEnabled &&
			params.memoryEngine === "extract" &&
			(!this.settingsManager.getEmbeddingSettings() ||
				this.authStorage.get(MEMORY_EMBEDDING_CREDENTIAL_ID)?.type !== "api_key")
		) {
			throw new Error('Cannot enable memory engine "extract" without configured Embedding settings and credential.');
		}

		this.settingsManager.setMemorySettings(params.autoMemoryEnabled, params.memoryEngine);
		await this.settingsManager.flushOrThrow();
		try {
			clearMemoryHealth(this.agentDir, "extract", "backfill");
		} catch {
			// Health is derived state; settings are already durable.
		}
		return this.view();
	}
}
