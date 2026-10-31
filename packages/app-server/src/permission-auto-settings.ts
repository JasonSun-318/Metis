import type { ClientParams, ClientResult, PermissionRuleView } from "@metis/app-protocol";
import {
	createDefaultPermissionRules,
	type PermissionRule,
	permissionRuleView,
	type SettingsManager,
} from "@metis/coding-agent/host";
import { AppServerError } from "./session-runtime-host.ts";

function ruleView(rule: PermissionRule): PermissionRuleView {
	const { networkTargets, ...view } = permissionRuleView(rule);
	return {
		...view,
		modes: [...view.modes],
		directories: [...view.directories],
		...(networkTargets ? { networkTargets: networkTargets.map((target) => ({ ...target })) } : {}),
	};
}

export class PermissionAutoSettingsService {
	private readonly settingsManager: SettingsManager;

	constructor(settingsManager: SettingsManager) {
		this.settingsManager = settingsManager;
	}

	view(): ClientResult<"permission/auto/get"> {
		const rules = this.settingsManager.getPermissionRules();
		const defaults = createDefaultPermissionRules();
		return {
			rules: this.settingsManager.getAutoCommandRules().map(({ networkTargets, ...rule }) => ({
				...rule,
				...(networkTargets ? { networkTargets: networkTargets.map((target) => ({ ...target })) } : {}),
			})),
			permissionRules: rules.map(ruleView),
			permissionRuleDefaults: defaults.map(ruleView),
			suggestions: [
				...new Set([
					...defaults.filter((rule) => rule.kind === "command" && rule.command).map((rule) => rule.command!),
					"curl",
				]),
			],
			reviewerEnabled: this.settingsManager.getAutoReviewerEnabled(),
		};
	}

	async read(): Promise<ClientResult<"permission/auto/get">> {
		try {
			const result = this.view();
			await this.settingsManager.flushOrThrow();
			return result;
		} catch {
			throw new AppServerError("OPERATION_FAILED");
		}
	}

	async update(params: ClientParams<"permission/auto/update">): Promise<ClientResult<"permission/auto/get">> {
		if (
			(params.rules === undefined && params.permissionRules === undefined && params.reviewerEnabled === undefined) ||
			(params.rules !== undefined && params.permissionRules !== undefined)
		) {
			throw new AppServerError("INVALID_REQUEST");
		}
		const previousRules = this.settingsManager.getPermissionRules();
		const previousEnabled = this.settingsManager.getAutoReviewerEnabled();
		try {
			if (params.permissionRules !== undefined) this.settingsManager.setPermissionRules(params.permissionRules);
			else if (params.rules !== undefined) this.settingsManager.setAutoCommandRules(params.rules);
			if (params.reviewerEnabled !== undefined) this.settingsManager.setAutoReviewerEnabled(params.reviewerEnabled);
		} catch {
			throw new AppServerError("INVALID_REQUEST");
		}
		try {
			await this.settingsManager.flushOrThrow();
		} catch {
			this.settingsManager.setPermissionRules(previousRules);
			this.settingsManager.setAutoReviewerEnabled(previousEnabled);
			try {
				await this.settingsManager.flushOrThrow();
			} catch {
				// Preserve the original failure; memory already holds the previous effective rules.
			}
			throw new AppServerError("OPERATION_FAILED");
		}
		return this.view();
	}
}
