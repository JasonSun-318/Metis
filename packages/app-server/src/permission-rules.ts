import { realpathSync } from "node:fs";
import { basename } from "node:path";
import {
	type ClientParams,
	type ClientResult,
	MAX_PERMISSION_OPERATION_ROWS,
	type ProjectPermissionRuleView,
	type SessionSummary,
} from "@metis/app-protocol";
import type { SessionPermissionRule } from "@metis/coding-agent/host";
import {
	canonicalizePathForCreation,
	type ProjectPermissionRule,
	ProjectPermissionRuleStore,
} from "@metis/coding-agent/host";
import type { SessionCatalog } from "./session-catalog.ts";
import { AppServerError } from "./session-runtime-host.ts";

export function permissionRuleView(rule: ProjectPermissionRule | SessionPermissionRule): ProjectPermissionRuleView {
	const details = rule.summary.slice(0, MAX_PERMISSION_OPERATION_ROWS).map((entry) => ({
		label: entry.label,
		value: entry.value,
	}));
	const target = rule.summary.find((entry) => entry.label === "Execution target")?.value;
	const executionTarget =
		target === "sandbox" || target === "host" || target === "external"
			? target
			: rule.summary.some((entry) => entry.label === "Network")
				? "external"
				: "sandbox";
	const command = rule.summary.find((entry) => entry.label === "Command")?.value;
	return {
		id: rule.id,
		decision: rule.decision,
		toolName: rule.toolName,
		...(command ? { command } : {}),
		paths: rule.summary
			.filter((entry) => entry.label === "Path" || entry.label === "Read path" || entry.label === "Write path")
			.map((entry) => entry.value),
		details,
		omittedDetails: Math.max(0, rule.summary.length - details.length),
		risks: [rule.riskLevel],
		executionTarget,
		createdAt: rule.createdAt,
	};
}

/** Live-session in-memory rule access; implemented by open session runtimes. */
export interface SessionPermissionRuleAccess {
	listSessionPermissionRules(projectPath: string): readonly SessionPermissionRule[];
	deleteSessionPermissionRule(projectPath: string, ruleId: string): boolean;
	clearSessionPermissionRules(projectPath: string): number;
}

export interface OpenSessionPermissionRules {
	withOpenSessionPermissionRules<T>(
		sessionId: string,
		operation: (access: SessionPermissionRuleAccess) => Promise<T> | T,
	): Promise<{ open: true; result: T } | { open: false }>;
}

