import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import { createPermissionAuditEvent, type PermissionAuditEvent, type PermissionAuditWriter } from "./audit.ts";
import { ExecutionGrantStore } from "./grant-store.ts";
import { digestCanonical, digestPermissionAction } from "./normalize.ts";
import { PermissionPolicy, type PermissionPolicyInput } from "./policy.ts";
import type { ProjectPermissionRuleInput } from "./project-rules.ts";
import {
	type PermissionReviewer,
	type PermissionReviewRequest,
	type PermissionReviewResult,
	type TrustedUserMessage,
	unavailableReview,
	validateReviewResult,
} from "./reviewer.ts";
import type {
	ExecutionGrant,
	NormalizedPermissionAction,
	PermissionPolicyDecision,
	PermissionSettings,
	RiskLevel,
} from "./types.ts";

export interface PermissionExecutionRequest<T> {
	readonly action: NormalizedPermissionAction;
	readonly settings: PermissionSettings;
	readonly trustedUserMessages: readonly TrustedUserMessage[];
	readonly interactive: boolean;
	readonly signal: AbortSignal;
	readonly execute: (grant: ExecutionGrant) => Promise<T>;
}

export type PermissionRuntimeInvalidation =
	| "settings"
	| "cwd"
	| "model"
	| "tool-registry"
	| "project-rules"
	| "session"
	| "sandbox-health";

interface ProjectRuleMatch {
	readonly decision: "allow" | "deny";
}

export interface ProjectPermissionRuleMatcher {
	match(input: ProjectPermissionRuleInput): ProjectRuleMatch | undefined;
}

export interface ToolAuthorizationRuntimeOptions {
	readonly sessionId: string;
	readonly policy?: PermissionPolicy;
	readonly projectRules?: ProjectPermissionRuleMatcher;
	readonly projectPath?: string;
	readonly reviewerFactory?: () => PermissionReviewer;
	readonly grants?: ExecutionGrantStore;
	readonly audit?: PermissionAuditWriter;
	readonly now?: () => number;
	readonly createEventId?: () => string;
}

type AllowedDecision = Exclude<PermissionPolicyDecision, { readonly kind: "deny" }>;
type AuthorizationSource = "policy" | "rule" | "review";

interface RuntimeSnapshot {
	readonly action: NormalizedPermissionAction;
	readonly settings: PermissionSettings;
	readonly epoch: number;
}

export class PermissionDeniedError extends Error {
	readonly reasonCode: string;

	constructor(reasonCode: string) {
		super(`Permission denied: ${reasonCode}`);
		this.name = "PermissionDeniedError";
		this.reasonCode = reasonCode;
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new PermissionDeniedError("request.cancelled");
}

function actionChangeReason(
	expected: NormalizedPermissionAction,
	current: NormalizedPermissionAction,
): string | undefined {
	if (current.toolIdentity !== expected.toolIdentity) return "Tool identity changed";
	if (current.argsDigest !== expected.argsDigest) return "Tool arguments changed";
	if (current.cwd !== expected.cwd) return "Working directory changed";
	if (!isDeepStrictEqual(current.workspaceRoots, expected.workspaceRoots)) return "Workspace roots changed";
	if (!isDeepStrictEqual(current.readPaths, expected.readPaths)) return "Read scope changed";
	if (!isDeepStrictEqual(current.writePaths, expected.writePaths)) return "Write scope changed";
	if (!isDeepStrictEqual(current.networkEndpoints, expected.networkEndpoints)) return "Network scope changed";
	if (digestPermissionAction(current) !== digestPermissionAction(expected)) return "Permission action changed";
	return undefined;
}

function ruleInput(
	projectPath: string,
	action: NormalizedPermissionAction,
	decision: AllowedDecision,
): ProjectPermissionRuleInput {
	return Object.freeze({
		projectPath,
		actionDigest: digestPermissionAction(action),
		grantDigest: digestCanonical(decision.grant),
		toolName: action.toolName,
		toolIdentity: action.toolIdentity,
		riskLevel: decision.riskLevel,
		summary: Object.freeze([]),
	});
}

function reasonCodeForReview(result: PermissionReviewResult): string {
	if (result.kind === "unavailable") return "review.unavailable";
	return result.kind === "allow" ? "review.allow" : "review.deny";
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new PermissionDeniedError("request.cancelled"));
	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new PermissionDeniedError("request.cancelled"));
		signal.addEventListener("abort", abort, { once: true });
	});
	return Promise.race([operation, cancelled]).finally(() => {
		if (abort) signal.removeEventListener("abort", abort);
	});
}

export class ToolAuthorizationRuntime {
	private readonly options: ToolAuthorizationRuntimeOptions;
	private readonly policy: PermissionPolicy;
	private readonly grants: ExecutionGrantStore;
	private readonly now: () => number;
	private readonly createEventId: () => string;
	private readonly projectPath: string | undefined;
	private reviewTail: Promise<void> = Promise.resolve();
	private reviewer: PermissionReviewer | undefined;
	private epoch = 0;
	private lifecycle = new AbortController();

