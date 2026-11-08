import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import {
	type DeliverFileDetails,
	DeliverFileParams,
	normalizeDeliverFileInput,
	parseDeliverFileDetails,
} from "./deliver-file.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import { type GeneratedImageDetails, parseImageGenerationDetails } from "./image-generation/types.ts";
import {
	copySessionDeliveredFiles,
	getOwnedSessionWorkDirs,
	MAX_SESSION_ATTACHMENT_BYTES,
	MAX_SESSION_DELIVERED_FILES,
	removeUnreferencedSessionDeliveredFiles,
	resolveDeliveredFilePath,
} from "./session-attachments.ts";
import type { SessionManager } from "./session-manager.ts";
import { fileReadPermissionClaim, permissionDescriptor } from "./tool-permission-adapter.ts";

type DeliveredArtifactsSession = Pick<SessionManager, "getBranch" | "getCwd" | "getJournalMetadata" | "getSessionId">;

export type DeliveredArtifactAvailability = "available" | "unavailable";

export interface SessionDeliveredArtifact extends DeliverFileDetails {
	readonly availability: DeliveredArtifactAvailability;
}

export interface ResolvedSessionDeliveredArtifact {
	readonly artifact: SessionDeliveredArtifact & { readonly availability: "available" };
	readonly path: string;
}

function artifactView<TAvailability extends DeliveredArtifactAvailability>(
	details: DeliverFileDetails,
	availability: TAvailability,
	byteLength = details.byteLength,
): SessionDeliveredArtifact & { readonly availability: TAvailability } {
	const { fileId, sourcePath, name, message, deliveredAt } = details;
	return {
		fileId,
		name,
		byteLength,
		deliveredAt,
		availability,
		...(sourcePath === undefined ? {} : { sourcePath }),
		...(message === undefined ? {} : { message }),
	};
}

function deliveryDetails(entry: unknown): DeliverFileDetails[] {
	if (typeof entry !== "object" || entry === null) return [];
	const record = entry as Record<string, unknown>;
	const message = record.type === "message" ? record.message : entry;
	if (typeof message !== "object" || message === null) return [];
	const result = message as Record<string, unknown>;
	if (result.role !== "toolResult" || result.isError !== false) return [];
	if (result.toolName === "image_generate") return parseImageGenerationDetails(result.details)?.images ?? [];
	if (result.toolName !== "deliver_file") return [];
	const details = parseDeliverFileDetails(result.details);
	return details ? [details] : [];
}

function deliveries(entries: readonly unknown[]): DeliverFileDetails[] {
	return entries.flatMap(deliveryDetails);
}

/** Resolve a journal-authorized delivery, preserving legacy copies and reading current live-file metadata. */
export function resolveSessionDeliveredArtifact(
	agentDir: string,
	sessionId: string,
	details: DeliverFileDetails,
): ResolvedSessionDeliveredArtifact | undefined {
	const path = details.sourcePath ?? resolveDeliveredFilePath(agentDir, sessionId, details.fileId, details.name);
	if (!path) return undefined;
	try {
		// Reject path redirection after delivery; ordinary in-place or atomic file edits remain valid.
		if (details.sourcePath && realpathSync(path) !== path) return undefined;
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SESSION_ATTACHMENT_BYTES) return undefined;
		if (!details.sourcePath && metadata.size !== details.byteLength) return undefined;
		return { path, artifact: artifactView(details, "available", metadata.size) };
	} catch {
		return undefined;
	}
}

/** Session-level consistency boundary for delivered-file history and physical availability. */
export class SessionDeliveredArtifacts {
	private readonly agentDir: string;
	private readonly sessionManager: DeliveredArtifactsSession;
	private readonly pendingImages = new Map<string, GeneratedImageDetails[]>();

	constructor(agentDir: string, sessionManager: DeliveredArtifactsSession) {
		this.agentDir = agentDir;
		this.sessionManager = sessionManager;
		removeUnreferencedSessionDeliveredFiles(
			agentDir,
			sessionManager.getSessionId(),
			deliveries(sessionManager.getJournalMetadata()).filter((file) => !file.sourcePath),
		);
	}

