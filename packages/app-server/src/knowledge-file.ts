import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

type FileInfo = Awaited<ReturnType<FileHandle["stat"]>>;

function sameFile(left: FileInfo, right: FileInfo): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

/** A held file handle and path identity checks protect both note bodies and resource metadata reads. */
export async function readKnowledgeFile(root: string, path: string, maxBytes: number, headBytes?: number) {
	if (isAbsolute(path) || /^[a-z]:/iu.test(path) || path.includes("\0"))
		throw new Error("Invalid knowledge file path");
	const normalized = path.replaceAll("\\", "/");
	if (normalized.split("/").some((part) => !part || part === "." || part === ".."))
		throw new Error("Invalid knowledge file path");
	const rootPath = await realpath(root);
	const requested = join(rootPath, normalized);
	const absolutePath = await realpath(requested);
	const within = relative(rootPath, absolutePath);
	if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
		throw new Error("Knowledge reference escapes outside the library root");
	const expected = await stat(absolutePath);
	if (!expected.isFile() || expected.size > maxBytes)
		throw new Error("Knowledge file is not a file or exceeds the preview limit");
	const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat();
		if (!sameFile(expected, before) || !before.isFile()) throw new Error("Knowledge file changed while opening");
		const bytes = new Uint8Array(Math.min(before.size, headBytes ?? before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) throw new Error("Knowledge file changed while reading");
			offset += bytesRead;
		}
		const after = await handle.stat();
		const currentRoot = await realpath(root);
		const currentPath = await realpath(requested);
		const current = await stat(currentPath);
		if (
			!sameFile(before, after) ||
			!sameFile(after, current) ||
			currentRoot !== rootPath ||
			currentPath !== absolutePath
		)
			throw new Error("Knowledge file changed while reading");
		return {
			bytes,
			rootPath,
			absolutePath,
			size: before.size,
			revision: `${before.mtimeMs}:${before.ctimeMs}:${before.size}`,
		};
	} finally {
		await handle.close();
	}
}
