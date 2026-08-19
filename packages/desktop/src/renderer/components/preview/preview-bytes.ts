import { fileExtension } from "./preview-kinds.ts";

export function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return `data:${mediaType};base64,${btoa(binary)}`;
}

export function previewImageMediaType(fileName: string, mediaType?: string): string {
	if (mediaType && mediaType !== "application/octet-stream") return mediaType;
	const ext = fileExtension(fileName);
	if (ext === "svg") return "image/svg+xml";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "png" || ext === "gif" || ext === "webp") return `image/${ext}`;
	return mediaType || "application/octet-stream";
}

export function decodePreviewText(bytes: Uint8Array): string {
	let offset = 0;
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		offset = 3;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(offset === 0 ? bytes : bytes.subarray(offset));
}

export function formatPreviewText(fileName: string, text: string): string {
	if (fileExtension(fileName) !== "json") return text;
	try {
		return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
	} catch {
		return text;
	}
}
