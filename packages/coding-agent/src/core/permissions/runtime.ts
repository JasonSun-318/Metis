import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import { createPermissionAuditEvent, type PermissionAuditEvent, type PermissionAuditWriter } from "./audit.ts";
import type { AutoCommandRule } from "./auto-command-rules.ts";
import { ExecutionGrantStore } from "./grant-store.ts";
import { digestCanonical, digestPermissionAction, digestRememberedPermissionAction } from "./normalize.ts";
import type { PermissionRule } from "./permission-rules.ts";
import { PermissionPolicy, type PermissionPolicyInput } from "./policy.ts";
import type { ProjectPermissionRuleInput } from "./project-rules.ts";
import {
	type PermissionManualReason,
	type PermissionReviewer,
	type PermissionReviewRequest,
	type PermissionReviewResult,
	type TrustedUserMessage,
	unavailableReview,
	validateReviewResult,
} from "./reviewer.ts";
import { redactPermissionArguments } from "./reviewer-input.ts";
import { isFullAccess } from "./settings.ts";
import type {
	ExecutionGrant,
	NormalizedPermissionAction,
	PermissionPolicyDecision,
	PermissionSettings,
	RiskLevel,
} from "./types.ts";

export interface PermissionExecutionRequest<T> {
	readonly action: NormalizedPermissionAction;
	readonly args: unknown;
	readonly settings: PermissionSettings;
	readonly sandboxHealth: "healthy" | "unavailable" | "misconfigured";
	readonly trustedUserMessages: readonly TrustedUserMessage[];
	readonly interactive: boolean;
	readonly signal: AbortSignal;
	readonly execute: (grant: ExecutionGrant) => Promise<T>;
	readonly autoCommandRules: readonly AutoCommandRule[];
	/**
	 * Effective permission rules. When omitted, the policy uses the 51 defaults
	 * plus `autoCommandRules`; an explicit empty array authorizes no rule.
	 */
	readonly permissionRules?: readonly PermissionRule[];
	/** Re-evaluate an unstarted action after a live permission change. Action identity must stay exact. */
	readonly revalidateOnSettingsChange?: boolean;
}

export type PermissionRuntimeInvalidation =
	| "settings"
	| "cwd"
	| "model"
	| "tool-registry"
	| "provenance"
	| "project-rules"
	| "session"
	| "sandbox-health";

interface ProjectRuleMatch {
	readonly decision: "allow" | "deny";
	readonly id?: string;
	readonly toolName?: string;
	readonly summary?: ProjectPermissionRuleInput["summary"];
	/** Present only when a real store returned its exact rule; test stubs may omit it. */
	readonly matchedRule?: { readonly id: string; readonly name: string; readonly scope: "project" | "session" };
}

export interface ProjectPermissionRuleMatcher {
	match(input: ProjectPermissionRuleInput): ProjectRuleMatch | undefined;
	/** Optional so stub matchers only implement matching; live stores support clearing. */
	clear?(projectPath: string): number;
}

export type PermissionReviewBoundaryEvent =
	| {
			readonly phase: "started";
			readonly actionId: string;
			readonly reviewer: "model" | "user";
			readonly riskLevel: RiskLevel;
	  }
	| {
			readonly phase: "completed";
			readonly actionId: string;
			readonly reviewer: "model" | "user";
			readonly outcome: "allow" | "deny" | "unavailable";
			readonly riskLevel: RiskLevel;
	  };

export interface PermissionAuthorizationDecision {
	readonly actionId: string;
	readonly toolName: string;
	readonly source: "rule" | "model" | "user" | "full";
	readonly ruleIds?: readonly string[];
	readonly matchedRule?: { readonly id: string; readonly name: string; readonly scope: string };
	readonly manualReason?: PermissionManualReason;
	readonly remember?: "session" | "project";
}

