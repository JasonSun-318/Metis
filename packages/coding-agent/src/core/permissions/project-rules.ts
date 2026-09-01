import { isAbsolute, join } from "node:path";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import { FileAuthStorageBackend } from "../auth-storage.ts";
import { digestCanonical } from "./normalize.ts";
import type { RiskLevel } from "./types.ts";

const FILE_VERSION = 2;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RULES_TOTAL = 4_096;
const MAX_RULES_PER_PROJECT = 256;
const MAX_PROJECT_PATH_LENGTH = 32_768;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_TOOL_IDENTITY_LENGTH = 4_096;
const MAX_SUMMARY_ITEMS = 16;
const MAX_SUMMARY_LABEL_LENGTH = 64;
const MAX_SUMMARY_VALUE_LENGTH = 256;
const MAX_RAW_SUMMARY_VALUE_LENGTH = 4_096;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SENSITIVE_LABEL_PATTERN = /(?:auth|cookie|credential|key|password|secret|session|token)/i;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const RULE_INPUT_KEYS = [
	"projectPath",
	"actionDigest",
	"grantDigest",
	"toolName",
	"toolIdentity",
	"riskLevel",
	"summary",
] as const;

export interface ProjectPermissionRuleSummary {
	readonly label: string;
	readonly value: string;
}

export interface ProjectPermissionRuleInput {
	readonly projectPath: string;
	readonly actionDigest: string;
	readonly grantDigest: string;
	readonly toolName: string;
	readonly toolIdentity: string;
	readonly riskLevel: RiskLevel;
	readonly summary: readonly ProjectPermissionRuleSummary[];
}

export interface ProjectPermissionRule extends ProjectPermissionRuleInput {
	readonly id: string;
	readonly decision: "allow" | "deny";
	readonly createdAt: string;
}

interface PermissionRuleFile {
	readonly version: 2;
	readonly rules: readonly ProjectPermissionRule[];
}

interface NormalizedRuleInput extends ProjectPermissionRuleInput {
	readonly id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredText(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
	const normalized = value.trim();
	if (!normalized || normalized.includes("\0") || normalized.length > maximum) {
		throw new TypeError(`${field} is invalid`);
	}
	return normalized;
}

function requiredDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new TypeError(`${field} is invalid`);
	return value;
}

function requiredRiskLevel(value: unknown): RiskLevel {
	if (!RISK_LEVELS.includes(value as RiskLevel)) throw new TypeError("riskLevel is invalid");
	return value as RiskLevel;
}

function canonicalProjectPath(value: unknown): string {
	const projectPath = requiredText(value, "projectPath", MAX_PROJECT_PATH_LENGTH);
	if (!isAbsolute(projectPath)) throw new TypeError("projectPath must be absolute");
	return canonicalizeActionPath(projectPath, projectPath);
}

function normalizeSummary(value: unknown): readonly ProjectPermissionRuleSummary[] {
	if (!Array.isArray(value) || value.length > MAX_SUMMARY_ITEMS) {
		throw new TypeError("Permission rule summary is invalid");
	}
	return Object.freeze(
		value.map((entry) => {
			if (!isRecord(entry) || !hasExactKeys(entry, ["label", "value"])) {
				throw new TypeError("Permission rule summary is invalid");
			}
			const label = requiredText(entry.label, "summary label", MAX_SUMMARY_LABEL_LENGTH);
			const rawValue = requiredText(entry.value, "summary value", MAX_RAW_SUMMARY_VALUE_LENGTH);
			const summaryValue = SENSITIVE_LABEL_PATTERN.test(label) ? "<redacted>" : rawValue;
			if (summaryValue.length > MAX_SUMMARY_VALUE_LENGTH) throw new TypeError("summary value is too long");
			return Object.freeze({ label, value: summaryValue });
		}),
	);
}

