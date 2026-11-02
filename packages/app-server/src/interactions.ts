import { createHash, randomUUID } from "node:crypto";
import {
	type BrowserActInput,
	type BrowserToolCall,
	type BrowserToolResult,
	browserActionElementIds,
	compileSchema,
	type DomainEvent,
	findBrowserStateElement,
	type InteractionResponseInput,
	type InteractionView,
	MAX_BROWSER_STATE_UTF8_BYTES,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PERMISSION_OPERATION_ROWS,
	MAX_PUBLIC_TEXT_UTF8_BYTES,
	OpaqueIdSchema,
	type ServerRequestMethod,
	type ServerResult,
	type ServerRpcRequest,
	validateResponseFor,
	validateServerRequest,
} from "@metis/app-protocol";
import {
	type AskUserRequest,
	type AskUserResponse,
	createDialogExtensionUIContext,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type PermissionApprovalDecision,
	type PermissionApprovalRequest,
	type ProjectTrustOption,
	redactPermissionCommand,
} from "@metis/coding-agent/host";
import type { AgentHostIdentity } from "./agent-host-tools.ts";
import { BrowserPermissionDecisionUnavailableError, BrowserPermissionDeniedError } from "./browser-permission-audit.ts";
import { opaqueId } from "./item-projection.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const ASK_USER_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const opaqueIdValidator = compileSchema(OpaqueIdSchema);
const GENERIC_TARGET_KEY =
	/^(action|address|branch|command|directory|file|folder|host|id|name|owner|path|port|project|query|repo|repository|resource|target|url|uri)$/iu;

type PermissionApprovalChoice = Extract<InteractionView, { kind: "session_permission_approval" }>["choices"][number];
type PermissionRiskLevel = Extract<InteractionView, { kind: "session_permission_approval" }>["riskLevel"];
type PermissionExecutionTarget = Extract<InteractionView, { kind: "session_permission_approval" }>["executionTarget"];

export interface InteractionPeer {
	request(request: ServerRpcRequest, signal: AbortSignal): Promise<ServerResult<ServerRequestMethod>>;
}

export interface InteractionBrokerOptions {
	readonly serverEpoch: string;
	readonly defaultTimeoutMs?: number;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly onPendingChange?: (sessionId: string, pending: boolean) => void;
}

type NotificationEvent = Extract<DomainEvent, { type: "interaction/notify" }>;
type BrowserObservation = Extract<BrowserToolResult, { tool: "browser_observe" }>["observation"];
type BrowserActionConfirmation = "allow" | "deny" | "cancelled" | "unavailable";
type InteractionRequestOutcome =
	| { readonly status: "response"; readonly response: InteractionResponseInput }
	| { readonly status: "cancelled" | "unavailable" };
type BrowserStaleReason = Extract<
	Extract<BrowserToolResult, { tool: "browser_act" }>["details"],
	{ status: "stale" }
>["reason"];

function actorFields(sessionId: string, actor?: AgentHostIdentity): Partial<AgentHostIdentity> {
	if (!actor) return {};
	if (actor.rootSessionId !== sessionId || (actor.agentId && actor.actorSessionId !== actor.agentId)) {
		throw new Error("Host interaction actor does not belong to this session");
	}
	return { ...actor };
}

function choiceId(index: number): string {
	return `choice:${index}`;
}

function deadline(now: number, timeout: number): string {
	return new Date(now + timeout).toISOString();
}

function boundedName(value: string, fallback: string): string {
	const source = value || fallback;
	if (source.length <= MAX_NAME_UTF16_UNITS) return source;
	let end = MAX_NAME_UTF16_UNITS;
	const last = source.charCodeAt(end - 1);
	const next = source.charCodeAt(end);
	if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
	return source.slice(0, end);
}

function boundedPublicText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_PUBLIC_TEXT_UTF8_BYTES) return value;
	const bytes = Buffer.from(value, "utf8");
	let end = MAX_PUBLIC_TEXT_UTF8_BYTES;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

const MAX_PERMISSION_COMMAND_UTF8_BYTES = 32_768;

/**
 * Full redacted display command for the approval card. It is never an
 * executable identity: the reviewer re-binds the original action before use.
 * Commands whose redacted form exceeds the protocol bound are never offered
 * for approval — the session owner is asked to split and retry instead.
 */
