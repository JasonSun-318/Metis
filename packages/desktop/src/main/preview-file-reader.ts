import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { type DesktopPreviewFile, PREVIEW_MAX_BYTES } from "../shared/desktop-api.ts";

const MIME_BY_EXT: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	csv: "text/csv",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
};

export { PREVIEW_MAX_BYTES };

export function deliveredPreviewDirectories(sessionId: string): readonly string[] {
	return [
		process.env.METIS_AGENT_DIR ? join(process.env.METIS_AGENT_DIR, "attachments", sessionId, "delivered") : null,
		join(homedir(), ".metis", "agent", "attachments", sessionId, "delivered"),
		join(homedir(), ".metis", "attachments", sessionId, "delivered"),
		join(homedir(), ".metis", "agent", "attachments", sessionId),
		join(homedir(), ".metis", "attachments", sessionId),
	].filter((directory): directory is string => directory !== null);
}

function toBytes(contents: Uint8Array): Uint8Array {
	return new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
}

export async function readDeliveredPreviewBytes(directory: string, fileId: string): Promise<DesktopPreviewFile> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return { ok: false, reason: "not-found" };
	}
	const match = names.find((name) => name.toLowerCase().startsWith(fileId.toLowerCase()));
	if (!match) return { ok: false, reason: "not-found" };
	const fullPath = join(directory, match);
	const metadata = await stat(fullPath);
	if (!metadata.isFile()) return { ok: false, reason: "not-found" };
	if (metadata.size > PREVIEW_MAX_BYTES) return { ok: false, reason: "too-large" };
	const bytes = await readFile(fullPath);
	const ext = extname(fullPath).replace(/^\./u, "").toLowerCase();
	return {
		ok: true,
		name: basename(fullPath),
		byteLength: metadata.size,
		mediaType: MIME_BY_EXT[ext] || "application/octet-stream",
		bytes: toBytes(bytes),
	};
}
