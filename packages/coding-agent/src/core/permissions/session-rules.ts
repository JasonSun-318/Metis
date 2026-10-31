import { realpathSync } from "node:fs";
import { canonicalJson, digestCanonical } from "./normalize.ts";
import {
	canonicalPermissionRuleProjectPath,
	normalizePermissionRuleInput,
	type ProjectPermissionRuleInput,
} from "./project-rules.ts";

const MAX_SESSION_RULES = 256;

/**
 * Session rules bind to the real project directory: symlink aliases compare as
 * one project and a missing path fails closed instead of inventing an ancestor.
 */
function canonicalSessionRuleProjectPath(projectPath: string): string {
	const validated = canonicalPermissionRuleProjectPath(projectPath);
	return canonicalPermissionRuleProjectPath(realpathSync(validated));
}

export interface SessionPermissionRule extends ProjectPermissionRuleInput {
	readonly id: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly decision: "allow";
}

/** Exact user approvals owned by one live AgentSession. Nothing is persisted. */
export class SessionPermissionRuleStore {
	private readonly rules = new Map<string, SessionPermissionRule>();
	private readonly sessionId: string;

	constructor(sessionId: string) {
		if (
			typeof sessionId !== "string" ||
			!sessionId.trim() ||
			sessionId !== sessionId.trim() ||
			sessionId.includes("\0") ||
			Buffer.byteLength(sessionId, "utf8") > 1024
		) {
			throw new TypeError("Session permission owner is invalid");
		}
		this.sessionId = sessionId;
	}

	private normalize(input: ProjectPermissionRuleInput) {
		// Reuse canonical validation before accessing fields; accessors, hidden
		// properties, prototypes and cycles must never become stored authority.
		canonicalJson(input);
		const projectPath = canonicalSessionRuleProjectPath(input.projectPath);
		const normalized = normalizePermissionRuleInput({ ...input, projectPath }, true);
		return Object.freeze({
			...normalized,
			id: digestCanonical({ sessionId: this.sessionId, ruleId: normalized.id }),
		});
	}

	rememberAllow(input: ProjectPermissionRuleInput): SessionPermissionRule {
		const normalized = this.normalize(input);
		if (normalized.riskLevel === "critical") throw new TypeError("Critical permissions cannot be remembered");
		const existing = this.rules.get(normalized.id);
		if (existing) return existing;
		if (this.rules.size >= MAX_SESSION_RULES) throw new TypeError("Session permission store is full");
		const rule: SessionPermissionRule = Object.freeze({
			...normalized,
			sessionId: this.sessionId,
			createdAt: new Date().toISOString(),
			decision: "allow",
		});
		this.rules.set(rule.id, rule);
		return rule;
	}

	match(input: ProjectPermissionRuleInput): SessionPermissionRule | undefined {
		const normalized = this.normalize(input);
		if (normalized.riskLevel === "critical") return undefined;
		return this.rules.get(normalized.id);
	}

	list(projectPath: string): readonly SessionPermissionRule[] {
		const project = canonicalSessionRuleProjectPath(projectPath);
		return Object.freeze([...this.rules.values()].filter((rule) => rule.projectPath === project));
	}

	delete(projectPath: string, ruleId: string): boolean {
		const project = canonicalSessionRuleProjectPath(projectPath);
		const rule = this.rules.get(ruleId);
		return rule?.projectPath === project && this.rules.delete(ruleId);
	}

	clear(projectPath: string): number {
		const rules = this.list(projectPath);
		for (const rule of rules) this.rules.delete(rule.id);
		return rules.length;
	}
}
