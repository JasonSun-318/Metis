import type { ClientParams, ClientResult } from "@metis/app-protocol";
import { type AuthStorage, MemorySettingsTransaction, type SettingsManager } from "@metis/coding-agent/host";

/** Exposes global long-term memory engine settings to the desktop. */
export class MemorySettingsService {
	private readonly transaction: MemorySettingsTransaction;

	constructor(options: {
		readonly agentDir: string;
		readonly authStorage: AuthStorage;
		readonly settingsManager: SettingsManager;
	}) {
		this.transaction = new MemorySettingsTransaction(options);
	}

	view(): ClientResult<"memory/get"> {
		return this.transaction.view();
	}

	async update(params: ClientParams<"memory/update">): Promise<ClientResult<"memory/get">> {
		return this.transaction.update(params);
	}
}