export interface ToolAuthorizationRuntimeOptions {
	readonly sessionId: string;
	readonly policy?: PermissionPolicy;
	readonly projectRules?: ProjectPermissionRuleMatcher;
	/** In-memory exact allows remembered for this live session; never shared across sessions. */
	readonly sessionRules?: ProjectPermissionRuleMatcher;
	readonly projectPath?: string;
	/** Engine-managed roots (e.g. the memory vault) builtin memory tools may write under. */
	readonly managedMemoryRoots?: readonly string[];
	readonly reviewerFactory?: () => PermissionReviewer;
	readonly grants?: ExecutionGrantStore;
	readonly audit?: PermissionAuditWriter;
	readonly now?: () => number;
	readonly createEventId?: () => string;
	readonly onReview?: (event: PermissionReviewBoundaryEvent) => void;
	readonly onDecision?: (event: PermissionAuthorizationDecision) => void;
}

type AllowedDecision = Exclude<PermissionPolicyDecision, { readonly kind: "deny" }>;
type AuthorizationSource = "policy" | "rule" | "permission-rule" | "review";

interface RuntimeSnapshot {
	readonly action: NormalizedPermissionAction;
	readonly settings: PermissionSettings;
	readonly sandboxHealth: PermissionExecutionRequest<unknown>["sandboxHealth"];
	readonly epoch: number;
	readonly autoCommandRules: readonly AutoCommandRule[];
	readonly permissionRules: readonly PermissionRule[] | undefined;
}

export class PermissionDeniedError extends Error {
	readonly reasonCode: string;

	constructor(reasonCode: string, displayReason = reasonCode) {
		super(`Permission denied: ${displayReason}`);
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

/** Exact stores return validated rule fields; minimal matchers may omit display metadata. */
function exactRuleMatch(match: ProjectRuleMatch, scope: "project" | "session"): ProjectRuleMatch {
	if (match.id === undefined || match.toolName === undefined) return { decision: match.decision };
	const name = match.summary?.find((entry) => entry.label === "Command")?.value ?? match.toolName;
	const shortName =
		Buffer.byteLength(name, "utf8") <= 256
			? name
			: `${Buffer.from(name).subarray(0, 253).toString("utf8").replace(/�$/u, "")}…`;
	return Object.freeze({
		decision: match.decision,
		matchedRule: Object.freeze({ id: match.id, name: shortName, scope }),
	});
}

function ruleMatchDetails(match: ProjectRuleMatch | undefined): {
	readonly ruleIds?: readonly string[];
	readonly matchedRule?: { readonly id: string; readonly name: string; readonly scope: string };
} {
	const matchedRule = match?.matchedRule;
	if (!matchedRule) return {};
	return { ruleIds: [matchedRule.id], matchedRule };
}

function ruleInput(
	projectPath: string,
	action: NormalizedPermissionAction,
	decision: AllowedDecision,
): ProjectPermissionRuleInput {
	return Object.freeze({
		projectPath,
		actionDigest: digestRememberedPermissionAction(action),
		grantDigest: digestCanonical(decision.grant),
		toolName: action.toolName,
		toolIdentity: action.toolIdentity,
		riskLevel: decision.riskLevel,
		summary: Object.freeze([]),
	});
}

/**
 * Exact remembered allows may only replace a human review when the action scope
 * is complete: unknown effects or a commandless Bash action have no reusable
 * exact identity. Critical effects are excluded by the risk level check.
 */
function rememberedScopeIsReusable(action: NormalizedPermissionAction): boolean {
	if (action.effects.includes("unknown")) return false;
	if (action.toolName === "bash" && action.command === undefined) return false;
	return true;
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
	private readonly managedMemoryRoots: readonly string[];
	private reviewTail: Promise<void> = Promise.resolve();
	private reviewer: PermissionReviewer | undefined;
	private epoch = 0;
	private authorityEpoch = 0;
	private lifecycle = new AbortController();
	private currentReview:
		| { readonly actionId: string; readonly reviewer: "model" | "user"; readonly riskLevel: RiskLevel }
		| undefined;

	constructor(options: ToolAuthorizationRuntimeOptions) {
		this.options = options;
		this.policy = options.policy ?? new PermissionPolicy();
		this.grants = options.grants ?? new ExecutionGrantStore();
		this.now = options.now ?? Date.now;
		this.createEventId = options.createEventId ?? randomUUID;
		this.projectPath = options.projectPath
			? canonicalizeActionPath(options.projectPath, options.projectPath)
			: undefined;
		// Action paths are canonicalized during normalization; keep the managed
		// roots on the same footing or containment checks break under symlinked
		// prefixes (e.g. macOS /var -> /private/var).
		this.managedMemoryRoots = Object.freeze(
			(options.managedMemoryRoots ?? []).map((root) => canonicalizeActionPath(root, root)),
		);
	}

	get activeReview():
		| { readonly actionId: string; readonly reviewer: "model" | "user"; readonly riskLevel: RiskLevel }
		| undefined {
		return this.currentReview;
	}

	get activeGrantCount(): number {
		return this.grants.size;
	}

	invalidate(reason: PermissionRuntimeInvalidation): number {
		this.epoch += 1;
		if (reason !== "settings") this.authorityEpoch += 1;
		this.lifecycle.abort(new Error(`Permission runtime invalidated: ${reason}`));
		this.lifecycle = new AbortController();
		this.reviewTail = Promise.resolve();
		this.currentReview = undefined;
		this.grants.revokeAll();
		if (reason === "model" || reason === "session") this.reviewer = undefined;
		// Session allows bind to the cwd, tool identity and provenance they were
		// approved for; a reviewer/model switch or mode change must keep them.
		if (reason === "cwd" || reason === "provenance" || reason === "tool-registry") this.clearSessionRules();
		return this.epoch;
	}

	private clearSessionRules(): void {
		const { sessionRules } = this.options;
		if (!sessionRules || !this.projectPath) return;
		try {
			sessionRules.clear?.(this.projectPath);
		} catch {
			// Store failures cannot resurrect revoked grants; matching re-checks anyway.
		}
	}

	private snapshot<T>(request: PermissionExecutionRequest<T>): RuntimeSnapshot {
		const action = request.action;
		if (digestCanonical(request.args) !== action.argsDigest) {
			throw new PermissionDeniedError("Tool arguments changed");
		}
		let permissionRules: readonly PermissionRule[] | undefined;
		let autoCommandRules: readonly AutoCommandRule[] = [];
		if (!isFullAccess(request.settings)) {
			try {
				const configured = request.permissionRules;
				if (configured !== undefined) {
					permissionRules = Object.freeze(configured.map((rule) => Object.freeze({ ...rule })));
				} else {
					autoCommandRules = Object.freeze(
						(request.autoCommandRules ?? []).map((rule) => Object.freeze({ ...rule })),
					);
				}
			} catch {
				// Settings reports the configuration error. Disable rule-based allows,
				// while independent exact grants and the review path remain available.
				permissionRules = Object.freeze([]);
			}
		}
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
			sandboxHealth: request.sandboxHealth,
			epoch: this.epoch,
			autoCommandRules,
			permissionRules,
		});
	}