export interface OpenPermissionRuleCatalog extends OpenSessionPermissionRules {
	listOpenPermissionSessionIds(): readonly string[];
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
		if (ref.summary.state === "unsupported") {
			throw new AppServerError("SESSION_VERSION_UNSUPPORTED", { sessionId });
		}
		if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
		if (ref.summary.archived || !ref.summary.cwd) throw new AppServerError("NOT_FOUND", { sessionId });
		try {
			return realpathSync(ref.summary.cwd);
		} catch {
			throw new AppServerError("NOT_FOUND", { sessionId });
		}
	}

	async listRemembered(openSessions: OpenPermissionRuleCatalog): Promise<ClientResult<"permission/rules/catalog">> {
		const summaries: SessionSummary[] = [];
		let afterSessionId: string | undefined;
		do {
			const page = this.catalog.list({
				includeArchived: true,
				limit: 200,
				...(afterSessionId ? { afterSessionId } : {}),
			});
			summaries.push(...page.sessions);
			afterSessionId = page.nextAfterSessionId ?? undefined;
		} while (afterSessionId);
		const names = new Map<string, string>();
		for (const summary of summaries) {
			if (summary.cwd && summary.cwdOrigin === "managed" && summary.name) {
				const path = canonicalizePathForCreation(summary.cwd);
				if (!names.has(path)) names.set(path, summary.name);
			}
		}
		type Group = ClientResult<"permission/rules/catalog">["groups"][number];
		const projects = new Map<string, Group>();
		let stored: readonly ProjectPermissionRule[];
		try {
			stored = this.store.listAll();
		} catch {
			throw new AppServerError("OPERATION_FAILED");
		}
		for (const rule of stored) {
			let group = projects.get(rule.projectPath);
			if (!group) {
				group = {
					projectPath: rule.projectPath,
					projectName: names.get(rule.projectPath) ?? basename(rule.projectPath),
					scope: "project",
					rules: [],
				};
				projects.set(rule.projectPath, group);
			}
			group.rules.push(permissionRuleView(rule));
		}
		const groups = [...projects.values()];
		const openIds = new Set(openSessions.listOpenPermissionSessionIds());
		// A journal removed outside Metis can leave a live slot after catalog refresh.
		const openRefs = summaries
			.filter((summary) => openIds.has(summary.sessionId))
			.map((summary) => this.catalog.get(summary.sessionId));
		for (const { summary, scheduled } of openRefs) {
			const sessionId = summary.sessionId;
			if (
				scheduled ||
				summary.archived ||
				!summary.cwd ||
				summary.state === "corrupt" ||
				summary.state === "unsupported"
			)
				continue;
			const projectPath = canonicalizePathForCreation(summary.cwd);
			const opened = await openSessions.withOpenSessionPermissionRules(sessionId, (access) =>
				access.listSessionPermissionRules(projectPath),
			);
			if (!opened.open || opened.result.length === 0) continue;
			groups.push({
				projectPath,
				projectName: names.get(projectPath) ?? basename(projectPath),
				scope: "session",
				sessionId,
				...(summary.name ? { sessionTitle: summary.name } : {}),
				rules: opened.result.map(permissionRuleView),
			});
		}
		return { groups };
	}

	async revokeRemembered(
		input: ClientParams<"permission/rules/revoke">,
		openSessions: OpenSessionPermissionRules,
	): Promise<ClientResult<"permission/rules/revoke">> {
		if (input.scope === "session") {
			await this.delete(input, openSessions);
		} else {
			try {
				if (!this.store.delete(input.projectPath, input.ruleId))
					throw new AppServerError("NOT_FOUND", { requestId: input.requestId });
			} catch (error) {
				if (error instanceof AppServerError) throw error;
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
		}
		return { deleted: true };
	}

	async list(
		input: ClientParams<"permission/rules/list">,
		openSessions?: OpenSessionPermissionRules,
	): Promise<ClientResult<"permission/rules/list">> {
		const projectPath = this.projectPath(input.sessionId);
		if (input.scope === "session") {
			return await this.withSessionRules(input.sessionId, projectPath, openSessions, (access) =>
				access.listSessionPermissionRules(projectPath),
			);
		}
		try {
			return { projectPath, scope: "project", rules: this.store.list(projectPath).map(permissionRuleView) };
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId });
		}
	}

	async delete(
		input: ClientParams<"permission/rules/delete">,
		openSessions?: OpenSessionPermissionRules,
	): Promise<ClientResult<"permission/rules/delete">> {
		const projectPath = this.projectPath(input.sessionId);
		if (input.scope === "session") {
			const opened = await openSessions?.withOpenSessionPermissionRules(input.sessionId, (access) => ({
				deleted: access.deleteSessionPermissionRule(projectPath, input.ruleId),
				rules: access.listSessionPermissionRules(projectPath),
			}));
			if (!opened?.open || !opened.result.deleted) {
				throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
			}
			return {
				projectPath,
				scope: "session",
				sessionId: input.sessionId,
				rules: opened.result.rules.map(permissionRuleView),
			};
		}
		try {
			if (!this.store.delete(projectPath, input.ruleId)) {
				throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
			}
			return { projectPath, scope: "project", rules: this.store.list(projectPath).map(permissionRuleView) };
		} catch (error) {
			if (error instanceof AppServerError) throw error;
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId, requestId: input.requestId });
		}
	}

	async clear(
		input: ClientParams<"permission/rules/clear">,
		openSessions?: OpenSessionPermissionRules,
	): Promise<ClientResult<"permission/rules/clear">> {
		const projectPath = this.projectPath(input.sessionId);
		if (input.scope === "session") {
			return await this.withSessionRules(input.sessionId, projectPath, openSessions, (access) => {
				access.clearSessionPermissionRules(projectPath);
				return access.listSessionPermissionRules(projectPath);
			});
		}
		try {
			this.store.clear(projectPath);
			return { projectPath, scope: "project", rules: [] };
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId, requestId: input.requestId });
		}
	}

	/**
	 * Session scope is bound to a live session owner: without an open runtime the
	 * rules do not exist, so every operation fails instead of faking success.
	 */
	private async withSessionRules(
		sessionId: string,
		projectPath: string,
		openSessions: OpenSessionPermissionRules | undefined,
		operation: (
			access: SessionPermissionRuleAccess,
		) => Promise<readonly SessionPermissionRule[]> | readonly SessionPermissionRule[],
	): Promise<ClientResult<"permission/rules/list">> {
		if (!openSessions) throw new AppServerError("NOT_FOUND", { sessionId });
		const opened = await openSessions.withOpenSessionPermissionRules(sessionId, operation);
		if (!opened.open) throw new AppServerError("NOT_FOUND", { sessionId });
		return {
			projectPath,
			scope: "session",
			sessionId,
			rules: opened.result.map(permissionRuleView),
		};
	}
}