function ruleIdentity(input: ProjectPermissionRuleInput): string {
	return digestCanonical({
		projectPath: input.projectPath,
		actionDigest: input.actionDigest,
		grantDigest: input.grantDigest,
		toolName: input.toolName,
		toolIdentity: input.toolIdentity,
		riskLevel: input.riskLevel,
	});
}

function normalizeInput(input: ProjectPermissionRuleInput, requireExactKeys = false): NormalizedRuleInput {
	if (!isRecord(input) || (requireExactKeys && !hasExactKeys(input, RULE_INPUT_KEYS))) {
		throw new TypeError("Permission rule input is invalid");
	}
	const normalized: ProjectPermissionRuleInput = {
		projectPath: canonicalProjectPath(input.projectPath),
		actionDigest: requiredDigest(input.actionDigest, "actionDigest"),
		grantDigest: requiredDigest(input.grantDigest, "grantDigest"),
		toolName: requiredText(input.toolName, "toolName", MAX_TOOL_NAME_LENGTH),
		toolIdentity: requiredText(input.toolIdentity, "toolIdentity", MAX_TOOL_IDENTITY_LENGTH),
		riskLevel: requiredRiskLevel(input.riskLevel),
		summary: normalizeSummary(input.summary),
	};
	return Object.freeze({ ...normalized, id: ruleIdentity(normalized) });
}

function parseRule(value: unknown): ProjectPermissionRule {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"id",
			"projectPath",
			"decision",
			"actionDigest",
			"grantDigest",
			"toolName",
			"toolIdentity",
			"riskLevel",
			"summary",
			"createdAt",
		]) ||
		(value.decision !== "allow" && value.decision !== "deny") ||
		typeof value.createdAt !== "string"
	) {
		throw new TypeError("Permission rule file contains an invalid rule");
	}

	let normalized: NormalizedRuleInput;
	try {
		normalized = normalizeInput(value as unknown as ProjectPermissionRuleInput);
	} catch {
		throw new TypeError("Permission rule file contains an invalid rule");
	}
	if (
		value.id !== normalized.id ||
		value.projectPath !== normalized.projectPath ||
		value.toolName !== normalized.toolName ||
		value.toolIdentity !== normalized.toolIdentity ||
		JSON.stringify(value.summary) !== JSON.stringify(normalized.summary)
	) {
		throw new TypeError("Permission rule file contains an invalid rule");
	}
	try {
		if (new Date(value.createdAt).toISOString() !== value.createdAt) throw new Error("invalid");
	} catch {
		throw new TypeError("Permission rule file contains an invalid rule");
	}
	return freezeRule({
		...normalized,
		decision: value.decision,
		createdAt: value.createdAt,
	});
}

function parseFile(current: string | undefined): PermissionRuleFile {
	if (current === undefined || current.trim() === "") return { version: FILE_VERSION, rules: [] };
	if (Buffer.byteLength(current, "utf8") > MAX_FILE_BYTES) throw new TypeError("Permission rule file is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(current);
	} catch {
		throw new TypeError("Permission rule file is malformed");
	}
	if (isRecord(parsed) && Object.keys(parsed).length === 0) return { version: FILE_VERSION, rules: [] };
	if (isRecord(parsed) && parsed.version === 1) return { version: FILE_VERSION, rules: [] };
	if (!isRecord(parsed) || !hasExactKeys(parsed, ["version", "rules"]) || parsed.version !== FILE_VERSION) {
		throw new TypeError("Permission rule file has an unsupported schema");
	}
	if (!Array.isArray(parsed.rules) || parsed.rules.length > MAX_RULES_TOTAL) {
		throw new TypeError("Permission rule file exceeds its limits");
	}
	const rules = parsed.rules.map(parseRule);
	if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
		throw new TypeError("Permission rule file contains duplicate rules");
	}
	const perProject = new Map<string, number>();
	for (const rule of rules) perProject.set(rule.projectPath, (perProject.get(rule.projectPath) ?? 0) + 1);
	if ([...perProject.values()].some((count) => count > MAX_RULES_PER_PROJECT)) {
		throw new TypeError("Permission rule project exceeds its limit");
	}
	return { version: FILE_VERSION, rules };
}

