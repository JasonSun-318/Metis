import { type ClientParams, type ClientResult, MAX_READ_IMAGE_DATA_UTF8_BYTES } from "@metis/app-protocol";
import {
	AgentStore,
	parseDeliverFileDetails,
	resolveSessionDeliveredArtifact,
	SessionManager,
} from "@metis/coding-agent/host";
import { openDeliveredFile } from "./open-delivered-file.ts";
import { readDeliveredFile } from "./read-delivered-file.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";

/** Validate the root and descendant from immutable snapshots; never open a writer or model runtime. */
function childSnapshot(ref: SessionRef, agentDir: string, input: { sessionId: string; rootSessionId?: string }) {
	try {
		if (input.rootSessionId !== ref.summary.sessionId || input.sessionId === input.rootSessionId)
			throw new Error("Invalid child target");
		const root = SessionManager.openReadOnly(ref.path);
		const rootHeader = root.getHeader();
		if (rootHeader?.id !== ref.summary.sessionId || rootHeader.agent || rootHeader.scheduled)
			throw new Error("Invalid root");
		const store = new AgentStore(root, agentDir);
		const record = store.load(input.sessionId);
		const child = SessionManager.openReadOnly(record.path);
		const header = child.getHeader();
		if (
			header?.id !== input.sessionId ||
			header.agent?.rootSessionId !== rootHeader.id ||
			header.agent.agentId !== input.sessionId
		)
			throw new Error("Child identity changed");
		return child;
	} catch {
		throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
	}
}

export async function readAgentImage(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"session/readImage">,
): Promise<ClientResult<"session/readImage">> {
	const child = childSnapshot(ref, agentDir, input);
	try {
		const [image] = child.resolveDurableImageRefs([
			{ type: "image_ref", hash: input.image.hash, mimeType: input.image.mediaType, size: input.image.byteLength },
		]);
		if (!image || Buffer.byteLength(image.data, "utf8") > MAX_READ_IMAGE_DATA_UTF8_BYTES)
			throw new Error("Image unavailable");
		return { data: image.data, mediaType: input.image.mediaType };
	} catch {
		throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
	}
}

function resolveAgentDelivery(ref: SessionRef, agentDir: string, input: ClientParams<"session/readDeliveredFile">) {
	const child = childSnapshot(ref, agentDir, input);
	for (const entry of [...child.getBranch()].reverse()) {
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== "deliver_file" ||
			entry.message.isError !== false
		)
			continue;
		const details = parseDeliverFileDetails(entry.message.details);
		if (!details || details.fileId !== input.fileId) continue;
		const resolved = resolveSessionDeliveredArtifact(agentDir, input.sessionId, details);
		if (resolved) return resolved;
		break;
	}
	throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
}

export async function readAgentDeliveredFile(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"session/readDeliveredFile">,
): Promise<ClientResult<"session/readDeliveredFile">> {
	const resolved = resolveAgentDelivery(ref, agentDir, input);
	try {
		return await readDeliveredFile(resolved, input.metadataOnly);
	} catch {
		throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId });
	}
}

export async function openAgentDeliveredFile(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"session/openDeliveredFile">,
	open = openDeliveredFile,
): Promise<ClientResult<"session/openDeliveredFile">> {
	const resolved = resolveAgentDelivery(ref, agentDir, input);
	try {
		await open({ path: resolved.path, action: input.action });
		return {};
	} catch {
		throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId });
	}
}
