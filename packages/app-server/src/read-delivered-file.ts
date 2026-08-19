import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { resolveDeliveredFilePath } from "@metis/coding-agent";

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

export async function readDeliveredFile(options: {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly fileId: string;
}): Promise<{
	readonly fileId: string;
	readonly name: string;
	readonly byteLength: number;
	readonly data: string;
	readonly mediaType?: string;
	readonly absolutePath: string;
}> {
	const path = resolveDeliveredFilePath(options.agentDir, options.sessionId, options.fileId);
	if (!path) throw new Error("Delivered file was not found");
	const metadata = await stat(path);
	const contents = await readFile(path);
	const ext = extname(path).replace(/^\./u, "").toLowerCase();
	const mediaType = MIME_MAP[ext] || "application/octet-stream";
	return {
		fileId: options.fileId,
		name: basename(path),
		byteLength: metadata.size,
		data: contents.toString("base64"),
		mediaType,
		absolutePath: path,
	};
}
