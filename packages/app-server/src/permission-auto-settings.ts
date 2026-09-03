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
		try {
			this.settingsManager.setAutoCommandRules(params.rules);
		} catch {
			throw new AppServerError("INVALID_REQUEST");
		}
		await this.settingsManager.flush();
		return this.view();
	}
}