	constructor(options: ToolAuthorizationRuntimeOptions) {
		this.options = options;
		this.policy = options.policy ?? new PermissionPolicy();
		this.grants = options.grants ?? new ExecutionGrantStore();
		this.now = options.now ?? Date.now;
		this.createEventId = options.createEventId ?? randomUUID;
		this.projectPath = options.projectPath
			? canonicalizeActionPath(options.projectPath, options.projectPath)
			: undefined;
	}

	invalidate(reason: PermissionRuntimeInvalidation): number {
		this.epoch += 1;
		this.lifecycle.abort(new Error(`Permission runtime invalidated: ${reason}`));
		this.lifecycle = new AbortController();
		this.grants.revokeAll();
		if (reason === "model" || reason === "session") this.reviewer = undefined;
		return this.epoch;
	}

	private snapshot<T>(request: PermissionExecutionRequest<T>): RuntimeSnapshot {
		const action = request.action;
		return Object.freeze({
			action: Object.freeze({
				...action,
				workspaceRoots: Object.freeze([...action.workspaceRoots]),
				readPaths: Object.freeze([...action.readPaths]),
				writePaths: Object.freeze([...action.writePaths]),
				networkEndpoints: Object.freeze(
					action.networkEndpoints.map(({ hostname, port }) => Object.freeze({ hostname, port })),
				),
				effects: Object.freeze([...action.effects]),
			}),
			settings: Object.freeze({ ...request.settings }),
			epoch: this.epoch,
		});
	}

	private evaluate(snapshot: RuntimeSnapshot): PermissionPolicyDecision {
		return this.policy.evaluate({
			action: snapshot.action,
			settings: snapshot.settings,
		} satisfies PermissionPolicyInput);
	}

	private matchRule(action: NormalizedPermissionAction, decision: AllowedDecision): ProjectRuleMatch | undefined {
		const { projectRules } = this.options;
		const projectPath = this.projectPath;
		if (!projectPath || !projectRules || !action.workspaceRoots.includes(projectPath)) return undefined;
		try {
			return projectRules.match(ruleInput(projectPath, action, decision));
		} catch {
			throw new PermissionDeniedError("rule.unavailable");
		}
	}

	private reviewerForRequest(): PermissionReviewer {
		if (this.reviewer) return this.reviewer;
		if (!this.options.reviewerFactory) throw new PermissionDeniedError("review.unavailable");
		this.reviewer = this.options.reviewerFactory();
		return this.reviewer;
	}

	private linkedSignal(requestSignal: AbortSignal): AbortSignal {
		return AbortSignal.any([requestSignal, this.lifecycle.signal]);
	}

	private queueReview(request: PermissionReviewRequest): Promise<PermissionReviewResult> {
		const queued = this.reviewTail.then(async () => {
			if (request.signal.aborted) return unavailableReview(request.decision.minimumReviewer, "Review cancelled");
			let result: PermissionReviewResult;
			try {
				result = await this.reviewerForRequest().review(request);
			} catch {
				return unavailableReview(request.decision.minimumReviewer, "Permission reviewer failed unexpectedly");
			}
			return validateReviewResult(request, result);
		});
		this.reviewTail = queued.then(
			() => undefined,
			() => undefined,
		);
		return raceAbort(queued, request.signal);
	}

	private assertUnchanged<T>(request: PermissionExecutionRequest<T>, initial: RuntimeSnapshot): RuntimeSnapshot {
		const current = this.snapshot(request);
		const changed = actionChangeReason(initial.action, current.action);
		if (changed) throw new PermissionDeniedError(changed);
		if (digestCanonical(current.settings) !== digestCanonical(initial.settings)) {
			throw new PermissionDeniedError("Permission settings changed");
		}
		if (current.epoch !== initial.epoch) throw new PermissionDeniedError("Permission runtime changed");
		return current;
	}

	private assertAuthorizationStillValid(
		snapshot: RuntimeSnapshot,
		initialDecision: AllowedDecision,
		source: AuthorizationSource,
	): void {
		const currentDecision = this.evaluate(snapshot);
		if (currentDecision.kind === "deny") throw new PermissionDeniedError("policy.changed");
		if (digestCanonical(currentDecision.grant) !== digestCanonical(initialDecision.grant)) {
			throw new PermissionDeniedError("grant.changed");
		}
		const rule = this.matchRule(snapshot.action, currentDecision);
		if (rule?.decision === "deny") throw new PermissionDeniedError("rule.deny");
		if (source === "rule" && rule?.decision !== "allow") {
			throw new PermissionDeniedError("rule.changed");
		}
	}

