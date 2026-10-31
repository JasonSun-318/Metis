import { open } from "node:fs/promises";
import { extname } from "node:path";
import { MAX_ENVELOPE_UTF8_BYTES } from "@metis/app-protocol";
import type { ResolvedSessionDeliveredArtifact } from "@metis/coding-agent/host";

const MIME_MAP: Record<string, string> = {
	pdf: "application/pdf",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	csv: "text/csv",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	ppt: "application/vnd.ms-powerpoint",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	js: "text/javascript",
	ts: "text/plain",
	tsx: "text/plain",
	jsx: "text/plain",
	py: "text/plain",
	html: "text/html",
	css: "text/css",
};

// Base64 expands by 4/3; leave room for metadata and the RPC envelope.
const MAX_INLINE_FILE_BYTES = Math.floor((MAX_ENVELOPE_UTF8_BYTES - 64 * 1024) / 4) * 3;

export async function readDeliveredFile(
	options: ResolvedSessionDeliveredArtifact,
	metadataOnly = false,
): Promise<{
	readonly fileId: string;
	readonly name: string;
	readonly byteLength: number;
	readonly data: string;
	readonly mediaType?: string;
	readonly absolutePath: string;
}> {
	if (metadataOnly)
		return {
			fileId: options.artifact.fileId,
			name: options.artifact.name,
			byteLength: options.artifact.byteLength,
			absolutePath: options.path,
			data: "",
		};
	if (options.artifact.byteLength > MAX_INLINE_FILE_BYTES)
		throw new Error("Delivered file is too large for an inline RPC response");
	const file = await open(options.path, "r");
	let contents: Buffer;
	try {
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size !== options.artifact.byteLength)
			throw new Error("Delivered file was not found");
		// Read one extra byte to detect growth without ever reading an unbounded file.
		const buffer = Buffer.alloc(metadata.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset !== metadata.size) throw new Error("Delivered file was not found");
		contents = buffer.subarray(0, offset);
	} finally {
		await file.close();
	}
	const ext = extname(options.artifact.name).replace(/^\./u, "").toLowerCase();
	const mediaType = MIME_MAP[ext] || "application/octet-stream";
	return {
		fileId: options.artifact.fileId,
		name: options.artifact.name,
		byteLength: contents.length,
		data: contents.toString("base64"),
		mediaType,
		absolutePath: options.path,
	};
}
