import { isAbsolute } from "node:path";
import { type Static, Type } from "typebox";

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

export interface DeliverFileDetails {
	readonly fileId: string;
	/** Present for live references; absent in legacy copied deliveries. */
	readonly sourcePath?: string;
	readonly name: string;
	readonly byteLength: number;
	readonly message?: string;
	readonly deliveredAt: string;
}

const DELIVERED_FILE_ID_PATTERN = /^[a-f0-9]{16}$/u;

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
	if (
		record.sourcePath !== undefined &&
		(typeof record.sourcePath !== "string" ||
			record.sourcePath.length > 4096 ||
			record.sourcePath.includes("\0") ||
			!isAbsolute(record.sourcePath))
	)
		return undefined;
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
		...(typeof record.sourcePath === "string" ? { sourcePath: record.sourcePath } : {}),
		name: record.name.trim(),
		byteLength: record.byteLength,
		deliveredAt: record.deliveredAt,
		...(messageText === undefined ? {} : { message: messageText.trim() }),
	};
}

export function normalizeDeliverFileInput(input: DeliverFileInput): { path: string; name?: string; message?: string } {
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
