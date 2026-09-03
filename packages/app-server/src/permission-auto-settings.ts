import type { ClientParams, ClientResult } from "@metis/app-protocol";
import { DEFAULT_AUTO_COMMAND_SUGGESTIONS, type SettingsManager } from "@metis/coding-agent";
import { AppServerError } from "./session-runtime-host.ts";

export class PermissionAutoSettingsService {
	private readonly settingsManager: SettingsManager;

	constructor(settingsManager: SettingsManager) {
		this.settingsManager = settingsManager;
	}

	view(): ClientResult<"permission/auto/get"> {
		return {
			rules: this.settingsManager.getAutoCommandRules().map((rule) => ({ ...rule })),
			suggestions: [...DEFAULT_AUTO_COMMAND_SUGGESTIONS],
		};
	}

	async update(params: ClientParams<"permission/auto/update">): Promise<ClientResult<"permission/auto/get">> {
		const previous = this.settingsManager.getAutoCommandRules();
		try {
			this.settingsManager.setAutoCommandRules(params.rules);
		} catch {
			throw new AppServerError("INVALID_REQUEST");
		}
		try {
			await this.settingsManager.flushOrThrow();
		} catch {
			this.settingsManager.setAutoCommandRules(previous);
			try {
				await this.settingsManager.flushOrThrow();
			} catch {
				// The original failure is authoritative; the settings writer remains fail-closed in memory.
			}
			throw new AppServerError("OPERATION_FAILED");
		}
		return this.view();
	}
}