	private async appendAudit(
		action: NormalizedPermissionAction,
		riskLevel: RiskLevel,
		stage: PermissionAuditEvent["stage"],
		outcome: PermissionAuditEvent["outcome"],
		reasonCode: string,
		details: Pick<PermissionAuditEvent, "reviewer" | "executionTarget"> = {},
	): Promise<void> {
		if (!this.options.audit) return;
		try {
			const event = createPermissionAuditEvent({
				eventId: this.createEventId(),
				sessionId: this.options.sessionId,
				actionId: action.actionId,
				actionDigest: digestPermissionAction(action),
				toolName: action.toolName,
				provenance: action.provenance,
				riskLevel,
				stage,
				outcome,
				...details,
				reasonCode,
				timestamp: new Date(this.now()).toISOString(),
			});
			await this.options.audit.append(event);
		} catch {
			// Audit infrastructure is observational and cannot widen or reverse a decision.
		}
	}

	async authorizeAndExecute<T>(request: PermissionExecutionRequest<T>): Promise<T> {
		throwIfAborted(request.signal);
		const initial = this.snapshot(request);
		const initialDecision = this.evaluate(initial);
		if (initialDecision.kind === "deny") {
			await this.appendAudit(initial.action, initialDecision.riskLevel, "decision", "deny", "policy.deny");
			throw new PermissionDeniedError("policy.deny");
		}

		const initialRule = this.matchRule(initial.action, initialDecision);
		if (initialRule?.decision === "deny") {
			await this.appendAudit(initial.action, initialDecision.riskLevel, "decision", "deny", "rule.deny");
			throw new PermissionDeniedError("rule.deny");
		}

		let source: AuthorizationSource =
			initialDecision.kind === "review" &&
			initialRule?.decision === "allow" &&
			initialDecision.riskLevel !== "critical"
				? "rule"
				: "policy";
		if (initialDecision.kind === "review" && source !== "rule") {
			const signal = this.linkedSignal(request.signal);
			const reviewRequest: PermissionReviewRequest = Object.freeze({
				action: initial.action,
				decision: initialDecision,
				trustedUserMessages: Object.freeze(
					request.trustedUserMessages.map(({ messageId, text }) => Object.freeze({ messageId, text })),
				),
				redactedArguments: Object.freeze({}),
				interactive: request.interactive,
				signal,
			});
			let review: PermissionReviewResult;
			try {
				review = await this.queueReview(reviewRequest);
			} catch {
				review = unavailableReview(initialDecision.minimumReviewer, "Permission review was cancelled");
			}
			await this.appendAudit(
				initial.action,
				initialDecision.riskLevel,
				"review",
				review.kind === "allow" ? "allow" : review.kind === "deny" ? "deny" : "unavailable",
				reasonCodeForReview(review),
				{ reviewer: review.reviewer },
			);
			if (review.kind !== "allow") throw new PermissionDeniedError(reasonCodeForReview(review));
			source = "review";
		}
		await this.appendAudit(
			initial.action,
			initialDecision.riskLevel,
			"decision",
			"allow",
			source === "rule" ? "rule.allow" : source === "review" ? "review.allow" : "policy.allow",
			{ executionTarget: initialDecision.grant.executionTarget },
		);

		throwIfAborted(request.signal);
		const reviewed = this.assertUnchanged(request, initial);
		this.assertAuthorizationStillValid(reviewed, initialDecision, source);
		const grant = this.grants.issue({
			action: reviewed.action,
			grant: initialDecision.grant,
			settingsEpoch: reviewed.epoch,
		});
		await this.appendAudit(reviewed.action, initialDecision.riskLevel, "grant-issued", "allow", "grant.issued", {
			executionTarget: grant.executionTarget,
		});

		try {
			throwIfAborted(request.signal);
			const current = this.assertUnchanged(request, initial);
			this.assertAuthorizationStillValid(current, initialDecision, source);
			let consumed: ExecutionGrant;
			try {
				consumed = this.grants.consumeExact(grant.grantId, {
					action: current.action,
					settingsEpoch: current.epoch,
					executionTarget: grant.executionTarget,
				});
			} catch (error) {
				await this.appendAudit(
					current.action,
					initialDecision.riskLevel,
					"grant-revoked",
					"failure",
					"grant.mismatch",
					{ executionTarget: grant.executionTarget },
				);
				throw error;
			}
			try {
				const result = await request.execute(consumed);
				await this.appendAudit(
					current.action,
					initialDecision.riskLevel,
					"execution",
					"success",
					"execution.success",
					{
						executionTarget: consumed.executionTarget,
					},
				);
				return result;
			} catch (error) {
				await this.appendAudit(
					current.action,
					initialDecision.riskLevel,
					"execution",
					request.signal.aborted ? "cancelled" : "failure",
					request.signal.aborted ? "execution.cancelled" : "execution.failure",
					{ executionTarget: consumed.executionTarget },
				);
				throw error;
			}
		} finally {
			if (this.grants.revoke(grant.grantId)) {
				await this.appendAudit(
					reviewed.action,
					initialDecision.riskLevel,
					"grant-revoked",
					"cancelled",
					"grant.revoked",
					{ executionTarget: grant.executionTarget },
				);
			}
		}
	}
}
