import { realpathSync } from "node:fs";
import {
	type ClientParams,
	type ClientResult,
	MAX_PERMISSION_OPERATION_ROWS,
	type ProjectPermissionRuleView,
} from "@metis/app-protocol";
import {
	ProjectPermissionRuleStore,
	type ProjectPermissionRuleView as StoredPermissionRule,
} from "@metis/coding-agent";
import type { SessionCatalog } from "./session-catalog.ts";
import { AppServerError } from "./session-runtime-host.ts";

function projectRuleView(rule: StoredPermissionRule): ProjectPermissionRuleView {
	const details = rule.details.slice(0, MAX_PERMISSION_OPERATION_ROWS);
	return {
		id: rule.id,
		toolName: rule.toolName,
		...(rule.command === undefined ? {} : { command: rule.command }),
		paths: rule.paths.slice(0, MAX_PERMISSION_OPERATION_ROWS),
		details,
		omittedDetails: rule.omittedDetails + rule.details.length - details.length,
		risks: [...rule.risks],
		executionTarget: rule.executionTarget,
		createdAt: rule.createdAt,
	};
}

export class PermissionRulesService {
	private readonly store: ProjectPermissionRuleStore;
	private readonly catalog: SessionCatalog;

	constructor(agentDir: string, catalog: SessionCatalog) {
		this.store = new ProjectPermissionRuleStore(agentDir);
		this.catalog = catalog;
	}

	private projectPath(sessionId: string): string {
		const ref = this.catalog.get(sessionId);
		if (ref.scheduled) throw new AppServerError("READ_ONLY_SESSION", { sessionId });
		if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
		if (ref.summary.archived || !ref.summary.cwd) throw new AppServerError("NOT_FOUND", { sessionId });
		try {
			return realpathSync(ref.summary.cwd);
		} catch {
			throw new AppServerError("NOT_FOUND", { sessionId });
		}
	}

	list(input: ClientParams<"permission/rules/list">): ClientResult<"permission/rules/list"> {
		const projectPath = this.projectPath(input.sessionId);
		try {
			return { projectPath, rules: this.store.list(projectPath).map(projectRuleView) };
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId });
		}
	}

	delete(input: ClientParams<"permission/rules/delete">): ClientResult<"permission/rules/delete"> {
		const projectPath = this.projectPath(input.sessionId);
		try {
			if (!this.store.delete(projectPath, input.ruleId)) {
				throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
			}
			return { projectPath, rules: this.store.list(projectPath).map(projectRuleView) };
		} catch (error) {
			if (error instanceof AppServerError) throw error;
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId, requestId: input.requestId });
		}
	}

	clear(input: ClientParams<"permission/rules/clear">): ClientResult<"permission/rules/clear"> {
		const projectPath = this.projectPath(input.sessionId);
		try {
			this.store.clear(projectPath);
			return { projectPath, rules: [] };
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId, requestId: input.requestId });
		}
	}
}
