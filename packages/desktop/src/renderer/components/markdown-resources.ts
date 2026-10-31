import type { DesktopPreviewFileInput, MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { MarkdownReference } from "./markdown-references.ts";
import { decodePreviewText } from "./preview/preview-bytes.ts";
import { previewBytesCache, previewCacheKey } from "./preview/preview-bytes-cache.ts";

export type MarkdownSource =
	| { readonly source: "knowledge"; readonly libraryId: string; readonly path: string; readonly sessionId?: string }
	| { readonly source: "workspace"; readonly sessionId: string; readonly path: string }
	| {
			readonly source: "delivered";
			readonly sessionId: string;
			readonly rootSessionId?: string;
			readonly fileId: string;
			readonly path: string;
			/** Explicit grants only; siblings are never inferred from a delivered file's directory. */
			readonly dependencies?: ReadonlyMap<string, DesktopPreviewFileInput>;
	  };

export interface MarkdownDocument {
	readonly api: MetisDesktopApi;
	readonly owner: MarkdownSource;
	readonly revision?: string | number;
	readonly onOpenNote?: (path: string, fragment?: string) => void;
}

export interface MarkdownResource {
	readonly path: string;
	readonly kind: "note" | "image" | "pdf";
	readonly fragment?: string;
	readonly revision?: string;
	readonly mediaType: string;
	readonly input: DesktopPreviewFileInput;
	readonly owner: MarkdownSource;
}

export function markdownSourceKey(owner: MarkdownSource): string {
	return JSON.stringify([owner.source, owner.source === "knowledge" ? owner.libraryId : owner.sessionId, owner.path]);
}

function relativeResourcePath(sourcePath: string, target: string): string {
	if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/iu.test(target) || target.includes("\0"))
		throw new Error("Only local references within this document's directory scope can be embedded");
	const segments = sourcePath.replaceAll("\\", "/").split("/").slice(0, -1);
	for (const part of target.replaceAll("\\", "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!segments.length) throw new Error("Reference escapes the authorized root");
			segments.pop();
		} else segments.push(part);
	}
	return segments.join("/");
}

function referenceKind(path: string): MarkdownResource["kind"] {
	if (/\.md$/iu.test(path)) return "note";
	if (/\.(?:png|jpe?g|gif|webp)$/iu.test(path)) return "image";
	if (/\.pdf$/iu.test(path)) return "pdf";
	throw new Error("This resource format cannot be embedded");
}

export async function resolveMarkdownResource(
	document: MarkdownDocument,
	reference: MarkdownReference,
): Promise<MarkdownResource> {
	const { owner, api } = document;
	if (owner.source === "knowledge") {
		const result = await api.resolveKnowledgeResource({
			libraryId: owner.libraryId,
			sourcePath: owner.path,
			reference: reference.reference,
			kind: reference.kind,
		});
		return {
			path: result.path,
			kind: result.kind,
			fragment: result.fragment,
			revision: result.revision,
			mediaType: result.mimeType,
			input: {
				source: "knowledge",
				libraryId: owner.libraryId,
				relativePath: result.path,
				revision: result.revision,
			},
			owner: { ...owner, path: result.path },
		};
	}
	const hash = reference.reference.indexOf("#");
	const rawPath = hash < 0 ? reference.reference : reference.reference.slice(0, hash);
	const fragment = hash < 0 ? undefined : reference.reference.slice(hash + 1);
	let target = decodeURIComponent(rawPath);
	if (reference.kind === "wiki" && target && !/\.[^/]+$/u.test(target)) target += ".md";
	const path = target ? relativeResourcePath(owner.path, target) : owner.path;
	const kind = referenceKind(path);
	let input: DesktopPreviewFileInput;
	if (owner.source === "workspace") input = { source: "workspace", sessionId: owner.sessionId, relativePath: path };
	else if (path === owner.path)
		input = {
			source: "delivered",
			sessionId: owner.sessionId,
			rootSessionId: owner.rootSessionId,
			fileId: owner.fileId,
		};
	else {
		const granted = owner.dependencies?.get(path);
		if (!granted || granted.source !== "delivered")
			throw new Error("This dependency has not been explicitly delivered");
		input = granted;
	}
	const resolvedOwner: MarkdownSource =
		input.source === "delivered" && owner.source === "delivered"
			? { ...owner, path, sessionId: input.sessionId, rootSessionId: input.rootSessionId, fileId: input.fileId }
			: { ...owner, path };
	return { path, kind, fragment, mediaType: "application/octet-stream", input, owner: resolvedOwner };
}

export function embeddedMediaType(bytes: Uint8Array): string | undefined {
	const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
	if (bytes[0] === 0x89 && prefix.slice(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
	if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
	if (prefix.startsWith("%PDF-")) return "application/pdf";
	return;
}

export async function readMarkdownResource(
	document: MarkdownDocument,
	resource: MarkdownResource,
): Promise<Uint8Array> {
	const { api } = document;
	const key = previewCacheKey(resource.input);
	// Workspaces are live. Knowledge resolution supplies the current revision and validates registration.
	let bytes = resource.input.source === "knowledge" ? previewBytesCache.get(key) : undefined;
	if (!bytes) {
		const result = await api.readPreviewFile(resource.input);
		if (!result.ok)
			throw new Error(result.reason === "too-large" ? "File is too large to preview" : "File could not be opened");
		bytes = result.bytes;
	}
	if (resource.input.source === "knowledge") {
		const id = resource.input.libraryId;
		if (!(await api.listKnowledgeLibraries()).libraries.some((library) => library.id === id)) {
			previewBytesCache.deleteLibrary(id);
			throw new Error("Knowledge directory is not registered");
		}
	}
	if (resource.kind === "note") {
		if (bytes.byteLength > 4 * 1024 * 1024 || decodePreviewText(bytes).includes("\0"))
			throw new Error("Note preview supports Markdown files up to 4 MiB");
	} else {
		const media = embeddedMediaType(bytes);
		if (!media || (resource.kind === "pdf" ? media !== "application/pdf" : !media.startsWith("image/")))
			throw new Error("Resource contents do not match a supported image or PDF");
	}
	if (resource.input.source === "knowledge") previewBytesCache.set(key, bytes);
	return bytes;
}