function serializeFile(rules: readonly ProjectPermissionRule[]): string {
	const serialized = `${JSON.stringify({ version: FILE_VERSION, rules }, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw new TypeError("Permission rule file is too large");
	return serialized;
}

function freezeRule(rule: ProjectPermissionRule): ProjectPermissionRule {
	return Object.freeze({ ...rule, summary: Object.freeze(rule.summary.map((entry) => Object.freeze({ ...entry }))) });
}

export class ProjectPermissionRuleStore {
	private readonly storage: FileAuthStorageBackend;

	constructor(agentDir: string) {
		this.storage = new FileAuthStorageBackend(join(agentDir, "permission-rules.json"));
	}

	match(input: ProjectPermissionRuleInput): ProjectPermissionRule | undefined {
		const normalized = normalizeInput(input, true);
		return this.storage.withLock((current) => {
			const rule = parseFile(current).rules.find(
				(candidate) => candidate.projectPath === normalized.projectPath && candidate.id === normalized.id,
			);
			return { result: rule ? freezeRule(rule) : undefined };
		});
	}

	rememberAllow(input: ProjectPermissionRuleInput): ProjectPermissionRule {
		return this.remember(input, "allow");
	}

	rememberDeny(input: ProjectPermissionRuleInput): ProjectPermissionRule {
		return this.remember(input, "deny");
	}

	private remember(input: ProjectPermissionRuleInput, decision: "allow" | "deny"): ProjectPermissionRule {
		const normalized = normalizeInput(input, true);
		return this.storage.withLock((current) => {
			const file = parseFile(current);
			const existingIndex = file.rules.findIndex((rule) => rule.id === normalized.id);
			const existing = file.rules[existingIndex];
			if (existing?.decision === "deny" || existing?.decision === decision) {
				return { result: freezeRule(existing) };
			}

			const rule = freezeRule({
				...normalized,
				decision,
				createdAt: new Date().toISOString(),
			});
			if (existing) {
				const rules = [...file.rules];
				rules[existingIndex] = rule;
				return { result: freezeRule(rule), next: serializeFile(rules) };
			}
			if (file.rules.length >= MAX_RULES_TOTAL) throw new TypeError("Permission rule store is full");
			if (
				file.rules.filter((candidate) => candidate.projectPath === normalized.projectPath).length >=
				MAX_RULES_PER_PROJECT
			) {
				throw new TypeError("Permission rule project is full");
			}
			return { result: freezeRule(rule), next: serializeFile([...file.rules, rule]) };
		});
	}

	list(projectPath: string): readonly ProjectPermissionRule[] {
		const canonicalProject = canonicalProjectPath(projectPath);
		return this.storage.withLock((current) => ({
			result: Object.freeze(
				parseFile(current)
					.rules.filter((rule) => rule.projectPath === canonicalProject)
					.map(freezeRule),
			),
		}));
	}

	delete(projectPath: string, id: string): boolean {
		const canonicalProject = canonicalProjectPath(projectPath);
		const ruleId = requiredDigest(id, "id");
		return this.storage.withLock((current) => {
			const file = parseFile(current);
			const rules = file.rules.filter((rule) => rule.projectPath !== canonicalProject || rule.id !== ruleId);
			return {
				result: rules.length !== file.rules.length,
				...(rules.length === file.rules.length ? {} : { next: serializeFile(rules) }),
			};
		});
	}

	clear(projectPath: string): number {
		const canonicalProject = canonicalProjectPath(projectPath);
		return this.storage.withLock((current) => {
			const file = parseFile(current);
			const rules = file.rules.filter((rule) => rule.projectPath !== canonicalProject);
			const removed = file.rules.length - rules.length;
			return { result: removed, ...(removed === 0 ? {} : { next: serializeFile(rules) }) };
		});
	}
}
