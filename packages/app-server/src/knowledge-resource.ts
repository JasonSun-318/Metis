import { stat } from "node:fs/promises";
import { join as nodeJoin, posix, sep } from "node:path";
import type { KnowledgeLibrary } from "@metis/app-protocol";
import { resolveKnowledgeLink } from "@metis/coding-agent/host";
import { readKnowledgeFile } from "./knowledge-file.ts";

const MAX_NOTE_BYTES = 4 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	md: "text/markdown",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export interface KnowledgeNoteIndex {
	readonly root: string;
	readonly paths: ReadonlySet<string>;
	readonly names: ReadonlyMap<string, readonly string[]>;
}

export interface ResolveKnowledgeResourceInput {
	readonly library: KnowledgeLibrary;
	readonly index: KnowledgeNoteIndex;
	readonly sourcePath: string;
	readonly reference: string;
	readonly kind: "wiki" | "markdown";
}

export type ResolvedKnowledgeResource = {
	libraryId: string;
	path: string;
	kind: "note" | "image" | "pdf";
	mimeType: string;
	revision: string;
	fragment?: string;
	absolutePath: string;
	rootPath: string;
};

/** Returns true when the leading bytes match the extension's real file signature. */
export function matchesDeclaredType(extension: string, head: Uint8Array): boolean {
	const startsWith = (bytes: readonly number[]) => bytes.every((byte, i) => head[i] === byte);
	switch (extension) {
		case "pdf":
			return startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
		case "png":
			return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case "jpg":
		case "jpeg":
			return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
		case "gif":
			return startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF87a/GIF89a
		case "webp":
			// RIFF....WEBP
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

function classify(extension: string | undefined): "note" | "image" | "pdf" | undefined {
	if (!extension) return "note";
	if (extension === "md") return "note";
	if (extension === "pdf") return "pdf";
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	return undefined;
}

async function describeFile(
	library: KnowledgeLibrary,
	index: KnowledgeNoteIndex,
	candidate: string,
	resourceKind: "note" | "image" | "pdf",
	extension: string,
): Promise<ResolvedKnowledgeResource> {
	const file = await readKnowledgeFile(
		index.root,
		candidate,
		resourceKind === "note" ? MAX_NOTE_BYTES : 50 * 1024 * 1024,
		16,
	).catch((cause: unknown) => {
		if (
			cause &&
			typeof cause === "object" &&
			"code" in cause &&
			(cause.code === "ENOENT" || cause.code === "ENOTDIR")
		)
			throw new Error("Knowledge reference does not match a file");
		throw cause;
	});
	if (resourceKind !== "note" && !matchesDeclaredType(extension, file.bytes))
		throw new Error(`Knowledge file does not match its .${extension} type`);
	return {
		libraryId: library.id,
		path: candidate.split(sep).join("/"),
		kind: resourceKind,
		mimeType: MIME_BY_EXTENSION[extension || "md"],
		revision: file.revision,
		absolutePath: file.absolutePath,
		rootPath: file.rootPath,
	};
}

async function resolveFragmentOfSource(
	library: KnowledgeLibrary,
	index: KnowledgeNoteIndex,
	sourcePath: string,
	fragment: string,
): Promise<ResolvedKnowledgeResource> {
	const extension = (/\.([a-z\d]+)$/i.exec(sourcePath)?.[1] ?? "").toLowerCase();
	const resolved = await describeFile(library, index, sourcePath, "note", extension || "md");
	return { ...resolved, fragment };
}

/**
 * Resolves one wiki/Markdown reference from a source note to a concrete in-library file.
 * Absolute paths, protocol URLs, directory targets, symlink escapes, ambiguous names and
 * extension/type mismatches are rejected instead of guessed.
 */
export async function resolveKnowledgeResource(
	input: ResolveKnowledgeResourceInput,
): Promise<ResolvedKnowledgeResource> {
	const { library, index, sourcePath, kind } = input;
	if (
		!sourcePath ||
		!/\.md$/iu.test(sourcePath) ||
		/^(?:[\\/]|[a-z]:)/iu.test(sourcePath) ||
		sourcePath
			.replaceAll("\\", "/")
			.split("/")
			.some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Invalid knowledge source note path");
	const reference = input.reference.trim();
	if (!reference) throw new Error("Knowledge reference is empty");
	const rejectUnsafe = (value: string): void => {
		if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//"))
			throw new Error("Knowledge reference must not use a protocol or absolute URL");
	};
	rejectUnsafe(reference);
	const hashIndex = reference.indexOf("#");
	const rawTarget = (hashIndex >= 0 ? reference.slice(0, hashIndex) : reference).trim();
	const fragment = hashIndex >= 0 ? reference.slice(hashIndex + 1) : undefined;
	rejectUnsafe(rawTarget);

	// A bare fragment such as "#Heading" points back at the source note itself.
	if (!rawTarget) {
		if (!fragment) throw new Error("Knowledge reference is empty");
		return resolveFragmentOfSource(library, index, sourcePath, fragment);
	}

	const slashTarget = rawTarget.replace(/\\/g, "/");
	const rejectAbsolute = (value: string): void => {
		if (value.startsWith("/") || /^[a-z]:/i.test(value))
			throw new Error("Knowledge reference must be library-relative");
	};
	rejectAbsolute(slashTarget);
	let target = slashTarget;
	if (kind === "markdown") {
		try {
			target = decodeURIComponent(slashTarget);
		} catch {
			throw new Error("Knowledge reference has invalid percent encoding");
		}
		// Percent decoding can reveal a protocol or absolute path that was hidden on the wire.
		rejectUnsafe(target);
		rejectAbsolute(target);
	}
	const extension = (/\.([a-z\d]+)$/i.exec(target)?.[1] ?? "").toLowerCase();
	const resourceKind = classify(extension || undefined);
	if (!resourceKind) throw new Error(`Knowledge does not embed .${extension || "unknown"} files`);
	const withExtension = extension ? target : `${target}.md`;

	let candidate: string | null;
	if (kind === "markdown") {
		candidate = posix.normalize(posix.join(posix.dirname(sourcePath), withExtension));
	} else if (resourceKind === "note") {
		candidate = resolveKnowledgeLink(sourcePath, target, index.paths, index.names, "wiki");
		if (!candidate) {
			const matches = index.names.get(target.replace(/\.md$/i, "")) ?? [];
			if (matches.length > 1) throw new Error(`Knowledge reference "${target}" matches multiple notes`);
			throw new Error(`Knowledge reference "${target}" does not match a note`);
		}
	} else {
		// Embedded attachments resolve from the vault root first, then the source directory.
		const rootCandidate = posix.normalize(withExtension);
		const localCandidate = posix.normalize(posix.join(posix.dirname(sourcePath), withExtension));
		const present: string[] = [];
		for (const path of new Set([rootCandidate, localCandidate])) {
			try {
				const info = await stat(nodeJoin(index.root, path));
				if (info.isFile()) present.push(path);
			} catch {
				// Missing candidates simply do not count.
			}
		}
		if (present.length > 1) throw new Error(`Knowledge reference "${target}" matches multiple files`);
		candidate = present[0] ?? null;
		if (!candidate) throw new Error(`Knowledge reference "${target}" does not match a file`);
	}
	if (!candidate) throw new Error("Knowledge reference does not match a file");
	if (candidate.length === 0 || candidate === "." || candidate === ".." || candidate.startsWith("../"))
		throw new Error("Knowledge reference escapes the library root");

	const resolved = await describeFile(library, index, candidate, resourceKind, extension);
	return fragment ? { ...resolved, fragment } : resolved;
}