	private evaluate(snapshot: RuntimeSnapshot): PermissionPolicyDecision {
		const decision = this.policy.evaluate({
			action: snapshot.action,
			settings: snapshot.settings,
			autoCommandRules: snapshot.autoCommandRules,
			...(snapshot.permissionRules === undefined ? {} : { permissionRules: snapshot.permissionRules }),
			managedMemoryRoots: this.managedMemoryRoots,
		} satisfies PermissionPolicyInput);
		if (
			decision.kind !== "deny" &&
			decision.grant.executionTarget === "sandbox" &&
			snapshot.sandboxHealth !== "healthy"
		) {
			return Object.freeze({ kind: "deny", riskLevel: decision.riskLevel, reason: "Sandbox is unavailable" });
		}
		return decision;
	}

	private matchRule(action: NormalizedPermissionAction, decision: AllowedDecision): ProjectRuleMatch | undefined {
		const { projectRules, sessionRules } = this.options;
		const projectPath = this.projectPath;
		if (!projectPath || (!projectRules && !sessionRules) || !action.workspaceRoots.includes(projectPath)) {
			return undefined;
		}
		try {
			const input = ruleInput(projectPath, action, decision);
			// A project deny always wins; both stores otherwise only ever allow.
			const project = projectRules?.match(input);
			if (project) return exactRuleMatch(project, "project");
			const session = sessionRules?.match(input);
			return session ? exactRuleMatch(session, "session") : undefined;
		} catch {
			throw new PermissionDeniedError("rule.unavailable");
		}
	}

