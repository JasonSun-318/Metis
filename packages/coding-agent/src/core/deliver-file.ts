import { type Static, Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";
import { stageDeliveredFile } from "./session-attachments.ts";

export const MAX_DELIVER_FILE_MESSAGE_LENGTH = 512;

export const DeliverFileParams = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 4096 }),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DELIVER_FILE_MESSAGE_LENGTH })),
	},
	{ additionalProperties: false },
);

export type DeliverFileInput = Static<typeof DeliverFileParams>;

export interface DeliverFileContext {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionId: string;
	readonly additionalDirectories?: readonly string[];
	readonly activeDeliveredFileCount?: number;
}

export interface DeliverFileDetails {
	readonly fileId: string;
	readonly name: string;
	readonly byteLength: number;
	readonly message?: string;
	readonly deliveredAt: string;
}

export type GetDeliverFileContext = () => DeliverFileContext;

const DELIVERED_FILE_ID_PATTERN = /^[a-f0-9]{16}$/iu;

export function parseDeliverFileDetails(details: unknown): DeliverFileDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const record = details as Record<string, unknown>;
	if (
		typeof record.fileId !== "string" ||
		!DELIVERED_FILE_ID_PATTERN.test(record.fileId) ||
		typeof record.name !== "string" ||
		record.name.trim().length < 1 ||
		record.name.length > 255 ||
		typeof record.byteLength !== "number" ||
		!Number.isInteger(record.byteLength) ||
		record.byteLength < 1 ||
		record.byteLength > 128 * 1024 * 1024 ||
		typeof record.deliveredAt !== "string"
	) {
		return undefined;
	}
	const messageText = record.message;
	if (
		messageText !== undefined &&
		(typeof messageText !== "string" ||
			messageText.trim().length < 1 ||
			messageText.length > MAX_DELIVER_FILE_MESSAGE_LENGTH)
	) {
		return undefined;
	}
	return {
		fileId: record.fileId,
		name: record.name.trim(),
		byteLength: record.byteLength,
		deliveredAt: record.deliveredAt,
		...(messageText === undefined ? {} : { message: messageText.trim() }),
	};
}

function normalizeInput(input: DeliverFileInput): { path: string; name?: string; message?: string } {
	const path = input.path.trim();
	if (!path) throw new TypeError("Deliverable path cannot be blank");
	const name = input.name?.trim();
	if (input.name !== undefined && !name) throw new TypeError("Deliverable name cannot be blank");
	const message = input.message?.trim();
	if (input.message !== undefined && !message) throw new TypeError("Delivery message cannot be blank");
	if (message && message.length > MAX_DELIVER_FILE_MESSAGE_LENGTH) {
		throw new TypeError("Delivery message is too long");
	}
	return {
		path,
		...(name === undefined ? {} : { name }),
		...(message === undefined ? {} : { message }),
	};
}

export function createDeliverFileToolDefinition(
	getContext: GetDeliverFileContext,
): ToolDefinition<typeof DeliverFileParams, DeliverFileDetails> {
	return {
		name: "deliver_file",
		label: "Deliver file",
		description:
			"Push a finished file to the user in the Desktop app so they can open or locate it. Use after creating or updating a deliverable the user should receive. The file must already exist on disk and stay within the current workspace, Metis attachment directory, or session work directory.",
		promptSnippet: "Send a finished file to the user in the Desktop app",
		parameters: DeliverFileParams,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal) {
			if (signal?.aborted) throw new Error("Deliver file was aborted");
			const context = getContext();
			const normalized = normalizeInput(input);
			const staged = stageDeliveredFile({
				agentDir: context.agentDir,
				sessionId: context.sessionId,
				cwd: context.cwd,
				additionalDirectories: context.additionalDirectories,
				sourcePath: normalized.path,
				name: normalized.name,
				activeDeliveredFileCount: context.activeDeliveredFileCount,
			});
			if (signal?.aborted) throw new Error("Deliver file was aborted");
			const deliveredAt = new Date().toISOString();
			const details: DeliverFileDetails = {
				fileId: staged.fileId,
				name: staged.name,
				byteLength: staged.byteLength,
				deliveredAt,
				...(normalized.message === undefined ? {} : { message: normalized.message }),
			};
			const lines = [
				`Delivered "${staged.name}" to the user (${staged.byteLength} bytes).`,
				normalized.message ? `Message: ${normalized.message}` : undefined,
				"The user can open the file from the inline delivery card in the chat transcript.",
			].filter((line): line is string => line !== undefined);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		},
	};
}
