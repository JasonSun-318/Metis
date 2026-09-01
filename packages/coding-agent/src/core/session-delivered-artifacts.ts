import { lstatSync, rmSync } from "node:fs";
import type { ToolResultMessage } from "@metis/ai";
import {
	type DeliverFileDetails,
	DeliverFileParams,
	normalizeDeliverFileInput,
	parseDeliverFileDetails,
} from "./deliver-file.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import {
	copySessionDeliveredFiles,
	MAX_SESSION_DELIVERED_FILES,
	removeUnreferencedSessionDeliveredFiles,
	resolveDeliveredFilePath,
	type StagedDeliveredFile,
	stageDeliveredFile,
} from "./session-attachments.ts";
import type { SessionManager } from "./session-manager.ts";
import { fileReadPermissionClaim, permissionClaim, permissionDescriptor } from "./tool-permission-adapter.ts";

type DeliveredArtifactsSession = Pick<
	SessionManager,
	"getAdditionalDirectories" | "getBranch" | "getCwd" | "getDurableJournalSnapshot" | "getSessionId"
>;

export type DeliveredArtifactAvailability = "available" | "unavailable";

export interface SessionDeliveredArtifact extends DeliverFileDetails {
	readonly availability: DeliveredArtifactAvailability;
}

export interface ResolvedSessionDeliveredArtifact {
	readonly artifact: SessionDeliveredArtifact & { readonly availability: "available" };
	readonly path: string;
}

function deliveryDetails(entry: unknown): DeliverFileDetails | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	const message = record.type === "message" ? record.message : entry;
	if (typeof message !== "object" || message === null) return undefined;
	const result = message as Record<string, unknown>;
	if (result.role !== "toolResult" || result.toolName !== "deliver_file" || result.isError !== false) return undefined;
	return parseDeliverFileDetails(result.details);
}

function deliveries(entries: readonly unknown[]): DeliverFileDetails[] {
	return entries.flatMap((entry) => {
		const details = deliveryDetails(entry);
		return details ? [details] : [];
	});
}

/** Session-level consistency boundary for delivered-file history and physical availability. */
export class SessionDeliveredArtifacts {
	private readonly pending = new Map<string, StagedDeliveredFile>();
	private readonly agentDir: string;
	private readonly sessionManager: DeliveredArtifactsSession;

	constructor(agentDir: string, sessionManager: DeliveredArtifactsSession) {
		this.agentDir = agentDir;
		this.sessionManager = sessionManager;
		removeUnreferencedSessionDeliveredFiles(
			agentDir,
			sessionManager.getSessionId(),
			deliveries(sessionManager.getDurableJournalSnapshot()),
		);
	}

	createToolDefinition(): ToolDefinition<typeof DeliverFileParams, DeliverFileDetails> {
		return {
			name: "deliver_file",
			label: "Deliver file",
			description:
				"Push a finished file to the user in the Desktop app so they can open or locate it. Use after creating or updating a deliverable the user should receive. The file must already exist on disk and stay within the current workspace, Metis attachment directory, or session work directory.",
			promptSnippet: "Send a finished file to the user in the Desktop app",
			parameters: DeliverFileParams,
			permission: permissionDescriptor(({ path }, context) => {
				const read = fileReadPermissionClaim(path, context);
				return permissionClaim({
					readPaths: read.readPaths,
					effects: [...read.effects, "external-side-effect"],
				});
			}),
			executionMode: "sequential",
			execute: async (toolCallId, input, signal) => {
				if (signal?.aborted) throw new Error("Deliver file was aborted");
				if (this.pending.has(toolCallId)) throw new Error(`Deliver file call is already pending: ${toolCallId}`);
				const normalized = normalizeDeliverFileInput(input);
				const staged = stageDeliveredFile({
					agentDir: this.agentDir,
					sessionId: this.sessionManager.getSessionId(),
					cwd: this.sessionManager.getCwd(),
					additionalDirectories: this.sessionManager.getAdditionalDirectories(),
					sourcePath: normalized.path,
					name: normalized.name,
					activeDeliveredFileCount: deliveries(this.sessionManager.getBranch()).length,
				});
				this.pending.set(toolCallId, staged);
				try {
					if (signal?.aborted) throw new Error("Deliver file was aborted");
					const details: DeliverFileDetails = {
						fileId: staged.fileId,
						name: staged.name,
						byteLength: staged.byteLength,
						deliveredAt: new Date().toISOString(),
						...(normalized.message === undefined ? {} : { message: normalized.message }),
					};
					const lines = [
						`Delivered "${staged.name}" to the user (${staged.byteLength} bytes).`,
						normalized.message ? `Message: ${normalized.message}` : undefined,
						"The user can open the file from the inline delivery card in the chat transcript.",
					].filter((line): line is string => line !== undefined);
					return { content: [{ type: "text", text: lines.join("\n") }], details };
				} catch (error) {
					this.rollback(toolCallId);
					throw error;
				}
			},
		};
	}

	list(): SessionDeliveredArtifact[] {
		return deliveries(this.sessionManager.getBranch())
			.slice(-MAX_SESSION_DELIVERED_FILES)
			.map((artifact) => ({
				...artifact,
				availability: this.resolveDetails(artifact) ? "available" : "unavailable",
			}));
	}

	resolve(fileId: string): ResolvedSessionDeliveredArtifact | undefined {
		const branch = deliveries(this.sessionManager.getBranch());
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const details = branch[index]!;
			if (details.fileId === fileId) return this.resolveDetails(details);
		}
		return undefined;
	}

	private resolveDetails(details: DeliverFileDetails): ResolvedSessionDeliveredArtifact | undefined {
		const path = resolveDeliveredFilePath(
			this.agentDir,
			this.sessionManager.getSessionId(),
			details.fileId,
			details.name,
		);
		if (!path) return undefined;
		try {
			if (lstatSync(path).size !== details.byteLength) return undefined;
		} catch {
			return undefined;
		}
		return { artifact: { ...details, availability: "available" }, path };
	}

	commitToolResult(message: ToolResultMessage): void {
		if (message.toolName !== "deliver_file") return;
		const staged = this.pending.get(message.toolCallId);
		if (!staged) return;
		const details = message.isError ? undefined : parseDeliverFileDetails(message.details);
		if (
			details?.fileId === staged.fileId &&
			details.name === staged.name &&
			details.byteLength === staged.byteLength
		) {
			this.pending.delete(message.toolCallId);
			return;
		}
		this.rollback(message.toolCallId);
	}

	rollback(toolCallId: string): void {
		const staged = this.pending.get(toolCallId);
		if (!staged) return;
		this.pending.delete(toolCallId);
		try {
			rmSync(staged.path, { force: true });
		} catch {
			// Reconciliation retries cleanup when this session is next opened.
		}
	}

	rollbackAll(): void {
		for (const toolCallId of [...this.pending.keys()]) this.rollback(toolCallId);
	}

	copyTo(target: SessionManager): void {
		try {
			copySessionDeliveredFiles({
				agentDir: this.agentDir,
				sourceSessionId: this.sessionManager.getSessionId(),
				targetSessionId: target.getSessionId(),
				artifacts: deliveries(target.getBranch()),
			});
		} catch {
			// Fork history remains usable when one or all physical files cannot be copied.
		}
	}
}
