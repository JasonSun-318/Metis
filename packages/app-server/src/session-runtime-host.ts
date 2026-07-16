import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	ItemView,
	RpcErrorName,
	SessionSnapshot,
	SessionSummary,
} from "@arcmind/app-protocol";
import type { DurableSessionMutation, PreparedSessionMutation } from "./durable-mutation.ts";

export interface SessionRef {
	readonly path: string;
	readonly relativePath: string;
	readonly summary: SessionSummary;
}

export type SessionEventListener = (event: DomainEvent) => void;

/** One opened runtime hidden behind app-server operations and projections. */
export interface OpenedSessionRuntime {
	readonly sessionId: string;
	isActive(): boolean;
	hasPendingInteractions(): boolean;
	getSummary(): SessionSummary;
	readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">>;
	snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot>;
	startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">>;
	steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">>;
	interrupt(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">>;
	prepareMutation(input: DurableSessionMutation): Promise<PreparedSessionMutation>;
	subscribe(listener: SessionEventListener): () => void;
	close(): Promise<void>;
}

/** Factory seam used by the registry; production and tests provide different hosts. */
export interface SessionRuntimeHost {
	open(ref: SessionRef): Promise<OpenedSessionRuntime>;
}

export class AppServerError extends Error {
	readonly code: RpcErrorName;
	readonly context: {
		requestId?: string;
		sessionId?: string;
		operationId?: string;
		interactionId?: string;
	};

	constructor(
		code: RpcErrorName,
		context: {
			requestId?: string;
			sessionId?: string;
			operationId?: string;
			interactionId?: string;
		} = {},
	) {
		super(code);
		this.name = "AppServerError";
		this.code = code;
		this.context = context;
	}
}

export function emptyItemPage(): { items: ItemView[]; nextBeforeItemId: null } {
	return { items: [], nextBeforeItemId: null };
}
