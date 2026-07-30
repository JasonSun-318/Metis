import {
	assertEnvelopeByteLimit,
	assertSchema,
	type ClientParams,
	type ClientRequestMethod,
	type ClientResult,
	compileSchema,
	type InteractionResponseInput,
	InteractionResultSchema,
	type ServerRpcNotification,
	type ServerRpcRequest,
	UuidSchema,
	validateClientRequest,
	validateServerNotification,
	validateServerRequest,
} from "@arcmind/app-protocol";

export type SupervisorState = "stopped" | "starting" | "ready" | "restarting" | "failed" | "shuttingDown";

export interface SupervisorView {
	readonly state: SupervisorState;
	readonly serverEpoch: string | null;
	readonly restartAttempt: number;
	readonly failure: string | null;
}

export type DesktopApiEvent =
	| { readonly type: "app-server"; readonly envelope: ServerRpcRequest | ServerRpcNotification }
	| { readonly type: "interaction-cancelled"; readonly interactionId: string }
	| { readonly type: "supervisor"; readonly view: SupervisorView };

export const DESKTOP_IPC_CHANNELS = {
	listSessions: "arcmind:list-sessions",
	listSkills: "arcmind:list-skills",
	previewProjectDelete: "arcmind:preview-project-delete",
	deleteProject: "arcmind:delete-project",
	createSession: "arcmind:create-session",
	renameSession: "arcmind:rename-session",
	deleteSession: "arcmind:delete-session",
	openSession: "arcmind:open-session",
	readItems: "arcmind:read-items",
	readSubagentItems: "arcmind:read-subagent-items",
	setThinkingSelection: "arcmind:set-thinking-selection",
	setPermissionMode: "arcmind:set-permission-mode",
	setModel: "arcmind:set-model",
	startTurn: "arcmind:start-turn",
	steerTurn: "arcmind:steer-turn",
	interruptTurn: "arcmind:interrupt-turn",
	respondToInteraction: "arcmind:respond-to-interaction",
	selectProjectFolder: "arcmind:select-project-folder",
	selectAttachmentFiles: "arcmind:select-attachment-files",
	getServerState: "arcmind:get-server-state",
	retryServer: "arcmind:retry-server",
	subscribe: "arcmind:subscribe",
} as const;

export const DESKTOP_EVENT_CHANNEL = "arcmind:event";

export interface DesktopAttachmentSelection {
	readonly path: string;
	readonly name: string;
}

export type DesktopRpcOutcome<Result> =
	| { readonly ok: true; readonly result: Result }
	| { readonly ok: false; readonly error: { readonly code: number; readonly message: string } };

export interface ArcMindDesktopApi {
	listSessions(input?: ClientParams<"session/list">): Promise<ClientResult<"session/list">>;
	listSkills(input: ClientParams<"skill/list">): Promise<ClientResult<"skill/list">>;
	previewProjectDelete(
		input: ClientParams<"project/deletePreview">,
	): Promise<DesktopRpcOutcome<ClientResult<"project/deletePreview">>>;
	deleteProject(input: ClientParams<"project/delete">): Promise<DesktopRpcOutcome<ClientResult<"project/delete">>>;
	createSession(input: ClientParams<"session/create">): Promise<ClientResult<"session/create">>;
	renameSession(input: ClientParams<"session/rename">): Promise<ClientResult<"session/rename">>;
	deleteSession(input: ClientParams<"session/delete">): Promise<ClientResult<"session/delete">>;
	openSession(input: ClientParams<"session/open">): Promise<ClientResult<"session/subscribe">["snapshot"]>;
	readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">>;
	readSubagentItems(input: ClientParams<"subagent/readItems">): Promise<ClientResult<"subagent/readItems">>;
	setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">>;
	setPermissionMode(
		input: ClientParams<"session/setPermissionMode">,
	): Promise<ClientResult<"session/setPermissionMode">>;
	setModel(input: ClientParams<"session/setModel">): Promise<ClientResult<"session/setModel">>;
	startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">>;
	steerTurn(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">>;
	interruptTurn(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">>;
	respondToInteraction(input: InteractionResponseInput): Promise<void>;
	selectProjectFolder(): Promise<string | null>;
	selectAttachmentFiles(): Promise<DesktopAttachmentSelection[]>;
	subscribe(listener: (event: DesktopApiEvent) => void): () => void;
	getServerState(): Promise<SupervisorView>;
	retryServer(): Promise<void>;
}

const interactionResponseValidator = compileSchema(InteractionResultSchema);
const interactionIdValidator = compileSchema(UuidSchema);

export function validateDesktopClientParams<Method extends Exclude<ClientRequestMethod, "initialize">>(
	method: Method,
	value: unknown,
): ClientParams<Method> {
	const request = validateClientRequest({ jsonrpc: "2.0", id: "desktop-boundary", method, params: value });
	return request.params as ClientParams<Method>;
}

export function validateInteractionResponseInput(value: unknown): InteractionResponseInput {
	assertEnvelopeByteLimit(value);
	assertSchema(interactionResponseValidator, value, "invalid_params", "interaction response");
	return value as InteractionResponseInput;
}

function isSupervisorView(value: unknown): value is SupervisorView {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return (
		keys.length === 4 &&
		keys.every((key) => ["state", "serverEpoch", "restartAttempt", "failure"].includes(key)) &&
		["stopped", "starting", "ready", "restarting", "failed", "shuttingDown"].includes(String(record.state)) &&
		(record.serverEpoch === null || typeof record.serverEpoch === "string") &&
		Number.isInteger(record.restartAttempt) &&
		Number(record.restartAttempt) >= 0 &&
		(record.failure === null || typeof record.failure === "string")
	);
}

export function validateDesktopApiEvent(value: unknown): DesktopApiEvent {
	assertEnvelopeByteLimit(value);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Invalid desktop event");
	const event = value as Record<string, unknown>;
	if (event.type === "app-server" && Object.keys(event).length === 2) {
		const envelope = event.envelope as Record<string, unknown>;
		return {
			type: "app-server",
			envelope: Object.hasOwn(envelope, "id")
				? validateServerRequest(envelope)
				: validateServerNotification(envelope),
		};
	}
	if (event.type === "supervisor" && Object.keys(event).length === 2 && isSupervisorView(event.view)) {
		return { type: "supervisor", view: event.view };
	}
	if (event.type === "interaction-cancelled" && Object.keys(event).length === 2) {
		assertSchema(interactionIdValidator, event.interactionId, "invalid_params", "interaction id");
		return { type: "interaction-cancelled", interactionId: event.interactionId as string };
	}
	throw new TypeError("Invalid desktop event");
}