	createToolDefinition(): ToolDefinition<typeof DeliverFileParams, DeliverFileDetails> {
		return {
			name: "deliver_file",
			label: "Deliver file",
			description:
				"Show an existing file in the conversation using its real path; no copy is made. After updating a file, send the same path again: all its cards open the latest contents. Save final files in the user-requested location or workspace, not METIS_WORK_DIR (which is deleted after the run). Existing file-read permissions still apply.",
			promptSnippet: "Send a finished file to the user in the Desktop app",
			parameters: DeliverFileParams,
			permission: permissionDescriptor(({ path }, context) => fileReadPermissionClaim(path, context)),
			executionMode: "sequential",
			execute: async (_toolCallId, input, signal) => {
				if (signal?.aborted) throw new Error("Deliver file was aborted");
				const normalized = normalizeDeliverFileInput(input);
				const sourcePath = realpathSync(resolvePath(normalized.path, this.sessionManager.getCwd(), { trim: true }));
				const metadata = lstatSync(sourcePath);
				if (!metadata.isFile() || metadata.size === 0)
					throw new Error("Deliverable must be a non-empty regular file");
				if (metadata.size > MAX_SESSION_ATTACHMENT_BYTES) throw new Error("Deliverable file exceeds 128 MiB");
				for (const workDir of getOwnedSessionWorkDirs(this.agentDir, this.sessionManager.getSessionId())) {
					const inside = relative(workDir, sourcePath);
					if (inside === "" || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))) {
						throw new Error(
							"Save the final file in the workspace or user-requested location before delivering it. METIS_WORK_DIR is temporary and is deleted after this run.",
						);
					}
				}
				const existing = this.list();
				const previous = existing.find((file) => file.sourcePath === sourcePath);
				if (!previous && existing.length >= MAX_SESSION_DELIVERED_FILES) {
					throw new Error(`A session can deliver at most ${MAX_SESSION_DELIVERED_FILES} distinct files`);
				}
				const details: DeliverFileDetails = {
					fileId: previous?.fileId ?? randomUUID().replaceAll("-", "").slice(0, 16),
					sourcePath,
					name: normalized.name ?? basename(sourcePath),
					byteLength: metadata.size,
					deliveredAt: new Date().toISOString(),
					...(normalized.message === undefined ? {} : { message: normalized.message }),
				};
				if (signal?.aborted) throw new Error("Deliver file was aborted");
				return {
					content: [
						{
							type: "text",
							text: `Delivered "${details.name}" from ${sourcePath}. The conversation card opens this original file and reflects subsequent edits.`,
						},
					],
					details,
				};
			},
		};
	}

	list(): SessionDeliveredArtifact[] {
		const files = new Map<string, DeliverFileDetails>();
		for (const artifact of deliveries(this.sessionManager.getBranch())) files.set(artifact.fileId, artifact);
		for (const images of this.pendingImages.values()) for (const image of images) files.set(image.fileId, image);
		return [...files.values()]
			.slice(-MAX_SESSION_DELIVERED_FILES)
			.map(
				(artifact) =>
					resolveSessionDeliveredArtifact(this.agentDir, this.sessionManager.getSessionId(), artifact)?.artifact ??
					artifactView(artifact, "unavailable"),
			);
	}

	resolve(fileId: string): ResolvedSessionDeliveredArtifact | undefined {
		const branch = [...deliveries(this.sessionManager.getBranch()), ...[...this.pendingImages.values()].flat()];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const details = branch[index]!;
			if (details.fileId === fileId)
				return resolveSessionDeliveredArtifact(this.agentDir, this.sessionManager.getSessionId(), details);
		}
		return undefined;
	}

	/** Authorize already-written outputs while the same tool call is still producing further images. */
	stageGeneratedImage(toolCallId: string, image: GeneratedImageDetails): void {
		const images = this.pendingImages.get(toolCallId) ?? [];
		images.push(image);
		this.pendingImages.set(toolCallId, images);
	}

	/** Called only after the final tool result has been durably appended. */
	finishGeneration(toolCallId: string): void {
		this.pendingImages.delete(toolCallId);
	}

	getGeneratedImage(fileId: string): GeneratedImageDetails | undefined {
		const candidates = [...deliveries(this.sessionManager.getBranch()), ...[...this.pendingImages.values()].flat()];
		const image = candidates.reverse().find((candidate) => candidate.fileId === fileId && "mediaType" in candidate);
		return image as GeneratedImageDetails | undefined;
	}

	copyTo(target: SessionManager): void {
		// Generated images and legacy deliveries own copies; live references travel in the forked journal.
		copySessionDeliveredFiles({
			agentDir: this.agentDir,
			sourceSessionId: this.sessionManager.getSessionId(),
			targetSessionId: target.getSessionId(),
			artifacts: deliveries(target.getBranch()).filter((file) => !file.sourcePath),
		});
	}
}
