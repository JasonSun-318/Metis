import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { errorCode } from "../error-code.ts";

type OpenedFile = {
	readonly handle: FileHandle;
	readonly initial: BigIntStats;
};

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isSameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return (
		isSameFile(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function assertSingleLinkFile(path: string, ...values: BigIntStats[]): void {
	if (values.some((value) => !value.isFile() || value.nlink !== 1n)) {
		throw new Error(`Refusing to mutate aliased or non-regular file: ${path}`);
	}
	if (values.some((value) => !isSameFile(values[0]!, value))) {
		throw new Error(`Refusing to mutate replaced file: ${path}`);
	}
}

async function openExistingSingleLinkFile(path: string, flags: number): Promise<OpenedFile> {
	const initial = await lstat(path, { bigint: true });
	assertSingleLinkFile(path, initial);
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
	const handle = await open(path, flags | noFollow | nonBlocking);
	try {
		const opened = await handle.stat({ bigint: true });
		const current = await lstat(path, { bigint: true });
		assertSingleLinkFile(path, initial, opened, current);
		if (!isSameSnapshot(initial, opened) || !isSameSnapshot(opened, current)) {
			throw new Error(`Refusing to mutate changing file: ${path}`);
		}
		return { handle, initial: opened };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function assertStillCurrent(path: string, opened: OpenedFile, requireSnapshot: boolean): Promise<void> {
	const handleStats = await opened.handle.stat({ bigint: true });
	const current = await lstat(path, { bigint: true });
	assertSingleLinkFile(path, opened.initial, handleStats, current);
	if (requireSnapshot && (!isSameSnapshot(opened.initial, handleStats) || !isSameSnapshot(handleStats, current))) {
		throw new Error(`Refusing to mutate changing file: ${path}`);
	}
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
	let offset = 0;
	while (offset < data.byteLength) {
		const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, offset);
		if (bytesWritten <= 0) throw new Error("Filesystem returned a zero-length write");
		offset += bytesWritten;
	}
}

async function overwriteOpened(
	path: string,
	opened: OpenedFile,
	data: string,
	requireSnapshot: boolean,
): Promise<void> {
	try {
		await assertStillCurrent(path, opened, requireSnapshot);
		await opened.handle.truncate(0);
		await writeAll(opened.handle, Buffer.from(data, "utf8"));
		await assertStillCurrent(path, opened, false);
	} finally {
		await opened.handle.close();
	}
}

export async function overwriteLocalSingleLinkFile(path: string, data: string): Promise<void> {
	let opened: OpenedFile;
	try {
		opened = await openExistingSingleLinkFile(path, constants.O_WRONLY);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
		const handle = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | nonBlocking,
			0o666,
		);
		try {
			const created = await handle.stat({ bigint: true });
			const current = await lstat(path, { bigint: true });
			assertSingleLinkFile(path, created, current);
			opened = { handle, initial: created };
		} catch (cause) {
			await handle.close();
			throw cause;
		}
	}
	await overwriteOpened(path, opened, data, false);
}

export async function updateLocalSingleLinkFile(path: string, update: (before: Buffer) => string): Promise<void> {
	const opened = await openExistingSingleLinkFile(path, constants.O_RDWR);
	try {
		const before = await opened.handle.readFile();
		const after = update(before);
		await assertStillCurrent(path, opened, true);
		await opened.handle.truncate(0);
		await writeAll(opened.handle, Buffer.from(after, "utf8"));
		await assertStillCurrent(path, opened, false);
	} finally {
		await opened.handle.close();
	}
}
