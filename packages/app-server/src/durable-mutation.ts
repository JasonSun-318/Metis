import {
	identifyRuntimeRequest,
	RequestIdReusedError,
	type RuntimeRequestIdentity,
	reduceRuntimeJournal,
	type SessionManager,
} from "@metis/coding-agent";
import { AppServerError } from "./session-runtime-host.ts";

const RESULT_ENTRY_TYPE = "metis.app-server.mutation-result.v1";
const MAX_RESULT_BYTES = 1024 * 1024;

export interface DurableSessionMutation {
	readonly method: "session/create" | "session/close" | "session/archive" | "session/unarchive";
	readonly kind: "session_create" | "session_close" | "session_archive" | "session_unarchive";
	readonly requestId: string;
	readonly params: unknown;
}

export interface PreparedSessionMutation {
	readonly state: "accepted" | "completed";
	readonly result?: unknown;
}

function identity(input: DurableSessionMutation): RuntimeRequestIdentity {
	return identifyRuntimeRequest(input.method, input.requestId, input.params);
}

function storedResult(manager: SessionManager, request: RuntimeRequestIdentity): unknown | undefined {
	let result: unknown;
	for (const raw of manager.getDurableJournalSnapshot()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw as unknown as Record<string, unknown>;
		if (entry.type !== "custom" || entry.customType !== RESULT_ENTRY_TYPE) {
			continue;
		}
		if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) {
			throw new AppServerError("SESSION_CORRUPT");
		}
		const data = entry.data as Record<string, unknown>;
		if (data.requestId !== request.requestId) continue;
		if (data.requestHash !== request.requestHash) throw new RequestIdReusedError(request.requestId);
		if (!Object.hasOwn(data, "result")) throw new AppServerError("SESSION_CORRUPT");
		if (result !== undefined) throw new AppServerError("SESSION_CORRUPT");
		result = data.result;
	}
	return result;
}

export function prepareSessionMutation(
	manager: SessionManager,
	input: DurableSessionMutation,
): PreparedSessionMutation {
	const request = identity(input);
	const reduced = reduceRuntimeJournal(manager.getDurableJournalSnapshot());
	const operation = reduced.operations.find((candidate) => candidate.requestId === request.requestId);
	if (operation && operation.requestHash !== request.requestHash) throw new RequestIdReusedError(request.requestId);
	if (operation && operation.kind !== input.kind) throw new RequestIdReusedError(request.requestId);
	if (operation?.state === "interrupted") {
		throw new AppServerError("OPERATION_FAILED", { requestId: request.requestId });
	}

	const result = storedResult(manager, request);
	if (operation?.state === "completed" && result === undefined) throw new AppServerError("SESSION_CORRUPT");
	if (result !== undefined && operation === undefined) throw new AppServerError("SESSION_CORRUPT");
	if (result !== undefined && operation?.state === "active") {
		manager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: request.operationId,
			requestId: request.requestId,
			requestHash: request.requestHash,
			kind: input.kind,
			state: "completed",
		});
	}
	if (operation === undefined) {
		manager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: request.operationId,
			requestId: request.requestId,
			requestHash: request.requestHash,
			kind: input.kind,
			state: "accepted",
		});
	}
	return result === undefined ? { state: "accepted" } : { state: "completed", result };
}

export function completeSessionMutation(
	manager: SessionManager,
	input: DurableSessionMutation,
	result: unknown,
): unknown {
	const prepared = prepareSessionMutation(manager, input);
	if (prepared.state === "completed") return prepared.result;
	let serialized: string;
	try {
		serialized = JSON.stringify(result);
	} catch {
		throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
	}
	if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
		throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
	}
	const request = identity(input);
	manager.appendCustomEntry(RESULT_ENTRY_TYPE, {
		requestId: request.requestId,
		requestHash: request.requestHash,
		result,
	});
	manager.appendRuntimeControl({
		type: "runtime_operation",
		operationId: request.operationId,
		requestId: request.requestId,
		requestHash: request.requestHash,
		kind: input.kind,
		state: "completed",
	});
	return result;
}
