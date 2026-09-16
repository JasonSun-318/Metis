import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
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

export async function readDeliveredFile(options: ResolvedSessionDeliveredArtifact): Promise<{
	readonly fileId: string;
	readonly name: string;
	readonly byteLength: number;
	readonly data: string;
	readonly mediaType?: string;
	readonly absolutePath: string;
}> {
	const metadata = await stat(options.path);
	if (metadata.size !== options.artifact.byteLength) throw new Error("Delivered file was not found");
	const contents = await readFile(options.path);
	const ext = extname(options.artifact.name).replace(/^\./u, "").toLowerCase();
	const mediaType = MIME_MAP[ext] || "application/octet-stream";
	return {
		fileId: options.artifact.fileId,
		name: options.artifact.name,
		byteLength: metadata.size,
		data: contents.toString("base64"),
		mediaType,
		absolutePath: options.path,
	};
}