	private notifyReview(event: PermissionReviewBoundaryEvent): void {
		try {
			this.options.onReview?.(event);
		} catch {
			// Review status projection cannot widen or reverse a decision.
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
		if (digestCanonical(current.autoCommandRules) !== digestCanonical(initial.autoCommandRules)) {
			throw new PermissionDeniedError("Auto command rules changed");
		}
		if (digestCanonical(current.permissionRules ?? null) !== digestCanonical(initial.permissionRules ?? null)) {
			throw new PermissionDeniedError("Permission rules changed");
		}
		if (current.sandboxHealth !== initial.sandboxHealth) {
			throw new PermissionDeniedError("Sandbox health changed");
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
		const rule = isFullAccess(snapshot.settings) ? undefined : this.matchRule(snapshot.action, currentDecision);
		if (rule?.decision === "deny") throw new PermissionDeniedError("rule.deny");
		if (source === "rule" && rule?.decision !== "allow") {
			throw new PermissionDeniedError("rule.changed");
		}
		if (
			source === "permission-rule" &&
			(currentDecision.kind !== "allow" || (currentDecision.ruleIds?.length ?? 0) === 0)
		) {
			throw new PermissionDeniedError("permission.rule.changed");
		}
	}

	private async appendAudit(
		action: NormalizedPermissionAction,
		riskLevel: RiskLevel,
		stage: PermissionAuditEvent["stage"],
		outcome: PermissionAuditEvent["outcome"],
		reasonCode: string,
		details: Pick<PermissionAuditEvent, "reviewer" | "executionTarget" | "ruleIds" | "matchedRule" | "remember"> = {},
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
		const initial = this.snapshot(request);
		const originalAction = initial.action;
		const authorityEpoch = this.authorityEpoch;
		for (let attempt = 0; attempt < 16; attempt++) {
			throwIfAborted(request.signal);
			const epoch = this.epoch;
			let started = false;
			try {
				return await this.authorizeAttempt(request, attempt === 0 ? initial : undefined, () => {
					started = true;
				});
			} catch (error) {
				if (
					!request.revalidateOnSettingsChange ||
					started ||
					this.epoch === epoch ||
					this.authorityEpoch !== authorityEpoch
				)
					throw error;
				throwIfAborted(request.signal);
				const changed = actionChangeReason(originalAction, this.snapshot(request).action);
				if (changed) throw new PermissionDeniedError(changed);
			}
		}
		throw new PermissionDeniedError("settings.unstable");
	}

	private async authorizeAttempt<T>(
		request: PermissionExecutionRequest<T>,
		firstSnapshot: RuntimeSnapshot | undefined,
		onStarted: () => void,
	): Promise<T> {
		throwIfAborted(request.signal);
		const initial = firstSnapshot ?? this.snapshot(request);
		const initialDecision = this.evaluate(initial);
		if (initialDecision.kind === "deny") {
			await this.appendAudit(initial.action, initialDecision.riskLevel, "decision", "deny", "policy.deny");
			throw new PermissionDeniedError("policy.deny", initialDecision.reason);
		}

		const initialRule = isFullAccess(initial.settings) ? undefined : this.matchRule(initial.action, initialDecision);
		const initialRuleDetails = ruleMatchDetails(initialRule);
		if (initialRule?.decision === "deny") {
			await this.appendAudit(
				initial.action,
				initialDecision.riskLevel,
				"decision",
				"deny",
				"rule.deny",
				initialRuleDetails,
			);
			throw new PermissionDeniedError("rule.deny");
		}

		let finalSource: PermissionAuthorizationDecision["source"] = isFullAccess(initial.settings) ? "full" : "rule";
		let manualReason: PermissionManualReason | undefined;
		let remember: "session" | "project" | undefined;
		const permissionRuleAllowed = initialDecision.kind === "allow" && (initialDecision.ruleIds?.length ?? 0) > 0;
		let source: AuthorizationSource =
			initialDecision.kind === "review" &&
			initialRule?.decision === "allow" &&
			initialDecision.riskLevel !== "critical" &&
			rememberedScopeIsReusable(initial.action)
				? "rule"
				: permissionRuleAllowed
					? "permission-rule"
					: "policy";
		if (initialDecision.kind === "review" && source !== "rule") {
			const signal = this.linkedSignal(request.signal);
			let redactedArguments: unknown;
			try {
				// Builtin Bash may prepend runtime protections. Review the command
				// that the trusted descriptor bound to execution, including that prefix.
				const args =
					initial.action.provenance === "builtin" && initial.action.toolName === "bash"
						? { ...(request.args as Record<string, unknown>), command: initial.action.command }
						: request.args;
				redactedArguments = redactPermissionArguments(args);
			} catch {
				throw new PermissionDeniedError("review.arguments.invalid");
			}
			const reviewRequest: PermissionReviewRequest = Object.freeze({
				action: initial.action,
				decision: initialDecision,
				trustedUserMessages: Object.freeze(
					request.trustedUserMessages.map(({ messageId, text }) => Object.freeze({ messageId, text })),
				),
				redactedArguments,
				interactive: request.interactive,
				signal,
			});
			const activeReview = {
				actionId: initial.action.actionId,
				reviewer: initialDecision.minimumReviewer,
				riskLevel: initialDecision.riskLevel,
			};
			this.currentReview = activeReview;
			this.notifyReview({ phase: "started", ...activeReview });
			let review: PermissionReviewResult;
			try {
				review = await this.queueReview(reviewRequest);
			} catch {
				review = unavailableReview(initialDecision.minimumReviewer, "Permission review was cancelled");
			} finally {
				if (this.currentReview === activeReview) this.currentReview = undefined;
			}
			this.notifyReview({
				phase: "completed",
				actionId: initial.action.actionId,
				reviewer: review.reviewer,
				outcome: review.kind === "allow" ? "allow" : review.kind === "deny" ? "deny" : "unavailable",
				riskLevel: initialDecision.riskLevel,
			});
			await this.appendAudit(
				initial.action,
				initialDecision.riskLevel,
				"review",
				review.kind === "allow" ? "allow" : review.kind === "deny" ? "deny" : "unavailable",
				reasonCodeForReview(review),
				{
					reviewer: review.reviewer,
					...(review.kind !== "unavailable" && review.remember ? { remember: review.remember } : {}),
				},
			);
			if (review.kind !== "allow") throw new PermissionDeniedError(reasonCodeForReview(review));
			source = "review";
			finalSource = review.reviewer;
			manualReason = review.reviewer === "user" ? review.manualReason : undefined;
			remember = review.reviewer === "user" ? review.remember : undefined;
		}
		const policyRuleDetails =
			initialDecision.kind === "allow" && initialDecision.ruleIds
				? {
						...(initialDecision.ruleIds ? { ruleIds: initialDecision.ruleIds } : {}),
						...(initialDecision.matchedRule ? { matchedRule: initialDecision.matchedRule } : {}),
					}
				: {};
		const decisionRuleDetails = source === "rule" ? initialRuleDetails : policyRuleDetails;
		await this.appendAudit(
			initial.action,
			initialDecision.riskLevel,
			"decision",
			"allow",
			source === "rule" || source === "permission-rule"
				? "rule.allow"
				: source === "review"
					? "review.allow"
					: "policy.allow",
			{
				executionTarget: initialDecision.grant.executionTarget,
				...decisionRuleDetails,
			},
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
				onStarted();
				try {
					this.options.onDecision?.({
						actionId: current.action.actionId,
						toolName: current.action.toolName,
						source: finalSource,
						...decisionRuleDetails,
						...(manualReason ? { manualReason } : {}),
						...(remember ? { remember } : {}),
					});
				} catch {
					// Presentation observers do not grant or reverse authority.
				}
				throwIfAborted(request.signal);
				this.assertAuthorizationStillValid(this.assertUnchanged(request, initial), initialDecision, source);
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
			this.grants.retire(grant);
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
