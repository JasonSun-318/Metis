import { randomUUID } from "node:crypto";
import {
	type DomainEvent,
	type InteractionResponseInput,
	type InteractionView,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PUBLIC_TEXT_UTF8_BYTES,
	type ServerRpcRequest,
	validateResponseFor,
	validateServerRequest,
} from "@arcmind/app-protocol";
import {
	createDialogExtensionUIContext,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	formatPermissionApproval,
	type PermissionApprovalDecision,
	type PermissionApprovalRequest,
	type ProjectTrustOption,
} from "@arcmind/coding-agent";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface InteractionPeer {
	request(request: ServerRpcRequest, signal: AbortSignal): Promise<InteractionResponseInput>;
}

export interface InteractionBrokerOptions {
	readonly serverEpoch: string;
	readonly defaultTimeoutMs?: number;
	readonly now?: () => number;
	readonly createId?: () => string;
}

type NotificationEvent = Extract<DomainEvent, { type: "interaction/notify" }>;

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

function validTimeout(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

/** Routes typed interaction requests to the client that owns a session. */
export class InteractionBroker {
	private readonly serverEpoch: string;
	private readonly defaultTimeoutMs: number;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly owners = new Map<string, InteractionPeer>();
	private readonly pending = new Map<string, string>();

	constructor(options: InteractionBrokerOptions) {
		if (!validTimeout(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)) {
			throw new TypeError("Interaction timeout must be a positive safe integer");
		}
		this.serverEpoch = options.serverEpoch;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
	}

	assign(sessionId: string, peer: InteractionPeer): void {
		this.owners.set(sessionId, peer);
	}

	release(sessionId: string, peer: InteractionPeer): void {
		if (this.owners.get(sessionId) === peer) this.owners.delete(sessionId);
	}

	releasePeer(peer: InteractionPeer): void {
		for (const [sessionId, owner] of this.owners) {
			if (owner === peer) this.owners.delete(sessionId);
		}
	}

	hasPending(sessionId: string): boolean {
		return [...this.pending.values()].some((pendingSessionId) => pendingSessionId === sessionId);
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
	): Promise<PermissionApprovalDecision> {
		const view = formatPermissionApproval(approval);
		const message = `${view.summary}\n${view.details}`;
		if (Buffer.byteLength(message, "utf8") > MAX_PUBLIC_TEXT_UTF8_BYTES) {
			throw new TypeError("Permission action exceeds the App Server protocol limit");
		}
		const interactionId = this.createId();
		const response = await this.request(
			sessionId,
			{
				interactionId,
				sessionId,
				title: view.title,
				message,
				createdAt: new Date(this.now()).toISOString(),
				expiresAt: deadline(this.now(), this.defaultTimeoutMs),
				kind: "select",
				choices: [
					{ id: choiceId(0), label: "Allow once" },
					{ id: choiceId(1), label: "Deny" },
				],
			},
			{ signal: approval.signal },
		);
		if (response?.kind !== "select") throw new Error("Approval was unavailable or cancelled");
		if (response.choiceId === choiceId(0)) return { decision: "allow" };
		if (response.choiceId === choiceId(1)) return { decision: "deny", reason: "Denied by the session owner" };
		throw new Error("Approval returned an unknown choice");
	}

	createExtensionUIContext(sessionId: string, publish: (event: NotificationEvent) => void): ExtensionUIContext {
		return createDialogExtensionUIContext({
			select: async (title, options, dialogOptions) => {
				if (options.length === 0) return undefined;
				const interactionId = this.createId();
				const response = await this.request(
					sessionId,
					{
						...this.baseInteraction(sessionId, interactionId, title, "Choose an option.", dialogOptions),
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
		const peer = this.owners.get(sessionId);
		if (!peer) return undefined;
		const timeout = options?.timeout ?? this.defaultTimeoutMs;
		if (!validTimeout(timeout)) return undefined;
		let request: ServerRpcRequest;
		try {
			request = validateServerRequest({
				jsonrpc: "2.0",
				id: this.createId(),
				method: "interaction/request",
				params: { serverEpoch: this.serverEpoch, interaction: interactionValue },
			});
		} catch {
			return undefined;
		}

		const controller = new AbortController();
		const abort = () => controller.abort(options?.signal?.reason ?? new Error("Interaction cancelled"));
		if (options?.signal?.aborted) abort();
		else options?.signal?.addEventListener("abort", abort, { once: true });
		if (controller.signal.aborted) {
			options?.signal?.removeEventListener("abort", abort);
			return undefined;
		}
		const timer = setTimeout(() => controller.abort(new Error("Interaction timed out")), timeout);
		timer.unref?.();
		this.pending.set(interactionValue.interactionId, sessionId);
		try {
			const aborted = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
			});
			const result = await Promise.race([peer.request(request, controller.signal), aborted]);
			validateResponseFor("server", request, { jsonrpc: "2.0", id: request.id, result });
			return result;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", abort);
			this.pending.delete(interactionValue.interactionId);
		}
	}
}