function approvalDisplayCommand(request: PermissionApprovalRequest): string | undefined {
	if (request.action.command === undefined) return undefined;
	if (Buffer.byteLength(request.action.command, "utf8") > MAX_PERMISSION_COMMAND_UTF8_BYTES) {
		throw new Error("Command exceeds 32 KiB; split it into smaller commands and retry");
	}
	const redacted = redactPermissionCommand(request.action.command);
	if (Buffer.byteLength(redacted, "utf8") > MAX_PERMISSION_COMMAND_UTF8_BYTES) {
		throw new Error("Command exceeds 32 KiB; split it into smaller commands and retry");
	}
	return redacted;
}

function validTimeout(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

function browserOrigin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

function preflightBrowserAction(
	input: BrowserActInput,
	observation: BrowserObservation,
): { readonly staleReason?: BrowserStaleReason; readonly target: string } {
	if (observation.documentId !== input.documentId)
		return { staleReason: "document_changed", target: input.action.type };
	if (browserOrigin(observation.url) !== input.origin)
		return { staleReason: "origin_changed", target: input.action.type };
	if (observation.revision !== input.snapshotRevision)
		return { staleReason: "revision_changed", target: input.action.type };
	// A very long node label can span pages. Do not approve from an incomplete
	// line; the continuation must supply its full accessible target first.
	const state = observation.statePage?.nextCursor
		? observation.state.slice(0, observation.state.lastIndexOf("\n") + 1)
		: observation.state;
	const targets = browserActionElementIds(input.action).map((elementId) => findBrowserStateElement(state, elementId));
	if (targets.some((target) => !target)) return { staleReason: "element_missing", target: input.action.type };
	const target = targets.find((candidate) => candidate?.label ?? candidate?.role);
	return { target: target?.label ?? target?.role ?? input.action.type };
}

function recordArgs(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function approvalRiskLevel(request: PermissionApprovalRequest): PermissionRiskLevel {
	const risk = recordArgs(request.args)?.deterministicRisk;
	if (risk === "low" || risk === "medium" || risk === "high" || risk === "critical") return risk;
	const risks = request.action.risks;
	if (risks.includes("destructive") || risks.includes("external-side-effect")) return "critical";
	if (risks.includes("network") || risks.includes("elevation")) return "high";
	if (risks.includes("workspace-write") || risks.includes("outside-read")) return "medium";
	return "low";
}

function approvalExecutionTarget(request: PermissionApprovalRequest): PermissionExecutionTarget {
	const requested = recordArgs(request.args)?.requestedTarget;
	if (requested === "sandbox" || requested === "host" || requested === "external") return requested;
	return request.executionTarget ?? "host";
}

function priorReviewFields(
	request: PermissionApprovalRequest,
): Pick<Extract<InteractionView, { kind: "session_permission_approval" }>, "priorReviewer" | "priorReviewerOutcome"> {
	const automaticReview = recordArgs(request.args)?.automaticReview;
	if (automaticReview === "deny" || automaticReview === "unavailable") {
		return { priorReviewer: "model", priorReviewerOutcome: automaticReview };
	}
	return {};
}

const WRITABLE_DIRECTORY_LABEL = "Writable directory";

/**
 * Windows sandbox grants cover directories, so the approval card must show the
 * actual write roots rather than the exact file the command named. These come
 * from the reviewed action args, not from the command text.
 */
function writableDirectoryScope(request: PermissionApprovalRequest): readonly string[] {
	if (process.platform !== "win32") return [];
	if (request.action.toolName !== "bash" || approvalExecutionTarget(request) !== "sandbox") return [];
	const paths = recordArgs(request.args)?.writePaths;
	if (!Array.isArray(paths)) return [];
	const directories = paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
	return [...new Set(directories)];
}

function permissionOperation(request: PermissionApprovalRequest) {
	const rows: Array<{ label: string; value: string }> = [];
	const args =
		typeof request.args === "object" && request.args !== null && !Array.isArray(request.args)
			? (request.args as Record<string, unknown>)
			: undefined;
	const describedArgs = recordArgs(args?.redactedArguments) ?? args;
	const push = (label: string, value: string) => {
		const row = { label: boundedName(label, "Detail"), value: boundedPublicText(value) };
		if (!rows.some((candidate) => candidate.label === row.label && candidate.value === row.value)) rows.push(row);
	};

	if (request.actor) {
		push("Agent", `${request.actor.name} (${request.actor.id})`);
		push("Task", request.actor.taskId);
	}
	if (request.action.command) push("Command", redactPermissionCommand(request.action.command));
	if (request.action.toolName === "bash" && request.cwd) push("Working directory", request.cwd);
	// Keep the directory scope even when it equals the working directory: the
	// grant really does cover that directory, not one file inside it.
	for (const directory of writableDirectoryScope(request)) push(WRITABLE_DIRECTORY_LABEL, directory);
	const pathLabel = ["edit", "write", "read"].includes(request.action.toolName) ? "File" : "Path";
	for (const path of request.action.paths) {
		if (request.cwd && path === request.cwd) continue;
		push(pathLabel, path);
	}

	const url =
		request.action.toolName === "web_fetch" && typeof describedArgs?.url === "string" ? describedArgs.url : undefined;
	if (url) push("Address", url);
	if (request.action.toolName === "web_search" && typeof describedArgs?.query === "string") {
		push("Query", describedArgs.query);
	}
	if (["grep", "find"].includes(request.action.toolName) && typeof describedArgs?.pattern === "string") {
		push("Pattern", describedArgs.pattern);
	}
	if (request.action.toolName === "edit" && Array.isArray(describedArgs?.edits) && describedArgs.edits.length > 0) {
		push("Changes", String(describedArgs.edits.length));
	}
	if (!url) {
		for (const { host, port } of request.action.networkTargets) push("Network", `${host}:${port}`);
	}
	if (request.action.provenance !== "builtin" && describedArgs) {
		for (const [key, value] of Object.entries(describedArgs)) {
			if (!GENERIC_TARGET_KEY.test(key) || !["string", "number", "boolean"].includes(typeof value)) continue;
			const text = String(value).trim();
			if (!text) continue;
			const label = key.replaceAll(/[_-]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
			push(label, text);
		}
	}
	if (rows.length === 0) push("Details", request.reason || "No target details were provided by this tool.");
	const visibleRows = rows.slice(0, MAX_PERMISSION_OPERATION_ROWS);
	const omittedRows = rows.length - visibleRows.length;

	return {
		toolName: boundedName(request.action.toolName, "tool"),
		rows: visibleRows,
		omittedRows,
		scopeComplete: request.scopeComplete,
		irreversible: request.action.risks.some((risk) => risk === "destructive" || risk === "external-side-effect"),
		executionTarget: request.executionTarget ?? "host",
		rememberProjectEligible: request.rememberProjectEligible === true,
	};
}

/** Routes session-owned interactive and browser-host requests to the attached desktop peer. */
export class InteractionBroker {
	private readonly serverEpoch: string;
	private readonly defaultTimeoutMs: number;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly onPendingChange?: (sessionId: string, pending: boolean) => void;
	private readonly owners = new Map<string, InteractionPeer>();
	private readonly pending = new Map<string, string>();
	private readonly pendingByAction = new Map<string, string>();
	private readonly pendingAborts = new Map<string, AbortController>();

	constructor(options: InteractionBrokerOptions) {
		if (!validTimeout(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)) {
			throw new TypeError("Interaction timeout must be a positive safe integer");
		}
		this.serverEpoch = options.serverEpoch;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.onPendingChange = options.onPendingChange;
	}

	assign(sessionId: string, peer: InteractionPeer): void {
		this.owners.set(sessionId, peer);
	}

	release(sessionId: string, peer: InteractionPeer): void {
		if (this.owners.get(sessionId) !== peer) return;
		this.owners.delete(sessionId);
		this.abortPending(sessionId);
	}

	releaseSession(sessionId: string): void {
		this.owners.delete(sessionId);
		this.abortPending(sessionId);
	}

	releasePeer(peer: InteractionPeer): void {
		for (const [sessionId, owner] of [...this.owners]) {
			if (owner !== peer) continue;
			this.owners.delete(sessionId);
			this.abortPending(sessionId);
		}
	}

	hasPending(sessionId: string): boolean {
		return [...this.pending.values()].some((pendingSessionId) => pendingSessionId === sessionId);
	}

	async requestBrowserTool(
		sessionId: string,
		toolCallId: string,
		call: BrowserToolCall,
		signal: AbortSignal,
		actor?: AgentHostIdentity,
	): Promise<BrowserToolResult> {
		actorFields(sessionId, actor);
		const peer = this.owners.get(sessionId);
		if (!peer) {
			throw new BrowserPermissionDecisionUnavailableError(
				signal.aborted ? "cancelled" : "unavailable",
				"No interactive desktop owner is available for browser tools",
			);
		}
		if (call.tool === "browser_act" && call.input.risk !== "ordinary") {
			try {
				const preflightCall = {
					tool: "browser_observe",
					input: { browserId: call.input.browserId },
				} satisfies BrowserToolCall;
				let preflight = await this.dispatchBrowserTool(
					peer,
					sessionId,
					this.createId(),
					preflightCall,
					signal,
					actor,
				);
				if (preflight.tool !== "browser_observe")
					throw new Error("Browser preflight returned the wrong tool result");
				let state = preflight.observation.state;
				let checked = preflightBrowserAction(call.input, preflight.observation);
				while (checked.staleReason === "element_missing" && preflight.observation.statePage?.nextCursor) {
					const cursor = preflight.observation.statePage.nextCursor;
					const next = await this.dispatchBrowserTool(
						peer,
						sessionId,
						this.createId(),
						{
							tool: "browser_observe",
							input: { browserId: call.input.browserId, cursor },
						},
						signal,
						actor,
					);
					if (next.tool !== "browser_observe") throw new Error("Browser preflight returned the wrong tool result");
					preflight = next;
					if (next.observation.documentId !== cursor.documentId || next.observation.revision !== cursor.revision) {
						checked = preflightBrowserAction(call.input, next.observation);
						break;
					}
					if (
						next.observation.cursorReset ||
						next.observation.statePage?.offset !== state.length ||
						!next.observation.state
					) {
						throw new Error("Browser preflight returned an invalid continuation");
					}
					state += next.observation.state;
					if (Buffer.byteLength(state, "utf8") > MAX_BROWSER_STATE_UTF8_BYTES)
						throw new Error("Browser preflight exceeded the snapshot limit");
					checked = preflightBrowserAction(call.input, { ...next.observation, state });
				}
				const { staleReason, target } = checked;
				if (staleReason) {
					return {
						tool: "browser_act",
						details: { status: "stale", reason: staleReason, observation: preflight.observation },
					};
				}
				const confirmation = await this.requestBrowserActionConfirmation(
					sessionId,
					call.input,
					target,
					signal,
					actor,
				);
				if (confirmation === "deny") {
					throw new BrowserPermissionDeniedError("The user rejected this browser action");
				}
				if (confirmation !== "allow") {
					throw new BrowserPermissionDecisionUnavailableError(
						confirmation,
						confirmation === "cancelled"
							? "Browser permission review was cancelled"
							: "Browser permission review is unavailable",
					);
				}
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "PAGE_IN_USE") throw error;
				if (
					error instanceof BrowserPermissionDeniedError ||
					error instanceof BrowserPermissionDecisionUnavailableError
				) {
					throw error;
				}
				throw new BrowserPermissionDecisionUnavailableError(
					signal.aborted ? "cancelled" : "unavailable",
					signal.aborted ? "Browser permission review was cancelled" : "Browser permission review is unavailable",
				);
			}
		}
		return this.dispatchBrowserTool(peer, sessionId, toolCallId, call, signal, actor);
	}

	private async dispatchBrowserTool(
		peer: InteractionPeer,
		sessionId: string,
		toolCallId: string,
		call: BrowserToolCall,
		signal: AbortSignal,
		actor?: AgentHostIdentity,
	): Promise<BrowserToolResult> {
		// Provider call IDs can be compound or oversized; only the local RPC needs an opaque ID.
		const wireToolCallId = opaqueIdValidator.Check(toolCallId)
			? toolCallId
			: `browser:${createHash("sha256").update(toolCallId).digest("hex")}`;
		const request = validateServerRequest({
			jsonrpc: "2.0",
			id: this.createId(),
			method: "browser/tool",
			params: {
				serverEpoch: this.serverEpoch,
				sessionId,
				...actorFields(sessionId, actor),
				toolCallId: wireToolCallId,
				call,
			},
		}) as ServerRpcRequest<"browser/tool">;
		const result = (await peer.request(request, signal)) as ServerResult<"browser/tool">;
		validateResponseFor("server", request, { jsonrpc: "2.0", id: request.id, result });
		return result.result;
	}

	private async requestBrowserActionConfirmation(
		sessionId: string,
		input: BrowserActInput,
		target: string,
		signal: AbortSignal,
		actor?: AgentHostIdentity,
	): Promise<BrowserActionConfirmation> {
		const interactionId = this.createId();
		const outcome = await this.requestOutcome(
			sessionId,
			{
				interactionId,
				sessionId,
				...actorFields(sessionId, actor),
				title: "Allow browser action?",
				message: boundedPublicText(
					`Site: ${input.origin}\nRisk: ${input.risk}\nIntent: ${input.intent}\nTarget: ${target}`,
				),
				createdAt: new Date(this.now()).toISOString(),
				expiresAt: deadline(this.now(), this.defaultTimeoutMs),
				kind: "confirm",
				confirmLabel: "Allow once",
				cancelLabel: "Reject",
			},
			{ signal },
		);
		if (outcome.status !== "response") return outcome.status;
		if (outcome.response.kind !== "confirm") return "unavailable";
		return outcome.response.confirmed ? "allow" : "deny";
	}

	async requestProjectTrust(
		sessionId: string,
		projectPath: string,
		options: readonly ProjectTrustOption[],
	): Promise<ProjectTrustOption | undefined> {
		if (options.length === 0) return undefined;
		const interactionId = this.createId();
		const response = await this.request(sessionId, {
			interactionId,
			sessionId,
			title: "Trust this project?",
			message: "Project resources can execute code. Choose the scope for this decision.",
			createdAt: new Date(this.now()).toISOString(),
			expiresAt: deadline(this.now(), this.defaultTimeoutMs),
			kind: "project_trust",
			projectPath,
			choices: options
				.slice(0, MAX_INTERACTION_CHOICES)
				.map((option, index) => ({ id: choiceId(index), label: boundedName(option.label, `Option ${index + 1}`) })),
		});
		if (response?.kind !== "project_trust") return undefined;
		const index = Number(response.choiceId.slice("choice:".length));
		return options[index];
	}

	async requestPermissionApproval(
		sessionId: string,
		approval: PermissionApprovalRequest,
		actor?: AgentHostIdentity,
	): Promise<PermissionApprovalDecision> {
		const identity =
			actor ??
			(approval.actor
				? {
						rootSessionId: sessionId,
						actorSessionId: approval.actor.id,
						agentId: approval.actor.id,
						taskId: approval.actor.taskId,
					}
				: undefined);
		const fields = actorFields(sessionId, identity);
		if (actor && approval.actor && (actor.agentId !== approval.actor.id || actor.taskId !== approval.actor.taskId)) {
			throw new Error("Permission approval actor changed");
		}
		const operation = permissionOperation(approval);
		const actionId = approval.action.actionId;
		const actionKey = `${sessionId}\0${identity?.actorSessionId ?? sessionId}\0${identity?.taskId ?? ""}\0${actionId}`;
		if (this.pendingByAction.has(actionKey)) throw new Error("Approval was unavailable or cancelled");
		// Validate the display command before any pending state is created: an
		// oversized command must fail without ever offering an approval card.
		const command = approvalDisplayCommand(approval);
		const interactionId = this.createId();
		this.pendingByAction.set(actionKey, interactionId);
		const sessionEligible = operation.scopeComplete && approval.rememberSessionEligible === true;
		const choices: PermissionApprovalChoice[] = ["allow-once"];
		if (sessionEligible) choices.push("allow-session-exact");
		if (operation.scopeComplete && operation.rememberProjectEligible) choices.push("always-allow-exact");
		choices.push("deny-once");
		if (operation.rememberProjectEligible) choices.push("always-deny-exact");
		try {
			const response = await this.request(
				sessionId,
				{
					interactionId,
					sessionId,
					...fields,
					title: boundedName(`Approve ${approval.action.toolName}?`, "Approve tool?"),
					message: boundedPublicText(approval.reason || "This action needs approval."),
					createdAt: new Date(this.now()).toISOString(),
					expiresAt: deadline(this.now(), this.defaultTimeoutMs),
					kind: "session_permission_approval",
					requestId: interactionId,
					actionId: opaqueId(actionId, "tool"),
					toolCallId: opaqueId(actionId, "tool"),
					toolLabel: boundedName(approval.action.toolName, "tool"),
					riskLevel: approvalRiskLevel(approval),
					executionTarget: approvalExecutionTarget(approval),
					reason: boundedPublicText(approval.reason || "This action needs approval."),
					scopeComplete: operation.scopeComplete,
					...(command === undefined ? {} : { command }),
					rememberSessionEligible: approval.rememberSessionEligible === true,
					details: operation.rows,
					...priorReviewFields(approval),
					choices,
				},
				{ signal: approval.signal },
			);
			if (response?.kind !== "session_permission_approval") throw new Error("Approval was unavailable or cancelled");
			if (response.choice === "allow-once") return { decision: "allow" };
			if (response.choice === "allow-session-exact") {
				if (!sessionEligible) throw new Error("Approval returned an ineligible session choice");
				return { decision: "allow", remember: "session" };
			}
			if (response.choice === "always-allow-exact") {
				if (!operation.scopeComplete || !operation.rememberProjectEligible) {
					throw new Error("Approval returned an ineligible project choice");
				}
				return { decision: "allow", remember: "project" };
			}
			if (response.choice === "deny-once" || response.choice === "always-deny-exact") {
				if (response.choice === "always-deny-exact") {
					if (!operation.rememberProjectEligible)
						throw new Error("Approval returned an ineligible project choice");
					return { decision: "deny", remember: "project", reason: "Denied by the session owner" };
				}
				return { decision: "deny", reason: "Denied by the session owner" };
			}
			throw new Error("Approval returned an unknown choice");
		} finally {
			this.pendingByAction.delete(actionKey);
		}
	}

	async requestUserInput(
		sessionId: string,
		input: AskUserRequest,
		actor?: AgentHostIdentity,
	): Promise<AskUserResponse> {
		const interactionId = this.createId();
		const response = await this.request(
			sessionId,
			{
				interactionId,
				sessionId,
				...actorFields(sessionId, actor),
				title: "Metis has questions",
				message: "Answer each question to continue.",
				createdAt: new Date(this.now()).toISOString(),
				expiresAt: deadline(this.now(), ASK_USER_TIMEOUT_MS),
				kind: "ask_user",
				...(input.toolCallId ? { toolCallId: opaqueId(input.toolCallId, "tool") } : {}),
				questions: input.questions.map((question, questionIndex) => ({
					id: `question:${questionIndex}`,
					question: question.question,
					multiple: question.multiple,
					choices: question.options.map((option, optionIndex) => ({
						id: choiceId(optionIndex),
						label: option.label,
						...(option.description === undefined ? {} : { description: option.description }),
					})),
				})),
			},
			{ signal: input.signal, timeout: ASK_USER_TIMEOUT_MS },
		);
		if (response?.kind !== "ask_user" || response.cancelled) return { cancelled: true, answers: [] };
		const byQuestionId = new Map(response.answers.map((answer) => [answer.questionId, answer]));
		return {
			cancelled: false,
			answers: input.questions.map((_question, questionIndex) => {
				const answer = byQuestionId.get(`question:${questionIndex}`)!;
				return {
					selectedOptionIndexes: answer.choiceIds.map((id) => Number(id.slice("choice:".length))),
					...(answer.customAnswer === undefined ? {} : { customAnswer: answer.customAnswer }),
				};
			}),
		};
	}

	createExtensionUIContext(
		sessionId: string,
		publish: (event: NotificationEvent) => void,
		actor?: () => AgentHostIdentity,
	): ExtensionUIContext {
		return createDialogExtensionUIContext({
			select: async (title, options, dialogOptions) => {
				if (options.length === 0) return undefined;
				const interactionId = this.createId();
				const response = await this.request(
					sessionId,
					{
						...this.baseInteraction(sessionId, interactionId, title, "Choose an option.", dialogOptions),
						...actorFields(sessionId, actor?.()),
						kind: "select",
						choices: options.slice(0, MAX_INTERACTION_CHOICES).map((label, index) => ({
							id: choiceId(index),
							label: boundedName(label, `Option ${index + 1}`),
						})),
					},
					dialogOptions,
				);
				if (response?.kind !== "select") return undefined;
				return options[Number(response.choiceId.slice("choice:".length))];
			},
			confirm: async (title, message, dialogOptions) => {
				const interactionId = this.createId();
				const response = await this.request(
					sessionId,
					{
						...this.baseInteraction(sessionId, interactionId, title, message, dialogOptions),
						...actorFields(sessionId, actor?.()),
						kind: "confirm",
					},
					dialogOptions,
				);
				return response?.kind === "confirm" ? response.confirmed : false;
			},
			input: async (title, placeholder, dialogOptions) => {
				const interactionId = this.createId();
				const response = await this.request(
					sessionId,
					{
						...this.baseInteraction(sessionId, interactionId, title, "Enter a value.", dialogOptions),
						...actorFields(sessionId, actor?.()),
						kind: "input",
						...(placeholder === undefined ? {} : { placeholder: boundedPublicText(placeholder) }),
						secret: false,
					},
					dialogOptions,
				);
				return response?.kind === "input" ? response.value : undefined;
			},
			notify: (message, level = "info") => {
				publish({
					type: "interaction/notify",
					notificationId: this.createId(),
					sessionId,
					level,
					message: boundedPublicText(message),
					createdAt: new Date(this.now()).toISOString(),
				});
			},
		});
	}

	private baseInteraction(
		sessionId: string,
		interactionId: string,
		title: string,
		message: string,
		options: ExtensionUIDialogOptions | undefined,
	) {
		const requestedTimeout = options?.timeout ?? this.defaultTimeoutMs;
		const timeout = validTimeout(requestedTimeout) ? requestedTimeout : 1;
		return {
			interactionId,
			sessionId,
			title: boundedName(title, "Extension"),
			message: boundedPublicText(message),
			createdAt: new Date(this.now()).toISOString(),
			expiresAt: deadline(this.now(), timeout),
		};
	}

	private async request(
		sessionId: string,
		interactionValue: InteractionView,
		options?: ExtensionUIDialogOptions,
	): Promise<InteractionResponseInput | undefined> {
		const outcome = await this.requestOutcome(sessionId, interactionValue, options);
		return outcome.status === "response" ? outcome.response : undefined;
	}

	private async requestOutcome(
		sessionId: string,
		interactionValue: InteractionView,
		options?: ExtensionUIDialogOptions,
	): Promise<InteractionRequestOutcome> {
		const peer = this.owners.get(sessionId);
		if (!peer) return { status: options?.signal?.aborted ? "cancelled" : "unavailable" };
		const timeout = options?.timeout ?? this.defaultTimeoutMs;
		if (!validTimeout(timeout)) return { status: "unavailable" };
		let request: ServerRpcRequest<"interaction/request">;
		try {
			request = validateServerRequest({
				jsonrpc: "2.0",
				id: this.createId(),
				method: "interaction/request",
				params: { serverEpoch: this.serverEpoch, interaction: interactionValue },
			}) as ServerRpcRequest<"interaction/request">;
		} catch {
			return { status: "unavailable" };
		}

		const controller = new AbortController();
		const abort = () => controller.abort(options?.signal?.reason ?? new Error("Interaction cancelled"));
		if (options?.signal?.aborted) abort();
		else options?.signal?.addEventListener("abort", abort, { once: true });
		if (controller.signal.aborted) {
			options?.signal?.removeEventListener("abort", abort);
			return { status: "cancelled" };
		}
		const timer = setTimeout(() => controller.abort(new Error("Interaction timed out")), timeout);
		timer.unref?.();
		const wasPending = this.hasPending(sessionId);
		this.pending.set(interactionValue.interactionId, sessionId);
		this.pendingAborts.set(interactionValue.interactionId, controller);
		if (!wasPending) this.notifyPendingChange(sessionId, true);
		try {
			const aborted = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
			});
			const result = (await Promise.race([
				peer.request(request, controller.signal),
				aborted,
			])) as InteractionResponseInput;
			validateResponseFor("server", request, { jsonrpc: "2.0", id: request.id, result });
			return { status: "response", response: result };
		} catch {
			return { status: options?.signal?.aborted ? "cancelled" : "unavailable" };
		} finally {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", abort);
			this.pendingAborts.delete(interactionValue.interactionId);
			const hadPending = this.hasPending(sessionId);
			this.pending.delete(interactionValue.interactionId);
			const pending = this.hasPending(sessionId);
			if (hadPending !== pending) this.notifyPendingChange(sessionId, pending);
		}
	}

	private abortPending(sessionId: string): void {
		for (const [interactionId, pendingSessionId] of this.pending) {
			if (pendingSessionId === sessionId) this.pendingAborts.get(interactionId)?.abort();
		}
	}

	private notifyPendingChange(sessionId: string, pending: boolean): void {
		try {
			this.onPendingChange?.(sessionId, pending);
		} catch {
			// UI status projection cannot break an interaction request.
		}
	}
}
