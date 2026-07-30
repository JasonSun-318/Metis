import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { DesktopAttachmentSelection, DesktopCreateProjectFolderInput } from "../shared/desktop-api.ts";

const MAX_PROJECT_FILES = 16;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const INVALID_PROJECT_NAME = /[<>:"/\\|?*\u0000-\u001f]/u;

function projectInput(value: unknown): DesktopCreateProjectFolderInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Invalid project folder input");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["parentDirectory", "name", "files"].includes(key)) ||
		typeof input.parentDirectory !== "string" ||
		!isAbsolute(input.parentDirectory) ||
		typeof input.name !== "string" ||
		!Array.isArray(input.files)
	) {
		throw new TypeError("Invalid project folder input");
	}
	const name = input.name;
	if (
		name.length === 0 ||
		name.length > 120 ||
		name !== name.trim() ||
		name.endsWith(".") ||
		INVALID_PROJECT_NAME.test(name) ||
		WINDOWS_RESERVED_NAME.test(name) ||
		name === "." ||
		name === ".."
	) {
		throw new TypeError("Choose a valid project name");
	}
	if (input.files.length > MAX_PROJECT_FILES) throw new TypeError("A project can include at most 16 files");
	for (const file of input.files) {
		if (
			typeof file !== "object" ||
			file === null ||
			Array.isArray(file) ||
			Object.keys(file).some((key) => !["path", "name"].includes(key)) ||
			typeof (file as Record<string, unknown>).path !== "string" ||
			!isAbsolute((file as Record<string, unknown>).path as string) ||
			typeof (file as Record<string, unknown>).name !== "string"
		) {
			throw new TypeError("Invalid project file selection");
		}
	}
	return input as unknown as DesktopCreateProjectFolderInput;
}

export async function createProjectFolder(value: unknown): Promise<string> {
	const input = projectInput(value);
	const sources = await Promise.all(
		input.files.map(async (file): Promise<DesktopAttachmentSelection> => {
			const info = await lstat(file.path);
			if (!info.isFile() || info.isSymbolicLink()) throw new TypeError(`${file.name} is not a regular file`);
			return { path: file.path, name: basename(file.path) };
		}),
	);
	const names = new Set<string>();
	for (const source of sources) {
		const key = source.name.toLocaleLowerCase("en-US");
		if (names.has(key)) throw new TypeError(`Duplicate file name: ${source.name}`);
		names.add(key);
	}

	await mkdir(input.parentDirectory, { recursive: true });
	const parentDirectory = await realpath(input.parentDirectory);
	const projectDirectory = join(parentDirectory, input.name);
	await mkdir(projectDirectory);
	try {
		const copies = await Promise.allSettled(
			sources.map((source) => copyFile(source.path, join(projectDirectory, source.name), constants.COPYFILE_EXCL)),
		);
		const failed = copies.find((copy) => copy.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		return await realpath(projectDirectory);
	} catch (cause) {
		await rm(projectDirectory, { recursive: true, force: true });
		throw cause;
	}
}
