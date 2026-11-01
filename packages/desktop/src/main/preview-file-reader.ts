import { constants as fsConstants, realpath as realpathCallback } from "node:fs";
import { open, realpath as realpathNative, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { type DesktopPreviewFile, PREVIEW_MAX_BYTES } from "../shared/desktop-api.ts";

// App Server canonicalizes owned paths with realpathSync. On Windows, the
// callback implementation preserves the same casing; the native variant does not.
const realpath = process.platform === "win32" ? promisify(realpathCallback) : realpathNative;

const MAX_KNOWLEDGE_NOTE_BYTES = 4 * 1024 * 1024;
const O_NOFOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

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

/** True when the leading bytes match the extension's real file signature. */
function matchesDeclaredType(extension: string, head: Uint8Array): boolean {
	const startsWith = (bytes: readonly number[]) => bytes.every((byte, i) => head[i] === byte);
	switch (extension) {
		case "pdf":
			return startsWith([0x25, 0x50, 0x44, 0x46]);
		case "png":
			return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case "jpg":
		case "jpeg":
			return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
		case "gif":
			return startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		case "webp":
			return (
				startsWith([0x52, 0x49, 0x46, 0x46]) &&
				head[8] === 0x57 &&
				head[9] === 0x45 &&
				head[10] === 0x42 &&
				head[11] === 0x50
			);
		default:
			return true;
	}
}

/**
 * Reads one knowledge-library file through a held handle whose identity is re-verified after
 * the read, so a swapped or concurrently modified file is never delivered as stale bytes.
 */
export async function readKnowledgePreviewBytes(
	root: string,
	relativePath: string,
	revision?: string,
): Promise<DesktopPreviewFile> {
	const invalid = { ok: false as const, reason: "not-found" as const };
	if (!relativePath || relativePath.includes("\\") || isAbsolute(relativePath)) return invalid;
	if (relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) return invalid;
	const extension = extname(relativePath).replace(/^\./u, "").toLowerCase();
	if (!["md", "png", "jpg", "jpeg", "gif", "webp", "pdf"].includes(extension)) return invalid;
	let rootReal: string;
	let absolute: string;
	try {
		rootReal = await realpath(root);
		absolute = await realpath(join(rootReal, relativePath));
	} catch {
		return invalid;
	}
	const within = relative(rootReal, absolute);
	if (within.length === 0 || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return invalid;
	const maxBytes = extension === "md" ? MAX_KNOWLEDGE_NOTE_BYTES : PREVIEW_MAX_BYTES;
	// Observe the expected identity before opening so a swap between stat and open is detected.
	let expected: Awaited<ReturnType<typeof stat>>;
	try {
		expected = await stat(absolute);
	} catch {
		return invalid;
	}
	if (!expected.isFile() || expected.size > maxBytes)
		return expected.size > maxBytes ? { ok: false, reason: "too-large" } : invalid;
	if (extension !== "md" && expected.size === 0) return invalid;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		// O_NOFOLLOW fails the open if the leaf is swapped to a symlink before this point.
		handle = await open(absolute, O_NOFOLLOW_FLAGS);
	} catch {
		return invalid;
	}
	const identityChanged = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
		a.dev !== b.dev || a.ino !== b.ino;
	const staleOrInvalid = () => (revision ? { ok: false as const, reason: "stale" as const } : invalid);
	try {
		const before = await handle.stat();
		if (!before.isFile() || identityChanged(before, expected) || before.size !== expected.size) return invalid;
		const stamp = `${before.mtimeMs}:${before.ctimeMs}:${before.size}`;
		if (revision && revision !== stamp) return { ok: false, reason: "stale" };
		const bytes = new Uint8Array(before.size);
		const { bytesRead } = await handle.read(bytes, 0, before.size, 0);
		if (bytesRead !== before.size) return invalid;
		if (!matchesDeclaredType(extension, bytes.subarray(0, Math.min(16, bytesRead)))) return invalid;
		// The handle, the on-disk path and the root must all still describe the same file.
		const after = await handle.stat();
		if (
			identityChanged(after, before) ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			return staleOrInvalid();
		const rootAgain = await realpath(root);
		// Re-resolve the originally requested path, not just the opened one, so a swapped
		// parent directory or symlink anywhere along the request path is detected.
		const pathAgain = await realpath(join(rootReal, relativePath));
		const statAgain = await stat(absolute);
		if (rootAgain !== rootReal || pathAgain !== absolute || identityChanged(statAgain, after))
			return staleOrInvalid();
		if (statAgain.size !== after.size || statAgain.mtimeMs !== after.mtimeMs) return staleOrInvalid();
		return {
			ok: true,
			name: basename(relativePath),
			byteLength: before.size,
			mediaType: MIME_BY_EXT[extension] || "application/octet-stream",
			bytes,
		};
	} finally {
		await handle.close();
	}
}

/** The path is resolved from this session's delivery history by App Server, never supplied by the renderer. */
export async function readDeliveredPreviewBytes(path: string, name: string): Promise<DesktopPreviewFile> {
	const invalid = { ok: false as const, reason: "not-found" as const };
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		if ((await realpath(path)) !== path) return invalid;
		handle = await open(path, O_NOFOLLOW_FLAGS);
		const before = await handle.stat();
		if (!before.isFile()) return invalid;
		if (before.size > PREVIEW_MAX_BYTES) return { ok: false, reason: "too-large" };
		const bytes = new Uint8Array(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) return invalid;
			offset += bytesRead;
		}
		const after = await handle.stat();
		const current = await stat(path);
		if (
			(await realpath(path)) !== path ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			return invalid;
		const ext = extname(name).slice(1).toLowerCase();
		return {
			ok: true,
			name,
			byteLength: bytes.length,
			mediaType: MIME_BY_EXT[ext] || "application/octet-stream",
			bytes,
		};
	} catch {
		return invalid;
	} finally {
		await handle?.close();
	}
}
