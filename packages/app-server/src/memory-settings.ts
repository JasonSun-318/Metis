import type { ClientParams, ClientResult } from "@metis/app-protocol";
import type { SettingsManager } from "@metis/coding-agent";

/** Exposes global long-term memory engine settings to the desktop. */
export class MemorySettingsService {
	private readonly settingsManager: SettingsManager;

	constructor(options: { readonly settingsManager: SettingsManager }) {
		this.settingsManager = options.settingsManager;
	}

	view(): ClientResult<"memory/get"> {
		return {
			autoMemoryEnabled: this.settingsManager.getAutoMemoryEnabled(),
			memoryEngine: this.settingsManager.getMemoryEngine(),
			memoryEmbeddingModel: this.settingsManager.getMemoryEmbeddingModel()?.trim() ?? "",
			memoryRerankModel: this.settingsManager.getMemoryRerankModel()?.trim() ?? "",
		};
	}

	async update(params: ClientParams<"memory/update">): Promise<ClientResult<"memory/get">> {
		const embeddingModel = params.memoryEmbeddingModel.trim();
		const rerankModel = params.memoryRerankModel.trim();
		if (params.memoryEngine === "extract" && !embeddingModel) {
			throw new Error(
				'Cannot enable memory engine "extract" without memoryEmbeddingModel. Configure an embedding model first (provider/model).',
			);
		}

		this.settingsManager.setAutoMemoryEnabled(params.autoMemoryEnabled);
		// Apply embedding before engine so extract validation sees the new value.
		this.settingsManager.setMemoryEmbeddingModel(embeddingModel);
		this.settingsManager.setMemoryRerankModel(rerankModel);
		this.settingsManager.setMemoryEngine(params.memoryEngine);
		await this.settingsManager.flush();
		return this.view();
	}
}
