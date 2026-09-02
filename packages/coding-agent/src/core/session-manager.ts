import type { AgentMessage, ThinkingLevel } from "@metis/agent-core";
import type { ImageContent, Message, TextContent } from "@metis/ai";
import { createHash, randomUUID } from "crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
} from "fs";
import { lstat, open, readdir } from "fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "path";
import { setImmediate as yieldToEventLoop } from "timers/promises";
import { TextDecoder } from "util";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { canonicalizePathForCreation, encodePathForStorage, normalizePath, resolvePath } from "../utils/paths.ts";
import { trashPathsSync } from "../utils/trash.ts";
import { type AgentMode, DEFAULT_AGENT_MODE, isAgentMode } from "./agent-mode.ts";
import {
	createFileAtomicallySync,
	ensureDirectoryDurablySync,
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	syncDirectorySync,
} from "./durable-file.ts";
import type { PersistedToolOutput } from "./large-tool-output.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";
import {
	recoverInterruptedProjectTrash as recoverProjectTrash,
	type TrashModeProjectDataInput,
	type TrashModeProjectDataResult,
	trashModeProjectData as trashProjectData,
} from "./mode-project-delete.ts";
import {
	DEFAULT_PERMISSION_PRESET,
	isPermissionPreset,
	type PermissionPreset,
	type PermissionSettings,
	settingsForPreset,
} from "./permissions/settings.ts";
import {
	type CollaborationMode,
	type PlanRef,
	type PlanState,
	reducePlanState,
	type StoredPlan,
} from "./plan-state.ts";
import {
	type DurableImageRef,
	isRuntimeControlEntryType,
	MAX_DURABLE_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGES,
	parseRuntimeControlEntry,
	type RuntimeControlEntry,
} from "./runtime-recovery.ts";
import {
	formatSessionAttachmentDisplayText,
	getOwnedSessionAttachmentDir,
	getOwnedSessionWorkDirs,
} from "./session-attachments.ts";
import {
	type AgentControlPayload,
	isAgentControlEntryType,
	isPlanControlEntryType,
	isSessionControlEntryType,
	isSessionDirectoryControlEntryType,
	type PermissionDecisionSource,
	parseSessionControlEntry,
	type SessionControlEntry,
	type SessionControlPayload,
} from "./session-control.ts";
import { assertValidSessionId, createSessionId } from "./session-id.ts";
import {
	CorruptSessionError,
	getOwnedSessionJournalArtifacts,
	openSessionJournal,
	type SessionJournal,
} from "./session-journal.ts";
import { acquireModeProjectMutationLease, SessionLease, SessionLeaseError } from "./session-lease.ts";
import { type CwdOrigin, getOwnedManagedWorkspace, publishManagedWorkspaceCopy } from "./session-workspace.ts";
import { isValidAgentTypeId } from "./subagents/agent-type-registry.ts";

export const CURRENT_SESSION_VERSION = 14;

interface ImageReference {
	type: "image_ref";
	hash: string;
	mimeType: string;
	size?: number;
}

// Legacy transcripts may contain larger refs than the app prompt contract.
// Keep one bounded compatibility budget; larger attachments need a streaming seam.
const MAX_SESSION_IMAGE_BLOB_BYTES = 64 * 1024 * 1024;

interface ImageReadBudget {
	used: number;
	readonly limit: number;
}

function imageExtension(mimeType: string): string | undefined {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
	}
}

function canonicalPath(filePath: string): string {
	return canonicalizePathForCreation(filePath);
}

function getSessionAssetDirFromStoragePath(storagePath: string, assetName: "images" | "tool-results"): string {
	const resolvedFile = resolve(storagePath);
	const defaultSessionsDir = canonicalPath(getSessionsDir());
	const relativePath = relative(defaultSessionsDir, resolvedFile);
	const isDefaultSession =
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
	const assetRoot = isDefaultSession
		? join(canonicalPath(getDefaultAgentDir()), assetName)
		: join(dirname(resolvedFile), assetName);
	const sessionKey = createHash("sha256").update(resolve(resolvedFile)).digest("hex");
	return join(assetRoot, sessionKey);
}

function getSessionAssetDir(sessionFile: string, assetName: "images" | "tool-results"): string {
	return getSessionAssetDirFromStoragePath(canonicalPath(sessionFile), assetName);
}

export function getSessionImageDir(sessionFile: string): string {
	return getSessionAssetDir(sessionFile, "images");
}

export function getSessionToolOutputDir(sessionFile: string): string {
	return getSessionAssetDir(sessionFile, "tool-results");
}

const SESSION_DISPLAY_METADATA_SUFFIX = ".metadata.json";
const MAX_SESSION_DISPLAY_METADATA_BYTES = 16 * 1024;
const SESSION_UNREAD_STATE_SUFFIX = ".unread.json";
const MAX_SESSION_UNREAD_STATE_BYTES = 1024;

export interface SessionDisplayMetadata {
	readonly sessionId: string;
	readonly name?: string;
}

export function getSessionDisplayMetadataPath(sessionFile: string): string {
	return `${canonicalPath(sessionFile)}${SESSION_DISPLAY_METADATA_SUFFIX}`;
}

export function getSessionUnreadStatePath(sessionFile: string): string {
	return `${canonicalPath(sessionFile)}${SESSION_UNREAD_STATE_SUFFIX}`;
}

export function readSessionUnreadState(sessionFile: string, sessionId: string): boolean {
	try {
		assertValidSessionId(sessionId);
		const text = readSingleLinkTextFileSync(getSessionUnreadStatePath(sessionFile), {
			maxBytes: MAX_SESSION_UNREAD_STATE_BYTES,
		});
		if (text === undefined) return false;
		const value = JSON.parse(text) as Record<string, unknown>;
		return value.version === 1 && value.sessionId === sessionId && value.unread === true;
	} catch {
		return false;
	}
}

export function readSessionDisplayMetadata(sessionFile: string): SessionDisplayMetadata | undefined {
	try {
		const text = readSingleLinkTextFileSync(getSessionDisplayMetadataPath(sessionFile), {
			maxBytes: MAX_SESSION_DISPLAY_METADATA_BYTES,
		});
		if (text === undefined) return undefined;
		const value = JSON.parse(text) as Record<string, unknown>;
		if (value.version !== 1 || typeof value.sessionId !== "string") return undefined;
		assertValidSessionId(value.sessionId);
		if (value.name !== null && typeof value.name !== "string") return undefined;
		const name = typeof value.name === "string" ? value.name.trim() : "";
		if (Buffer.byteLength(name, "utf8") > MAX_SESSION_DISPLAY_METADATA_BYTES / 2) return undefined;
		return { sessionId: value.sessionId, ...(name ? { name } : {}) };
	} catch {
		return undefined;
	}
}

function removeSessionUnreadState(sessionFile: string): void {
	const path = getSessionUnreadStatePath(sessionFile);
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			throw new Error("Session unread state must be a single-link regular file");
		}
		unlinkSync(path);
		syncDirectorySync(dirname(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function writeSessionUnreadState(sessionFile: string, sessionId: string): void {
	assertValidSessionId(sessionId);
	const contents = `${JSON.stringify({ version: 1, sessionId, unread: true })}\n`;
	replaceFileAtomicallySync(getSessionUnreadStatePath(sessionFile), contents, { mode: 0o600 });
}

function removeSessionDisplayMetadata(sessionFile: string): void {
	const path = getSessionDisplayMetadataPath(sessionFile);
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			throw new Error("Session display metadata must be a single-link regular file");
		}
		unlinkSync(path);
		syncDirectorySync(dirname(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function writeSessionDisplayMetadata(sessionFile: string, metadata: SessionDisplayMetadata): void {
	assertValidSessionId(metadata.sessionId);
	const name = metadata.name?.replace(/[\r\n]+/g, " ").trim();
	const contents = `${JSON.stringify({ version: 1, sessionId: metadata.sessionId, name: name || null })}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_SESSION_DISPLAY_METADATA_BYTES) {
		throw new Error("Session display metadata exceeds its size limit");
	}
	replaceFileAtomicallySync(getSessionDisplayMetadataPath(sessionFile), contents, { mode: 0o600 });
}

export function migrateSessionDisplayMetadata(
	sessionFile: string,
	expected: SessionDisplayMetadata & {
		readonly dev: number;
		readonly ino: number;
		readonly size: number;
		readonly mtimeMs: number;
		readonly ctimeMs: number;
	},
): boolean {
	let lease: SessionLease;
	try {
		lease = SessionLease.acquireTransient(sessionFile);
	} catch {
		return false;
	}
	let migrated = false;
	try {
		const current = lstatSync(sessionFile);
		if (
			!current.isFile() ||
			current.isSymbolicLink() ||
			current.nlink !== 1 ||
			current.dev !== expected.dev ||
			current.ino !== expected.ino ||
			current.size !== expected.size ||
			current.mtimeMs !== expected.mtimeMs ||
			current.ctimeMs !== expected.ctimeMs
		) {
			return false;
		}
		writeSessionDisplayMetadata(sessionFile, expected);
		migrated = true;
	} catch {
		return false;
	} finally {
		try {
			lease.close();
		} catch {
			migrated = false;
		}
	}
	return migrated;
}

/** Root-session-owned directory for Agent System v2 child session journals. */
export function getSessionAgentDir(agentDir: string, rootSessionId: string): string {
	assertValidSessionId(rootSessionId);
	return join(resolvePath(agentDir), "agents", rootSessionId);
}

/**
 * Move one persisted session while holding its writer lease.
 *
 * The caller is responsible for constraining both paths to its catalog roots.
 * This primitive rejects aliases and replacement races, publishes the move with
 * one filesystem rename, and syncs both parent directories before returning.
 */
export function moveSessionFileWithLease(sourcePath: string, destinationPath: string): void {
	const unresolvedSource = resolvePath(sourcePath);
	const unresolvedDestination = resolvePath(destinationPath);
	const sourceBeforeCanonicalization = lstatSync(unresolvedSource);
	if (!sourceBeforeCanonicalization.isFile() || sourceBeforeCanonicalization.nlink !== 1) {
		throw new Error("Session source must be a single-link regular file");
	}

	const source = canonicalPath(unresolvedSource);
	const destination = canonicalPath(unresolvedDestination);
	if (source === destination) throw new Error("Session source and destination must differ");
	try {
		lstatSync(destination);
		throw new Error("Session destination already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const destinationDirectory = dirname(destination);
	ensureRealDirectoryDurablySync(destinationDirectory);
	const expected = lstatSync(source);
	if (!expected.isFile() || expected.nlink !== 1) {
		throw new Error("Session source must be a single-link regular file");
	}

	const lease = SessionLease.acquire(source);
	try {
		lease.withWritePermit(() => {
			const current = lstatSync(source);
			if (!current.isFile() || current.nlink !== 1 || current.dev !== expected.dev || current.ino !== expected.ino) {
				throw new Error("Session source changed before it could be moved");
			}
			try {
				lstatSync(destination);
				throw new Error("Session destination already exists");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}

			const metadata = readSessionDisplayMetadata(source);
			const header = readSessionRecordsReadOnly(source, { followSymlinkAlias: false }).records[0] as SessionHeader;
			const unread = readSessionUnreadState(source, header.id);
			removeSessionDisplayMetadata(destination);
			removeSessionUnreadState(destination);
			if (metadata) writeSessionDisplayMetadata(destination, metadata);
			if (unread) writeSessionUnreadState(destination, header.id);
			try {
				renameSync(source, destination);
			} catch (error) {
				removeSessionDisplayMetadata(destination);
				removeSessionUnreadState(destination);
				throw error;
			}
			try {
				removeSessionDisplayMetadata(source);
			} catch {
				// Derived metadata at the old path is harmless; the destination is authoritative.
			}
			try {
				removeSessionUnreadState(source);
			} catch {
				// The destination copy is authoritative after the journal move.
			}
			const sourceDirectory = dirname(source);
			syncDirectorySync(sourceDirectory);
			if (destinationDirectory !== sourceDirectory) syncDirectorySync(destinationDirectory);
		});
	} finally {
		lease.close();
	}
}

function getImageStoreDir(sessionFile: string): string {
	return getSessionImageDir(sessionFile);
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "image" &&
		typeof (value as { data?: unknown }).data === "string" &&
		typeof (value as { mimeType?: unknown }).mimeType === "string"
	);
}

function containsExternalizableImage(value: unknown): boolean {
	let found = false;
	JSON.stringify(value, (_key, candidate) => {
		if (found || !isImageContent(candidate) || !imageExtension(candidate.mimeType)) return candidate;
		try {
			const size = Buffer.from(candidate.data, "base64").byteLength;
			found = size > 0 && size <= MAX_SESSION_IMAGE_BLOB_BYTES;
		} catch {
			// The serializer will keep invalid image data inline.
		}
		return candidate;
	});
	return found;
}

function isImageReference(value: unknown): value is ImageReference {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "image_ref" &&
		typeof (value as { hash?: unknown }).hash === "string" &&
		typeof (value as { mimeType?: unknown }).mimeType === "string" &&
		((value as { size?: unknown }).size === undefined ||
			(typeof (value as { size?: unknown }).size === "number" &&
				Number.isSafeInteger((value as { size: number }).size) &&
				(value as { size: number }).size > 0))
	);
}

function hasImageReferenceTag(value: unknown): value is { type: "image_ref" } {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "image_ref";
}

function readOwnedRegularFile(
	filePath: string,
	options: { expectedSize?: number; maxBytes?: number; budget?: ImageReadBudget } = {},
): Buffer {
	const before = lstatSync(filePath);
	if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe image asset");
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
	try {
		const opened = fstatSync(fd);
		const current = lstatSync(filePath);
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			!current.isFile() ||
			current.nlink !== 1 ||
			opened.dev !== current.dev ||
			opened.ino !== current.ino
		) {
			throw new Error("unsafe image asset");
		}
		if (options.maxBytes !== undefined && opened.size > options.maxBytes) {
			throw new Error("image asset exceeds its read limit");
		}
		if (options.expectedSize !== undefined && opened.size !== options.expectedSize) {
			throw new Error("image asset size mismatch");
		}
		if (options.budget) {
			if (options.budget.used + opened.size > options.budget.limit) {
				throw new Error("image assets exceed their cumulative read limit");
			}
			options.budget.used += opened.size;
		}
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (count === 0) throw new Error("image asset was truncated while reading");
			offset += count;
		}
		const afterOpened = fstatSync(fd);
		const afterPath = lstatSync(filePath);
		if (
			!afterOpened.isFile() ||
			afterOpened.nlink !== 1 ||
			!afterPath.isFile() ||
			afterPath.nlink !== 1 ||
			afterOpened.dev !== opened.dev ||
			afterOpened.ino !== opened.ino ||
			afterOpened.size !== opened.size ||
			afterPath.dev !== opened.dev ||
			afterPath.ino !== opened.ino ||
			afterPath.size !== opened.size
		) {
			throw new Error("image asset changed while reading");
		}
		return bytes;
	} finally {
		closeSync(fd);
	}
}

function assertSafeSessionAssetRoot(assetDir: string): void {
	const assetRoot = dirname(assetDir);
	try {
		if (!lstatSync(assetRoot).isDirectory()) {
			throw new Error(`Session asset root is not a real directory: ${assetRoot}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function assertSafeSessionAssetDirectory(assetDir: string): void {
	assertSafeSessionAssetRoot(assetDir);
	try {
		if (!lstatSync(assetDir).isDirectory()) {
			throw new Error(`Session asset directory is not a real directory: ${assetDir}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function ensureSessionAssetDirectory(assetDir: string): void {
	assertSafeSessionAssetRoot(assetDir);
	ensureRealDirectoryDurablySync(assetDir);
	assertSafeSessionAssetDirectory(assetDir);
}

export interface PersistedSessionImage {
	path: string;
	hash: string;
	mimeType: string;
	size: number;
}

function writeHashedSessionImage(imageDir: string, image: ImageContent): PersistedSessionImage {
	const extension = imageExtension(image.mimeType);
	if (!extension) throw new Error(`Unsupported image mime type: ${image.mimeType}`);
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length === 0 || bytes.length > MAX_SESSION_IMAGE_BLOB_BYTES) {
		throw new Error("Image blob is empty or exceeds the session image size limit");
	}
	const hash = createHash("sha256").update(bytes).digest("hex");
	ensureSessionAssetDirectory(imageDir);
	const imagePath = join(imageDir, `${hash}.${extension}`);
	try {
		createFileAtomicallySync(imagePath, bytes, { mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const storedBytes = readOwnedRegularFile(imagePath, {
			expectedSize: bytes.length,
			maxBytes: MAX_SESSION_IMAGE_BLOB_BYTES,
		});
		if (createHash("sha256").update(storedBytes).digest("hex") !== hash) {
			throw new Error("stored image hash mismatch");
		}
	}
	return { path: imagePath, hash, mimeType: image.mimeType, size: bytes.length };
}

function externalizeImage(image: ImageContent, imageDir: string): ImageContent | ImageReference {
	try {
		const saved = writeHashedSessionImage(imageDir, image);
		return { type: "image_ref", hash: saved.hash, mimeType: saved.mimeType, size: saved.size };
	} catch {
		return image;
	}
}

function hydrateImage(
	reference: ImageReference,
	imageDir: string,
	budget: ImageReadBudget,
): ImageContent | TextContent {
	const extension = imageExtension(reference.mimeType);
	if (!extension || !/^[a-f0-9]{64}$/.test(reference.hash)) {
		return { type: "text", text: "[Image unavailable: invalid image reference]" };
	}

	try {
		const bytes = readOwnedRegularFile(join(imageDir, `${reference.hash}.${extension}`), {
			expectedSize: reference.size,
			maxBytes: MAX_SESSION_IMAGE_BLOB_BYTES,
			budget,
		});
		if (createHash("sha256").update(bytes).digest("hex") !== reference.hash) throw new Error("hash mismatch");
		return { type: "image", data: bytes.toString("base64"), mimeType: reference.mimeType };
	} catch {
		return { type: "text", text: `[Image unavailable: ${reference.hash}]` };
	}
}

function visitReferencedImagesStrictly(
	records: readonly FileEntry[],
	storagePath: string,
	visit: (assetKey: string, bytes: Buffer) => void,
): void {
	const imageDir = getSessionAssetDirFromStoragePath(storagePath, "images");
	const visited = new Map<string, number>();
	const imageBudget: ImageReadBudget = { used: 0, limit: MAX_SESSION_IMAGE_BLOB_BYTES };
	const pending: unknown[] = [records];

	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== "object" || value === null) continue;
		if ((value as { type?: unknown }).type !== "image_ref") {
			for (const child of Object.values(value)) pending.push(child);
			continue;
		}
		if (!isImageReference(value)) throw new Error("Invalid image reference");

		const extension = imageExtension(value.mimeType);
		if (!extension || !/^[a-f0-9]{64}$/.test(value.hash)) {
			throw new Error("Invalid image reference");
		}
		const assetKey = `${value.hash}.${extension}`;
		const visitedSize = visited.get(assetKey);
		if (visitedSize !== undefined) {
			if (value.size !== undefined && value.size !== visitedSize) {
				throw new Error(`Image asset size mismatch: ${value.hash}`);
			}
			continue;
		}

		assertSafeSessionAssetDirectory(imageDir);
		const bytes = readOwnedRegularFile(join(imageDir, assetKey), {
			expectedSize: value.size,
			maxBytes: MAX_SESSION_IMAGE_BLOB_BYTES,
			budget: imageBudget,
		});
		if (createHash("sha256").update(bytes).digest("hex") !== value.hash) {
			throw new Error(`Image asset hash mismatch: ${value.hash}`);
		}
		visit(assetKey, bytes);
		visited.set(assetKey, bytes.length);
	}
}

function copyReferencedImagesStrictly(
	records: readonly FileEntry[],
	sourceStoragePath: string,
	destinationStoragePath: string,
): void {
	const destinationImageDir = getSessionAssetDirFromStoragePath(destinationStoragePath, "images");

	visitReferencedImagesStrictly(records, sourceStoragePath, (assetKey, bytes) => {
		ensureSessionAssetDirectory(destinationImageDir);
		const destinationImagePath = join(destinationImageDir, assetKey);
		try {
			createFileAtomicallySync(destinationImagePath, bytes, { mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const storedBytes = readOwnedRegularFile(destinationImagePath, {
				expectedSize: bytes.length,
				maxBytes: MAX_SESSION_IMAGE_BLOB_BYTES,
			});
			if (!storedBytes.equals(bytes)) {
				throw new Error(`Destination image asset mismatch: ${assetKey}`);
			}
		}
	});
}

function ownedToolOutputPath(path: string, storagePath: string): string | undefined {
	const outputDir = getSessionAssetDirFromStoragePath(storagePath, "tool-results");
	const resolved = resolve(path);
	return dirname(resolved) === resolve(outputDir) ? resolved : undefined;
}

function rewriteToolOutputPath(entry: SessionMessageEntry, sourcePath: string, destinationPath: string): void {
	if (entry.toolOutput?.fullOutputPath === sourcePath) {
		entry.toolOutput = { ...entry.toolOutput, fullOutputPath: destinationPath };
	}
	if (entry.message.role === "toolResult") {
		const details = entry.message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			!Array.isArray(details) &&
			(details as { fullOutputPath?: unknown }).fullOutputPath === sourcePath
		) {
			entry.message.details = { ...details, fullOutputPath: destinationPath };
		}
		entry.message.content = entry.message.content.map((block) =>
			block.type === "text" ? { ...block, text: block.text.split(sourcePath).join(destinationPath) } : block,
		);
	}
	if (entry.message.role === "bashExecution" && entry.message.fullOutputPath === sourcePath) {
		entry.message.fullOutputPath = destinationPath;
	}
}

function copyReferencedToolOutputsStrictly(
	records: readonly FileEntry[],
	sourceStoragePath: string,
	destinationStoragePath: string,
): FileEntry[] {
	const rewritten = structuredClone(records) as FileEntry[];
	const sourceDir = getSessionAssetDirFromStoragePath(sourceStoragePath, "tool-results");
	const destinationDir = getSessionAssetDirFromStoragePath(destinationStoragePath, "tool-results");
	const copied = new Map<string, string>();

	for (const record of rewritten) {
		if (record.type !== "message") continue;
		const candidates = new Set<string>();
		if (record.toolOutput?.fullOutputPath) candidates.add(record.toolOutput.fullOutputPath);
		if (record.message.role === "toolResult") {
			const details = record.message.details;
			if (typeof details === "object" && details !== null && !Array.isArray(details)) {
				const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
				if (typeof path === "string") candidates.add(path);
			}
		}
		if (record.message.role === "bashExecution" && record.message.fullOutputPath) {
			candidates.add(record.message.fullOutputPath);
		}

		for (const candidate of candidates) {
			const sourcePath = ownedToolOutputPath(candidate, sourceStoragePath);
			if (!sourcePath) continue;
			let destinationPath = copied.get(sourcePath);
			if (!destinationPath) {
				assertSafeSessionAssetDirectory(sourceDir);
				const before = lstatSync(sourcePath);
				if (!before.isFile() || before.nlink !== 1) throw new Error(`Unsafe tool output source: ${sourcePath}`);
				ensureSessionAssetDirectory(destinationDir);
				destinationPath = join(destinationDir, basename(sourcePath));
				copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
				const after = lstatSync(sourcePath);
				const destination = lstatSync(destinationPath);
				if (
					!after.isFile() ||
					after.nlink !== 1 ||
					after.dev !== before.dev ||
					after.ino !== before.ino ||
					after.size !== before.size ||
					!destination.isFile() ||
					destination.nlink !== 1 ||
					destination.size !== before.size
				) {
					throw new Error(`Tool output changed while copying: ${sourcePath}`);
				}
				const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
				const destinationFd = openSync(destinationPath, fsConstants.O_RDWR | noFollow);
				try {
					const opened = fstatSync(destinationFd);
					const current = lstatSync(destinationPath);
					if (
						!opened.isFile() ||
						opened.nlink !== 1 ||
						!current.isFile() ||
						current.nlink !== 1 ||
						opened.dev !== current.dev ||
						opened.ino !== current.ino ||
						opened.size !== before.size
					) {
						throw new Error(`Unsafe copied tool output: ${destinationPath}`);
					}
					fchmodSync(destinationFd, 0o600);
					fsyncSync(destinationFd);
				} finally {
					closeSync(destinationFd);
				}
				assertSafeSessionAssetDirectory(sourceDir);
				assertSafeSessionAssetDirectory(destinationDir);
				syncDirectorySync(destinationDir);
				copied.set(sourcePath, destinationPath);
			}
			rewriteToolOutputPath(record, candidate, destinationPath);
		}
	}

	return rewritten;
}

export function stringifySessionEntry(entry: unknown, sessionFile: string): string {
	const imageDir = getImageStoreDir(sessionFile);
	return stringifySessionEntryWithImageDir(entry, imageDir);
}

function stringifySessionEntryWithImageDir(entry: unknown, imageDir: string): string {
	return JSON.stringify(entry, (_key, value) => (isImageContent(value) ? externalizeImage(value, imageDir) : value));
}

function prepareDurableRecord(record: FileEntry, storagePath: string): FileEntry {
	return JSON.parse(
		stringifySessionEntryWithImageDir(record, getSessionAssetDirFromStoragePath(storagePath, "images")),
	) as FileEntry;
}

function prepareDurableRecords(records: readonly FileEntry[], storagePath: string): FileEntry[] {
	return records.map((record) => prepareDurableRecord(record, storagePath));
}

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	mode?: AgentMode;
	cwdOrigin?: CwdOrigin;
	permissionPreset?: PermissionPreset;
	parentSession?: string;
	agent?: {
		agentId: string;
		name: string;
		parentSessionId: string;
		rootSessionId: string;
		agentPath: readonly string[];
		agentType: string;
		tools: readonly string[];
		writePolicy: "inherit" | "deny";
		permissionPreset: PermissionPreset;
		model: { provider: string; modelId: string };
		thinkingLevel: ThinkingLevel;
		cwd: string;
		forkTurns: number | "all";
		timeoutSeconds: number;
		mayDelegate: boolean;
		initialTask: string;
	};
	scheduled?: {
		taskId: string;
		runId: string;
	};
}

export type { CwdOrigin } from "./session-workspace.ts";

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	mode?: AgentMode;
	cwdOrigin?: CwdOrigin;
	permissionPreset?: PermissionPreset;
	agent?: SessionHeader["agent"];
	scheduled?: SessionHeader["scheduled"];
}

export interface ImportSessionOptions {
	destinationMode?: "replace" | "create-exclusive";
}

export interface DeleteSessionResult {
	ok: boolean;
	method: "trash" | "unlink";
	code?: "SESSION_IN_USE" | "OPERATION_FAILED";
	error?: string;
	warning?: string;
}

function isSafeRelativePath(value: string): boolean {
	return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export function sessionStoragePathVariants(storagePath: string, sessionsRoot: string | undefined): readonly string[] {
	if (!sessionsRoot) return [storagePath];
	const root = canonicalPath(resolvePath(sessionsRoot));
	const archiveRoot = join(root, ".archive");
	const archivedRelative = relative(archiveRoot, storagePath);
	if (isSafeRelativePath(archivedRelative)) {
		return [join(root, archivedRelative), join(archiveRoot, archivedRelative)];
	}
	const activeRelative = relative(root, storagePath);
	if (isSafeRelativePath(activeRelative) && !activeRelative.startsWith(`.archive${sep}`)) {
		return [join(root, activeRelative), join(archiveRoot, activeRelative)];
	}
	return [storagePath];
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
	toolOutput?: PersistedToolOutput;
	turnId?: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** True if generated by an extension, undefined/false if metis-generated (backward compatible) */
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** True if generated by an extension, false if metis-generated */
	fromHook?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content is converted to a user message in buildSessionContext().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

/** Raw file entry (includes header and journal-only control records). */
export type FileEntry = SessionHeader | SessionEntry | RuntimeControlEntry | SessionControlEntry;

type RuntimePayload<Entry> = Entry extends RuntimeControlEntry ? Omit<Entry, "id" | "parentId" | "timestamp"> : never;

/** Runtime control data accepted by SessionManager; journal metadata is manager-owned. */
export type RuntimeControlPayload = RuntimePayload<RuntimeControlEntry>;

export interface PermissionDecisionPayload {
	readonly actionId: string;
	readonly toolName: string;
	readonly source: PermissionDecisionSource;
	readonly decision: "allow" | "deny";
	readonly reason?: string;
}

export interface WorkspaceDirectoryChange {
	readonly path: string;
	readonly changed: boolean;
}

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** Immutable session classification. Missing legacy values resolve to code. */
	mode: AgentMode;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	/** Scheduled execution identity. These sessions are visible but read-only. */
	scheduled?: { taskId: string; runId: string };
	created: Date;
	modified: Date;
	/** Zero is a not-loaded sentinel when `scheduled` is present. */
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "getHeader"
	| "getMode"
	| "getCwdOrigin"
	| "getPermissionPreset"
	| "getPermissionSettings"
	| "getUltraSelected"
	| "getAdditionalDirectories"
	| "getWorkspaceRoots"
	| "getDurableJournalSnapshot"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function deepFreeze<T>(value: T): T {
	const pending: object[] = [];
	if (typeof value === "object" && value !== null) pending.push(value);
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const child of Object.values(current)) {
			if (typeof child === "object" && child !== null) pending.push(child);
		}
		Object.freeze(current);
	}
	return value;
}

function readonlySessionSnapshot(manager: SessionManager): ReadonlySessionManager {
	return Object.freeze({
		getCwd: () => manager.getCwd(),
		getSessionDir: () => manager.getSessionDir(),
		getSessionId: () => manager.getSessionId(),
		getSessionFile: () => manager.getSessionFile(),
		getLeafId: () => manager.getLeafId(),
		getLeafEntry: () => manager.getLeafEntry(),
		getEntry: (id: string) => manager.getEntry(id),
		getLabel: (id: string) => manager.getLabel(id),
		getBranch: (fromId?: string) => manager.getBranch(fromId),
		buildContextEntries: () => manager.buildContextEntries(),
		getHeader: () => manager.getHeader(),
		getMode: () => manager.getMode(),
		getCwdOrigin: () => manager.getCwdOrigin(),
		getPermissionPreset: () => manager.getPermissionPreset(),
		getPermissionSettings: () => manager.getPermissionSettings(),
		getUltraSelected: () => manager.getUltraSelected(),
		getAdditionalDirectories: () => manager.getAdditionalDirectories(),
		getWorkspaceRoots: () => manager.getWorkspaceRoots(),
		getDurableJournalSnapshot: () => manager.getDurableJournalSnapshot(),
		getEntries: () => manager.getEntries(),
		getTree: () => manager.getTree(),
		getSessionName: () => manager.getSessionName(),
	});
}

export { assertValidSessionId } from "./session-id.ts";

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	for (let i = 0; i < 100; i++) {
		const id = randomUUID();
		if (!byId.has(id)) return id;
	}
	throw new Error("Unable to generate a unique session record id");
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		const treeEntry = entry as SessionEntry;
		treeEntry.id = generateId(ids);
		ids.add(treeEntry.id);
		treeEntry.parentId = prevId;
		prevId = treeEntry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/** Migrate v3 → v4: externalize inline images when the session is rewritten. */
function migrateV3ToV4(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 4;
	}
}

/** Migrate v4 → v5: reserve journal-only runtime control records. */
function migrateV4ToV5(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 5;
	}
}

/** Migrate v5 → v6: reserve journal-only session permission controls. */
function migrateV5ToV6(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 6;
	}
}

/** Migrate v6 → v7: reserve child markers and first-class subagent controls. */
function migrateV6ToV7(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 7;
	}
}

/** Migrate v7 → v8: reserve Code-session additional-directory controls. */
function migrateV7ToV8(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 8;
	}
}

/** Migrate v8 → v9: reserve policy-owned unattended permission decisions. */
function migrateV8ToV9(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 9;
	}
}

/** Migrate v9 → v10: reserve hidden scheduled-session ownership markers. */
function migrateV9ToV10(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 10;
	}
}

/** Migrate v10 → v11: reserve the retired child mailbox control range. */
function migrateV10ToV11(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 11;
	}
}

/** Migrate v11 → v12: reserve durable Plan collaboration controls. */
function migrateV11ToV12(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 12;
	}
}

/** Migrate v12 → v13: reserve canonical Agent/Task controls. */
function migrateV12ToV13(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 13;
	}
}

/** Convert known v13 permission fields, then stamp the current session version. */
function migrateLegacyPermissionFields(
	value: Record<string, unknown>,
	filePath: string,
	lineNumber: number,
	fallback?: PermissionPreset,
): void {
	const legacy = value.permissionMode;
	const current = value.permissionPreset;
	if (legacy !== undefined && !isPermissionPreset(legacy)) {
		corruptSession(filePath, lineNumber, "Legacy permission mode is invalid");
	}
	if (current !== undefined && !isPermissionPreset(current)) {
		corruptSession(filePath, lineNumber, "Permission preset is invalid");
	}
	if (legacy !== undefined && current !== undefined && legacy !== current) {
		corruptSession(filePath, lineNumber, "Legacy and current permission settings conflict");
	}
	if (value.reviewerEnabled !== undefined && typeof value.reviewerEnabled !== "boolean") {
		corruptSession(filePath, lineNumber, "Legacy reviewer setting is invalid");
	}
	const permissionPreset = current ?? legacy ?? fallback;
	if (!isPermissionPreset(permissionPreset)) {
		corruptSession(filePath, lineNumber, "Legacy permission setting is missing");
	}
	value.permissionPreset = permissionPreset;
	delete value.permissionMode;
	delete value.reviewerEnabled;
}

function migrateLegacySessionPermissionsRecord(
	value: Record<string, unknown>,
	filePath: string,
	lineNumber: number,
): void {
	const keys = Object.keys(value);
	const allowed = new Set(["type", "id", "parentId", "timestamp", "permissionMode", "reviewerEnabled"]);
	if (keys.some((key) => !allowed.has(key))) {
		corruptSession(filePath, lineNumber, "Legacy permission control has an unsupported field");
	}
	for (const key of ["type", "id", "parentId", "timestamp", "permissionMode"]) {
		if (!Object.hasOwn(value, key)) {
			corruptSession(filePath, lineNumber, "Legacy permission control is missing a required field");
		}
	}
	migrateLegacyPermissionFields(value, filePath, lineNumber);
	value.type = "session_permission_preset";
}

function migrateLegacyPermissionJournalRecord(
	value: Record<string, unknown>,
	filePath: string,
	lineNumber: number,
): void {
	if (value.type === "session_permissions") {
		migrateLegacySessionPermissionsRecord(value, filePath, lineNumber);
		return;
	}
	if (value.type === "session_permission_decision") {
		value.type = "session_permission_audit";
	}
}

function migrateV13ToV14(entries: FileEntry[], filePath: string): void {
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index] as unknown as Record<string, unknown>;
		const lineNumber = index + 1;
		if (entry.type === "session") {
			migrateLegacyPermissionFields(entry, filePath, lineNumber, DEFAULT_PERMISSION_PRESET);
			if (isJsonObject(entry.agent)) {
				migrateLegacyPermissionFields(entry.agent, filePath, lineNumber);
			}
			entry.version = 14;
			continue;
		}
		migrateLegacyPermissionJournalRecord(entry, filePath, lineNumber);
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[], filePath: string): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;
	if (
		version < 5 &&
		entries.some(
			(entry) => entry.type !== "session" && typeof entry.type === "string" && entry.type.startsWith("runtime_"),
		)
	) {
		throw new TypeError("Runtime control entries require a v5 session header");
	}
	if (
		version < 14 &&
		entries.some((entry) => entry.type === "session_permission_preset" || entry.type === "session_permission_audit")
	) {
		throw new TypeError("Permission control entries require a v14 session header");
	}
	if (version < 8 && entries.some((entry) => isSessionDirectoryControlEntryType(entry.type))) {
		throw new TypeError("Directory control entries require a v8 session header");
	}
	if (version < 10 && header?.scheduled !== undefined) {
		throw new TypeError("Scheduled session markers require a v10 session header");
	}
	if (version < 12 && entries.some((entry) => isPlanControlEntryType(entry.type))) {
		throw new TypeError("Plan control entries require a v12 session header");
	}

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4(entries);
	if (version < 5) migrateV4ToV5(entries);
	if (version < 6) migrateV5ToV6(entries);
	if (version < 7) migrateV6ToV7(entries);
	if (version < 8) migrateV7ToV8(entries);
	if (version < 9) migrateV8ToV9(entries);
	if (version < 10) migrateV9ToV10(entries);
	if (version < 11) migrateV10ToV11(entries);
	if (version < 12) migrateV11ToV12(entries);
	if (version < 13) migrateV12ToV13(entries);
	if (version < 14) migrateV13ToV14(entries, filePath);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries, "<memory>");
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.trim().split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as FileEntry);
		} catch {
			// Keep this compatibility parser tolerant; durable reads use SessionJournal.
		}
	}
	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

function latestCompactedTasksMessage(path: SessionEntry[], contextEntries: SessionEntry[]): AgentMessage | undefined {
	if (!contextEntries.some(({ type }) => type === "compaction")) return undefined;

	let latest: SessionMessageEntry | undefined;
	let latestContent: (TextContent | ImageContent)[] = [];
	let latestTasks: unknown;
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (
			entry?.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "set_tasks" &&
			entry.message.isError === false
		) {
			latest = entry;
			latestContent = entry.message.content ?? [];
			const details = entry.message.details;
			latestTasks =
				typeof details === "object" && details !== null ? (details as { tasks?: unknown }).tasks : undefined;
			break;
		}
	}
	if (!latest || contextEntries.some(({ id }) => id === latest.id)) return undefined;
	if (
		!Array.isArray(latestTasks) ||
		!latestTasks.some(
			(task) => typeof task === "object" && task !== null && (task as { completed?: unknown }).completed === false,
		)
	) {
		return undefined;
	}

	return createCustomMessage("latest_tasks", latestContent, false, undefined, latest.timestamp);
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const contextEntries = buildContextEntries(entries, leafId, byId);
	const messages = contextEntries.flatMap(sessionEntryToContextMessages);
	const latestTasks = latestCompactedTasksMessage(path, contextEntries);
	if (latestTasks) messages.splice(1, 0, latestTasks);
	return { messages, thinkingLevel, model };
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.metis/agent/sessions/.
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedAgentDir = resolvePath(agentDir);
	return join(resolvedAgentDir, "sessions", encodePathForStorage(cwd));
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	ensureDirectoryDurablySync(sessionDir);
	return sessionDir;
}

interface PreparedRecords {
	records: FileEntry[];
	migrated: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corruptSession(filePath: string, lineNumber: number, message: string): never {
	throw new CorruptSessionError(filePath, lineNumber, message);
}

function validateRawSessionRecord(record: unknown, index: number, filePath: string): Record<string, unknown> {
	if (!isJsonObject(record) || typeof record.type !== "string" || record.type.length === 0) {
		corruptSession(filePath, index + 1, "Session record must be a JSON object with a type");
	}
	if (index === 0 && record.type !== "session") {
		corruptSession(filePath, 1, `Session file is not a valid metis session: ${filePath}`);
	}
	if (index > 0 && record.type === "session") {
		corruptSession(filePath, index + 1, "Session journal contains more than one header");
	}
	return record;
}

function validateSessionHeader(record: Record<string, unknown>, filePath: string): SessionHeader {
	const header = record as unknown as SessionHeader;
	const headerFields = new Set([
		"type",
		"version",
		"id",
		"timestamp",
		"cwd",
		"mode",
		"cwdOrigin",
		"permissionPreset",
		"parentSession",
		"agent",
		"scheduled",
	]);
	if (Object.keys(record).some((field) => !headerFields.has(field))) {
		corruptSession(filePath, 1, "Session header contains an unsupported field");
	}
	try {
		assertValidSessionId(header.id);
	} catch (error) {
		throw new CorruptSessionError(filePath, 1, "Session header has an invalid id", { cause: error });
	}
	if (typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))) {
		corruptSession(filePath, 1, "Session header has an invalid timestamp");
	}
	if (typeof header.cwd !== "string") {
		corruptSession(filePath, 1, "Session header has an invalid cwd");
	}
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		corruptSession(filePath, 1, "Session header has an invalid parentSession");
	}
	if (header.mode !== undefined && !isAgentMode(header.mode)) {
		corruptSession(filePath, 1, "Session header has an invalid mode");
	}
	if (header.cwdOrigin !== undefined && header.cwdOrigin !== "managed" && header.cwdOrigin !== "user-selected") {
		corruptSession(filePath, 1, "Session header has an invalid cwdOrigin");
	}
	if (record.permissionPreset !== undefined && !isPermissionPreset(record.permissionPreset)) {
		corruptSession(filePath, 1, "Session header has an invalid permissionPreset");
	}
	if (header.agent !== undefined) {
		if (!isJsonObject(header.agent)) corruptSession(filePath, 1, "Session header has an invalid agent marker");
		const agent = header.agent;
		const agentFields = new Set([
			"agentId",
			"name",
			"parentSessionId",
			"rootSessionId",
			"agentPath",
			"agentType",
			"tools",
			"writePolicy",
			"permissionPreset",
			"model",
			"thinkingLevel",
			"cwd",
			"forkTurns",
			"timeoutSeconds",
			"mayDelegate",
			"initialTask",
		]);
		if (Object.keys(agent).some((field) => !agentFields.has(field))) {
			corruptSession(filePath, 1, "Session header agent marker contains an unsupported field");
		}
		try {
			assertValidSessionId(agent.agentId);
			assertValidSessionId(agent.parentSessionId);
			assertValidSessionId(agent.rootSessionId);
		} catch (error) {
			throw new CorruptSessionError(filePath, 1, "Session header has an invalid agent id", { cause: error });
		}
		if (agent.agentId !== header.id) corruptSession(filePath, 1, "Session header agent id must match session id");
		if (
			typeof agent.name !== "string" ||
			agent.name.length < 1 ||
			agent.name.length > 128 ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(agent.name)
		) {
			corruptSession(filePath, 1, "Session header has an invalid agent name");
		}
		if (!Array.isArray(agent.agentPath) || agent.agentPath.length < 1 || agent.agentPath.length > 2) {
			corruptSession(filePath, 1, "Session header has an invalid agent path");
		}
		if (agent.agentPath.at(-1) !== agent.agentId) {
			corruptSession(filePath, 1, "Session header agent path must end with agent id");
		}
		if (typeof agent.agentType !== "string" || !isValidAgentTypeId(agent.agentType)) {
			corruptSession(filePath, 1, "Session header has an invalid agent type");
		}
		if (agent.writePolicy !== "inherit" && agent.writePolicy !== "deny") {
			corruptSession(filePath, 1, "Session header has an invalid agent write policy");
		}
		if (!isPermissionPreset(agent.permissionPreset)) {
			corruptSession(filePath, 1, "Session header has an invalid agent permission preset");
		}
		if (
			!isJsonObject(agent.model) ||
			typeof agent.model.provider !== "string" ||
			typeof agent.model.modelId !== "string"
		) {
			corruptSession(filePath, 1, "Session header has an invalid agent model");
		}
		if (typeof agent.cwd !== "string" || !isAbsolute(agent.cwd) || normalize(agent.cwd) !== agent.cwd) {
			corruptSession(filePath, 1, "Session header has an invalid agent cwd");
		}
		if (
			agent.forkTurns !== "all" &&
			(!Number.isInteger(agent.forkTurns) || agent.forkTurns < 0 || agent.forkTurns > 1_000)
		) {
			corruptSession(filePath, 1, "Session header has an invalid agent forkTurns");
		}
		if (!Number.isInteger(agent.timeoutSeconds) || agent.timeoutSeconds < 1 || agent.timeoutSeconds > 1_800) {
			corruptSession(filePath, 1, "Session header has an invalid agent timeout");
		}
		if (typeof agent.mayDelegate !== "boolean") {
			corruptSession(filePath, 1, "Session header has an invalid agent delegation flag");
		}
		if (typeof agent.initialTask !== "string" || agent.initialTask.length < 1) {
			corruptSession(filePath, 1, "Session header has an invalid agent initial task");
		}
		if (!Array.isArray(agent.tools) || agent.tools.length > 128) {
			corruptSession(filePath, 1, "Session header has invalid agent tools");
		}
	}
	if (header.scheduled !== undefined) {
		if (!isJsonObject(header.scheduled))
			corruptSession(filePath, 1, "Session header has an invalid scheduled marker");
		const fields = Object.keys(header.scheduled);
		if (fields.length !== 2 || !fields.includes("taskId") || !fields.includes("runId")) {
			corruptSession(filePath, 1, "Session header has an invalid scheduled marker");
		}
		try {
			assertValidSessionId(header.scheduled.taskId);
			assertValidSessionId(header.scheduled.runId);
		} catch (error) {
			throw new CorruptSessionError(filePath, 1, "Session header has an invalid scheduled id", { cause: error });
		}
		if (header.agent !== undefined) {
			corruptSession(filePath, 1, "Session header cannot be both scheduled and an agent");
		}
	}
	const version = header.version ?? 1;
	if (!Number.isInteger(version) || version < 1) {
		corruptSession(filePath, 1, "Session header has an invalid version");
	}
	if (version > CURRENT_SESSION_VERSION) {
		corruptSession(
			filePath,
			1,
			`Session version ${version} is newer than supported version ${CURRENT_SESSION_VERSION}`,
		);
	}
	if (version < 6 && (header.cwdOrigin !== undefined || record.permissionPreset !== undefined)) {
		corruptSession(filePath, 1, "Workspace and permission header fields require a v6 session header");
	}
	if (version >= 14 && !isPermissionPreset(header.permissionPreset)) {
		corruptSession(filePath, 1, "Current session header requires permissionPreset");
	}
	if (version < 10 && header.scheduled !== undefined) {
		corruptSession(filePath, 1, "Scheduled header fields require a v10 session header");
	}
	if (version < 13 && header.agent !== undefined) {
		corruptSession(filePath, 1, "Agent header fields require a v13 session header");
	}
	return header;
}

function validateSessionRecordEnvelopes(records: readonly unknown[], filePath: string): void {
	if (records.length === 0) corruptSession(filePath, 1, "Session journal is empty");
	for (let index = 0; index < records.length; index += 1) {
		validateRawSessionRecord(records[index], index, filePath);
	}
}

function validateRawSessionRecords(records: readonly unknown[], filePath: string): SessionHeader {
	validateSessionRecordEnvelopes(records, filePath);
	const header = validateSessionHeader(records[0] as Record<string, unknown>, filePath);
	const version = header.version ?? 1;
	for (let index = 1; index < records.length; index++) {
		const type = (records[index] as { type: string }).type;
		if (type.startsWith("runtime_")) {
			if (version < 5) {
				corruptSession(filePath, index + 1, "Runtime control entries require a v5 session header");
			}
			if (!isRuntimeControlEntryType(type)) {
				corruptSession(filePath, index + 1, `Unknown runtime control entry type: ${type}`);
			}
			parseRuntimeRecord(records[index], index + 1, filePath);
			continue;
		}
		if (isSessionControlEntryType(type)) {
			if ((type === "session_permission_preset" || type === "session_permission_audit") && version < 14) {
				corruptSession(filePath, index + 1, "Permission control entries require a v14 session header");
			}
			if (isSessionDirectoryControlEntryType(type) && version < 8) {
				corruptSession(filePath, index + 1, "Directory control entries require a v8 session header");
			}
			if (isSessionDirectoryControlEntryType(type) && (header.mode ?? DEFAULT_AGENT_MODE) !== "code") {
				corruptSession(filePath, index + 1, "Directory controls are only valid for Code sessions");
			}
			if (isAgentControlEntryType(type) && version < 13) {
				corruptSession(filePath, index + 1, "Agent control entries require a v13 session header");
			}
			if (type === "session_ultra_selection" && version < 13) {
				corruptSession(filePath, index + 1, "Ultra selection controls require a v13 session header");
			}
			if (
				!isAgentControlEntryType(type) &&
				type !== "session_permission_preset" &&
				type !== "session_permission_audit" &&
				version < 6
			) {
				corruptSession(filePath, index + 1, "Session control entries require a v6 session header");
			}
			parseSessionControlRecord(records[index], index + 1, filePath);
			continue;
		}
		if (type.startsWith("session_permission")) {
			corruptSession(filePath, index + 1, `Unknown session control entry type: ${type}`);
		}
		if (type.startsWith("session_directory_")) {
			corruptSession(filePath, index + 1, `Unknown session control entry type: ${type}`);
		}
	}
	return header;
}

function parseRuntimeRecord(record: unknown, lineNumber: number, filePath: string): RuntimeControlEntry {
	try {
		const entry = parseRuntimeControlEntry(record);
		if (!Number.isFinite(Date.parse(entry.timestamp))) {
			corruptSession(filePath, lineNumber, `Runtime control entry ${entry.id} has an invalid timestamp`);
		}
		return entry;
	} catch (error) {
		if (error instanceof CorruptSessionError) throw error;
		throw new CorruptSessionError(filePath, lineNumber, "Invalid runtime control entry", { cause: error });
	}
}

function parseSessionControlRecord(record: unknown, lineNumber: number, filePath: string): SessionControlEntry {
	try {
		const entry = parseSessionControlEntry(record);
		if (!Number.isFinite(Date.parse(entry.timestamp))) {
			corruptSession(filePath, lineNumber, `Session control entry ${entry.id} has an invalid timestamp`);
		}
		return entry;
	} catch (error) {
		if (error instanceof CorruptSessionError) throw error;
		throw new CorruptSessionError(filePath, lineNumber, "Invalid session control entry", { cause: error });
	}
}

function validateRecordId(id: unknown, lineNumber: number, filePath: string, seen: Set<string>): asserts id is string {
	if (typeof id !== "string" || id.length === 0) {
		corruptSession(filePath, lineNumber, "Session entry has an invalid id");
	}
	if (seen.has(id)) {
		corruptSession(filePath, lineNumber, `Session entry id is duplicated: ${id}`);
	}
}

function validateSessionGraphEntry(
	entry: SessionEntry,
	lineNumber: number,
	filePath: string,
	seenRecordIds: Set<string>,
	seenTreeIds: Set<string>,
): void {
	validateRecordId(entry.id, lineNumber, filePath, seenRecordIds);
	if (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length === 0)) {
		corruptSession(filePath, lineNumber, `Session entry ${entry.id} has an invalid parentId`);
	}
	if (entry.parentId === entry.id) {
		corruptSession(filePath, lineNumber, `Session entry ${entry.id} cannot be its own parent`);
	}
	if (entry.parentId !== null && !seenTreeIds.has(entry.parentId)) {
		corruptSession(
			filePath,
			lineNumber,
			`Session entry ${entry.id} references a missing or forward parent: ${entry.parentId}`,
		);
	}
	if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) {
		corruptSession(filePath, lineNumber, `Session entry ${entry.id} has an invalid timestamp`);
	}
	if (entry.type === "label" && (typeof entry.targetId !== "string" || !seenTreeIds.has(entry.targetId))) {
		corruptSession(filePath, lineNumber, `Label ${entry.id} references an unknown target`);
	}
	if (entry.type === "message" && entry.turnId !== undefined && (typeof entry.turnId !== "string" || !entry.turnId)) {
		corruptSession(filePath, lineNumber, `Session message ${entry.id} has an invalid turnId`);
	}
	seenRecordIds.add(entry.id);
	seenTreeIds.add(entry.id);
}

function validateControlGraphEntry(
	entry: RuntimeControlEntry | SessionControlEntry,
	lineNumber: number,
	filePath: string,
	seenRecordIds: Set<string>,
	seenTreeIds: Set<string>,
): void {
	validateRecordId(entry.id, lineNumber, filePath, seenRecordIds);
	if (entry.parentId !== null && !seenTreeIds.has(entry.parentId)) {
		corruptSession(
			filePath,
			lineNumber,
			`Control entry ${entry.id} references a missing, forward, or non-tree parent: ${entry.parentId}`,
		);
	}
	seenRecordIds.add(entry.id);
}

function validateSessionGraph(records: readonly FileEntry[], filePath: string): void {
	validateRawSessionRecords(records, filePath);
	const seenRecordIds = new Set<string>();
	const seenTreeIds = new Set<string>();
	for (let index = 1; index < records.length; index++) {
		const record = records[index];
		if (isRuntimeControlEntryType(record.type)) {
			validateControlGraphEntry(
				parseRuntimeRecord(record, index + 1, filePath),
				index + 1,
				filePath,
				seenRecordIds,
				seenTreeIds,
			);
		} else if (isSessionControlEntryType(record.type)) {
			validateControlGraphEntry(
				parseSessionControlRecord(record, index + 1, filePath),
				index + 1,
				filePath,
				seenRecordIds,
				seenTreeIds,
			);
		} else {
			validateSessionGraphEntry(record as SessionEntry, index + 1, filePath, seenRecordIds, seenTreeIds);
		}
	}
}

function prepareRawSessionRecords(records: readonly unknown[], filePath: string): PreparedRecords {
	validateSessionRecordEnvelopes(records, filePath);
	const copy = structuredClone(records) as FileEntry[];
	const migrated = migrateToCurrentVersion(copy, filePath);
	validateSessionGraph(copy, filePath);
	return { records: copy, migrated };
}

function hydrateSessionRecords(
	records: readonly FileEntry[],
	storagePath: string,
	imageBudget: ImageReadBudget = { used: 0, limit: MAX_SESSION_IMAGE_BLOB_BYTES },
): FileEntry[] {
	const imageDir = getSessionAssetDirFromStoragePath(storagePath, "images");
	return records.map((record) => {
		if (isRuntimeControlEntryType(record.type) || isSessionControlEntryType(record.type)) {
			return structuredClone(record);
		}
		return JSON.parse(JSON.stringify(record), (_key, value) => {
			if (!hasImageReferenceTag(value)) return value;
			return isImageReference(value)
				? hydrateImage(value, imageDir, imageBudget)
				: { type: "text", text: "[Image unavailable: invalid image reference]" };
		}) as FileEntry;
	});
}

function readSessionRecordsReadOnly(
	filePath: string,
	options: { allowIncompleteTail?: boolean; followSymlinkAlias?: boolean } = {},
): PreparedRecords {
	const journal = openSessionJournal<unknown>(filePath, {
		readOnly: true,
		followSymlinkAlias: options.followSymlinkAlias,
	});
	try {
		const { records } = journal.readStrict({
			repairTail: false,
			allowIncompleteTail: options.allowIncompleteTail,
		});
		return prepareRawSessionRecords(records, filePath);
	} finally {
		journal.close();
	}
}

function targetContainsDurableSource(
	targetStoragePath: string,
	sourceJournalPath: string,
	sourceAssetStoragePath: string,
	sourceOptions: { allowIncompleteTail?: boolean; followSymlinkAlias?: boolean } = {},
): boolean {
	const sourceRecords = readSessionRecordsReadOnly(sourceJournalPath, sourceOptions).records;
	return targetContainsDurableRecords(targetStoragePath, sourceRecords, sourceAssetStoragePath);
}

function recordsStartWith(records: readonly FileEntry[], prefix: readonly FileEntry[]): boolean {
	return (
		records.length >= prefix.length &&
		prefix.every((record, index) => JSON.stringify(record) === JSON.stringify(records[index]))
	);
}

function targetContainsDurableRecords(
	targetStoragePath: string,
	sourceRecords: readonly FileEntry[],
	sourceAssetStoragePath: string,
): boolean {
	const targetRecords = readSessionRecordsReadOnly(targetStoragePath).records;
	if (!recordsStartWith(targetRecords, sourceRecords)) return false;
	visitReferencedImagesStrictly(sourceRecords, sourceAssetStoragePath, () => undefined);
	visitReferencedImagesStrictly(sourceRecords, targetStoragePath, () => undefined);
	return true;
}

/** Strict, read-only load that never acquires a writer lease or repairs the source. */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	const storagePath = canonicalPath(resolvedFilePath);
	if (!existsSync(storagePath) || statSync(storagePath).size === 0) return [];
	return hydrateSessionRecords(readSessionRecordsReadOnly(storagePath).records, storagePath);
}

const SESSION_READ_BUFFER_BYTES = 64 * 1024;
export const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024;

function readSessionHeaderInfo(filePath: string): { header: SessionHeader; mtimeMs: number } | null {
	try {
		const before = lstatSync(filePath);
		if (!before.isFile() || before.nlink !== 1) return null;
		const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
		const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
		const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let mtimeMs = 0;
		try {
			const opened = fstatSync(fd);
			mtimeMs = opened.mtimeMs;
			const current = lstatSync(filePath);
			if (
				!opened.isFile() ||
				opened.nlink !== 1 ||
				!current.isFile() ||
				current.nlink !== 1 ||
				before.dev !== opened.dev ||
				before.ino !== opened.ino ||
				opened.dev !== current.dev ||
				opened.ino !== current.ino
			) {
				return null;
			}
			const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_BYTES);
			while (true) {
				const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
				if (bytesRead === 0) return null;
				const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
				const lineBytes = newline === -1 ? bytesRead : newline;
				if (totalBytes + lineBytes > MAX_SESSION_RECORD_BYTES) return null;
				chunks.push(Buffer.from(buffer.subarray(0, lineBytes)));
				totalBytes += lineBytes;
				if (newline !== -1) break;
			}
			const afterOpened = fstatSync(fd);
			const afterPath = lstatSync(filePath);
			if (
				!afterOpened.isFile() ||
				afterOpened.nlink !== 1 ||
				!afterPath.isFile() ||
				afterPath.nlink !== 1 ||
				afterOpened.dev !== opened.dev ||
				afterOpened.ino !== opened.ino ||
				afterPath.dev !== opened.dev ||
				afterPath.ino !== opened.ino
			) {
				return null;
			}
		} finally {
			closeSync(fd);
		}
		const firstLine = Buffer.concat(chunks, totalBytes).toString("utf8");
		if (!firstLine) return null;
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string") {
			return null;
		}
		return { header: header as unknown as SessionHeader, mtimeMs };
	} catch {
		return null;
	}
}

function readSessionHeader(filePath: string): SessionHeader | null {
	return readSessionHeaderInfo(filePath)?.header ?? null;
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	for (const file of findRecentSessionCandidates(sessionDir, cwd)) {
		try {
			// A writer can recover a partial final record. Validate the complete
			// prefix without mutating the candidate.
			readSessionRecordsReadOnly(file.path, { allowIncompleteTail: true });
			return file.path;
		} catch {
			// Corrupt candidates are isolated; continue to the next valid session.
		}
	}
	return null;
}

function findRecentSessionCandidates(sessionDir: string, cwd?: string): { path: string; mtimeMs: number }[] {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		return readdirSync(resolvedSessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(resolvedSessionDir, name))
			.map((path) => ({ path, info: readSessionHeaderInfo(path) }))
			.filter(
				(candidate): candidate is { path: string; info: { header: SessionHeader; mtimeMs: number } } =>
					candidate.info !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(candidate.info.header), resolvedCwd)),
			)
			.map(({ path, info }) => ({ path, mtimeMs: info.mtimeMs }))
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} catch {
		return [];
	}
}

function isMessageWithContent(message: unknown): message is Message {
	return (
		typeof message === "object" &&
		message !== null &&
		typeof (message as Message).role === "string" &&
		"content" in message
	);
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

const SESSION_CATALOG_YIELD_BYTES = 1024 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface SessionCatalogState {
	header?: SessionHeader;
	seenRecordIds: Set<string>;
	seenTreeIds: Set<string>;
	messageCount: number;
	firstMessage: string;
	allMessages: string[];
	name?: string;
	lastActivityTime?: number;
}

function parseCatalogRecord(bytes: Buffer, filePath: string, lineNumber: number): unknown {
	let line: string;
	try {
		line = fatalUtf8Decoder.decode(bytes);
	} catch (error) {
		throw new CorruptSessionError(filePath, lineNumber, "Journal record is not valid UTF-8", { cause: error });
	}
	if (line.trim().length === 0) {
		corruptSession(filePath, lineNumber, "Journal contains an empty complete record");
	}
	try {
		return JSON.parse(line) as unknown;
	} catch (error) {
		throw new CorruptSessionError(filePath, lineNumber, "Malformed complete journal record", { cause: error });
	}
}

function addCatalogRecord(state: SessionCatalogState, record: unknown, index: number, filePath: string): void {
	const raw = validateRawSessionRecord(record, index, filePath);
	if (index === 0) {
		const version = typeof raw.version === "number" ? raw.version : 1;
		if (version >= 6 && version < CURRENT_SESSION_VERSION) {
			migrateLegacyPermissionFields(raw, filePath, 1, DEFAULT_PERMISSION_PRESET);
			if (isJsonObject(raw.agent)) {
				migrateLegacyPermissionFields(raw.agent, filePath, 1);
			}
		}
		state.header = validateSessionHeader(raw, filePath);
		return;
	}

	const header = state.header;
	if (!header) corruptSession(filePath, 1, "Session journal is empty");
	if ((header.version ?? 1) < CURRENT_SESSION_VERSION) {
		migrateLegacyPermissionJournalRecord(raw, filePath, index + 1);
	}
	const type = raw.type as string;
	if (type.startsWith("runtime_")) {
		if ((header.version ?? 1) < 5) {
			corruptSession(filePath, index + 1, "Runtime control entries require a v5 session header");
		}
		if (!isRuntimeControlEntryType(type)) {
			corruptSession(filePath, index + 1, `Unknown runtime control entry type: ${type}`);
		}
		validateControlGraphEntry(
			parseRuntimeRecord(raw, index + 1, filePath),
			index + 1,
			filePath,
			state.seenRecordIds,
			state.seenTreeIds,
		);
		return;
	}
	if (isSessionControlEntryType(type)) {
		if (isSessionDirectoryControlEntryType(type) && (header.version ?? 1) < 8) {
			corruptSession(filePath, index + 1, "Directory control entries require a v8 session header");
		}
		if (isSessionDirectoryControlEntryType(type) && (header.mode ?? DEFAULT_AGENT_MODE) !== "code") {
			corruptSession(filePath, index + 1, "Directory controls are only valid for Code sessions");
		}
		if (!isSessionDirectoryControlEntryType(type) && (header.version ?? 1) < 6) {
			corruptSession(filePath, index + 1, "Session control entries require a v6 session header");
		}
		validateControlGraphEntry(
			parseSessionControlRecord(raw, index + 1, filePath),
			index + 1,
			filePath,
			state.seenRecordIds,
			state.seenTreeIds,
		);
		return;
	}
	if (type.startsWith("session_permission")) {
		corruptSession(filePath, index + 1, `Unknown session control entry type: ${type}`);
	}
	if (type.startsWith("session_directory_")) {
		corruptSession(filePath, index + 1, `Unknown session control entry type: ${type}`);
	}
	const entry = raw as unknown as SessionEntry;
	if ((header.version ?? 1) === 1) {
		if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) {
			corruptSession(filePath, index + 1, "Session entry has an invalid timestamp");
		}
		if (entry.type === "label") {
			corruptSession(filePath, index + 1, "Legacy session label references an unknown target");
		}
	} else {
		validateSessionGraphEntry(entry, index + 1, filePath, state.seenRecordIds, state.seenTreeIds);
	}

	if (entry.type === "session_info") {
		if (entry.name !== undefined && typeof entry.name !== "string") {
			corruptSession(filePath, index + 1, "Session name must be a string");
		}
		state.name = entry.name?.trim() || undefined;
	}
	if (entry.type !== "message") return;
	state.messageCount++;

	const activityTime = getMessageActivityTime(entry);
	if (typeof activityTime === "number") {
		state.lastActivityTime = Math.max(state.lastActivityTime ?? 0, activityTime);
	}
	const message = entry.message;
	if (!isMessageWithContent(message) || (message.role !== "user" && message.role !== "assistant")) return;
	const textContent = extractTextContent(message);
	if (!textContent) return;
	state.allMessages.push(textContent);
	if (!state.firstMessage && message.role === "user") {
		state.firstMessage = formatSessionAttachmentDisplayText(textContent);
	}
}

async function scanSessionCatalog(filePath: string): Promise<{ state: SessionCatalogState; mtime: Date }> {
	const before = await lstat(filePath);
	if (!before.isFile() || before.nlink !== 1) throw new Error(`Unsafe session catalog file: ${filePath}`);
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const handle = await open(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
	try {
		const opened = await handle.stat();
		const current = await lstat(filePath);
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			!current.isFile() ||
			current.nlink !== 1 ||
			before.dev !== opened.dev ||
			before.ino !== opened.ino ||
			opened.dev !== current.dev ||
			opened.ino !== current.ino
		) {
			throw new Error(`Unsafe session catalog file: ${filePath}`);
		}

		const state: SessionCatalogState = {
			seenRecordIds: new Set(),
			seenTreeIds: new Set(),
			messageCount: 0,
			firstMessage: "",
			allMessages: [],
		};
		const pending: Buffer[] = [];
		let pendingBytes = 0;
		let position = 0;
		let lineNumber = 1;
		let bytesSinceYield = 0;
		let scheduledSummaryComplete = false;
		const readBuffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_BYTES);

		while (position < opened.size) {
			const length = Math.min(readBuffer.byteLength, opened.size - position);
			const { bytesRead } = await handle.read(readBuffer, 0, length, position);
			if (bytesRead === 0) throw new Error(`Session catalog snapshot was truncated: ${filePath}`);
			position += bytesRead;
			bytesSinceYield += bytesRead;
			const chunk = readBuffer.subarray(0, bytesRead);
			let segmentStart = 0;
			let lineEnd = chunk.indexOf(0x0a);
			while (lineEnd !== -1) {
				const segment = chunk.subarray(segmentStart, lineEnd);
				const lineBytes = pendingBytes + segment.byteLength;
				if (lineBytes > MAX_SESSION_RECORD_BYTES) {
					corruptSession(filePath, lineNumber, `Journal record exceeds ${MAX_SESSION_RECORD_BYTES} byte limit`);
				}
				const bytes = pendingBytes === 0 ? segment : Buffer.concat([...pending, segment], lineBytes);
				addCatalogRecord(state, parseCatalogRecord(bytes, filePath, lineNumber), lineNumber - 1, filePath);
				pending.length = 0;
				pendingBytes = 0;
				lineNumber++;
				if (state.header?.scheduled && state.firstMessage) {
					scheduledSummaryComplete = true;
					break;
				}
				segmentStart = lineEnd + 1;
				lineEnd = chunk.indexOf(0x0a, segmentStart);
			}
			if (scheduledSummaryComplete) break;

			const remainder = chunk.subarray(segmentStart);
			if (remainder.byteLength > 0) {
				if (pendingBytes + remainder.byteLength > MAX_SESSION_RECORD_BYTES) {
					corruptSession(filePath, lineNumber, `Journal record exceeds ${MAX_SESSION_RECORD_BYTES} byte limit`);
				}
				pending.push(Buffer.from(remainder));
				pendingBytes += remainder.byteLength;
			}
			if (bytesSinceYield >= SESSION_CATALOG_YIELD_BYTES) {
				bytesSinceYield = 0;
				await yieldToEventLoop();
			}
		}

		if (!state.header) corruptSession(filePath, 1, "Session journal is empty");
		// A writer may have crashed mid-record. Catalog reads ignore only this
		// incomplete final tail; every newline-terminated record was parsed strictly.
		const afterOpened = await handle.stat();
		const afterPath = await lstat(filePath);
		if (
			!afterOpened.isFile() ||
			afterOpened.nlink !== 1 ||
			!afterPath.isFile() ||
			afterPath.nlink !== 1 ||
			afterOpened.dev !== opened.dev ||
			afterOpened.ino !== opened.ino ||
			afterPath.dev !== opened.dev ||
			afterPath.ino !== opened.ino
		) {
			throw new Error(`Session catalog file changed identity during scan: ${filePath}`);
		}
		return { state, mtime: opened.mtime };
	} finally {
		await handle.close();
	}
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const { state, mtime } = await scanSessionCatalog(filePath);
		const header = state.header!;
		const headerTime = new Date(header.timestamp).getTime();
		const modified = header.scheduled
			? mtime
			: typeof state.lastActivityTime === "number" && state.lastActivityTime > 0
				? new Date(state.lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: mtime;
		return {
			path: filePath,
			id: header.id,
			cwd: header.cwd,
			mode: header.mode ?? DEFAULT_AGENT_MODE,
			name: state.name,
			parentSessionPath: header.parentSession,
			...(header.scheduled ? { scheduled: header.scheduled } : {}),
			created: new Date(header.timestamp),
			modified,
			// Scheduled sessions are immutable and list by their instruction; their
			// complete transcript is loaded only when the user opens the result.
			messageCount: header.scheduled ? 0 : state.messageCount,
			firstMessage: state.firstMessage || "(no messages)",
			allMessagesText: header.scheduled ? state.firstMessage : state.allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

interface ManagedSessionState {
	sessionId: string;
	cwdOrigin: CwdOrigin;
	permissionPreset: PermissionPreset;
	ultraSelected: boolean;
	additionalDirectories: string[];
	sessionFile: string | undefined;
	/** Canonical path pinned when a persisted session is opened. */
	storagePath?: string;
	toolOutputDir?: string;
	rawFileEntries: FileEntry[];
	fileEntries: FileEntry[];
	imageReadBudget: ImageReadBudget;
	recordIds: Set<string>;
	byId: Map<string, SessionEntry>;
	labelsById: Map<string, string>;
	labelTimestampsById: Map<string, string>;
	leafId: string | null;
	journal?: SessionJournal<FileEntry>;
	lease?: SessionLease;
}

function reducePermissionPreset(entries: readonly FileEntry[]): PermissionPreset {
	const header = entries[0] as SessionHeader;
	let preset = isPermissionPreset(header.permissionPreset) ? header.permissionPreset : DEFAULT_PERMISSION_PRESET;
	for (const entry of entries.slice(1)) {
		if (entry.type !== "session_permission_preset") continue;
		if (isPermissionPreset(entry.permissionPreset)) preset = entry.permissionPreset;
	}
	return preset;
}

function reduceUltraSelected(entries: readonly FileEntry[]): boolean {
	let selected = false;
	for (const entry of entries.slice(1)) {
		if (entry.type === "session_ultra_selection") selected = entry.selected;
	}
	return selected;
}

function reduceAdditionalDirectories(entries: readonly FileEntry[]): string[] {
	const directories = new Set<string>();
	for (const entry of entries.slice(1)) {
		if (entry.type === "session_directory_added") directories.add(entry.path);
		if (entry.type === "session_directory_removed") directories.delete(entry.path);
	}
	return [...directories];
}

function buildManagedSessionState(
	fileEntries: FileEntry[],
	sessionFile?: string,
	journal?: SessionJournal<FileEntry>,
	lease?: SessionLease,
	storagePath?: string,
): ManagedSessionState {
	const rawFileEntries = fileEntries;
	const transcriptFileEntries = rawFileEntries.filter(
		(entry) => !isRuntimeControlEntryType(entry.type) && !isSessionControlEntryType(entry.type),
	);
	const imageReadBudget: ImageReadBudget = { used: 0, limit: MAX_SESSION_IMAGE_BLOB_BYTES };
	const hydratedFileEntries = storagePath
		? hydrateSessionRecords(transcriptFileEntries, storagePath, imageReadBudget)
		: [...transcriptFileEntries];
	const header = rawFileEntries[0] as SessionHeader;
	const recordIds = new Set<string>();
	const byId = new Map<string, SessionEntry>();
	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();
	let leafId: string | null = null;
	const permissionPreset = reducePermissionPreset(rawFileEntries);
	const ultraSelected = reduceUltraSelected(rawFileEntries);
	const primaryRoot = canonicalizePathForCreation(header.cwd);
	const additionalDirectories = reduceAdditionalDirectories(rawFileEntries).filter((path) => path !== primaryRoot);
	for (const rawEntry of rawFileEntries.slice(1)) {
		recordIds.add((rawEntry as SessionEntry | RuntimeControlEntry | SessionControlEntry).id);
	}
	for (const entry of hydratedFileEntries.slice(1)) {
		if (isRuntimeControlEntryType(entry.type) || isSessionControlEntryType(entry.type)) continue;
		const treeEntry = entry as SessionEntry;
		byId.set(treeEntry.id, treeEntry);
		leafId = treeEntry.id;
		if (treeEntry.type !== "label") continue;
		if (treeEntry.label) {
			labelsById.set(treeEntry.targetId, treeEntry.label);
			labelTimestampsById.set(treeEntry.targetId, treeEntry.timestamp);
		} else {
			labelsById.delete(treeEntry.targetId);
			labelTimestampsById.delete(treeEntry.targetId);
		}
	}
	return {
		sessionId: header.id,
		cwdOrigin: header.cwdOrigin ?? "user-selected",
		permissionPreset,
		ultraSelected,
		additionalDirectories,
		sessionFile,
		storagePath,
		toolOutputDir: storagePath ? getSessionAssetDirFromStoragePath(storagePath, "tool-results") : undefined,
		rawFileEntries,
		fileEntries: hydratedFileEntries,
		imageReadBudget,
		recordIds,
		byId,
		labelsById,
		labelTimestampsById,
		leafId,
		journal,
		lease,
	};
}

function closeManagedSessionState(state: Pick<ManagedSessionState, "journal" | "lease">): void {
	// Journal mutations sync and close their fd before returning. Release the lease
	// first so a failed lease close leaves this manager fully usable for retry.
	state.lease?.close();
	state.journal?.close();
}

function journalOptions(_storagePath: string, lease: SessionLease, displayPath: string) {
	return {
		serializer: (entry: FileEntry) => JSON.stringify(entry),
		validateRecords: (records: readonly FileEntry[]) => {
			prepareRawSessionRecords(records, displayPath);
		},
		runExclusiveMutation: <T>(mutation: () => T) => lease.withWritePermit(mutation),
	};
}

function projectSessionDirForCreate(storagePath: string, header: SessionHeader): string {
	const namespaceRoot = dirname(dirname(storagePath));
	const namespace = basename(namespaceRoot);
	return namespace === "sessions" || namespace === "agents"
		? getDefaultSessionDir(header.cwd, dirname(namespaceRoot))
		: dirname(storagePath);
}

function createPersistedSessionState(
	filePath: string,
	fileEntries: FileEntry[],
	mode: "create" | "replace",
	storagePath = canonicalPath(filePath),
	copyImagesFromStoragePath?: string,
	copyToolOutputs = false,
): ManagedSessionState {
	validateSessionGraph(fileEntries, filePath);
	ensureDirectoryDurablySync(dirname(storagePath));
	const header = fileEntries[0] as SessionHeader;
	let projectLease =
		mode === "create"
			? acquireModeProjectMutationLease(
					projectSessionDirForCreate(storagePath, header),
					header.mode ?? DEFAULT_AGENT_MODE,
				)
			: undefined;
	let lease: SessionLease | undefined;
	let journal: SessionJournal<FileEntry> | undefined;
	try {
		lease = SessionLease.acquire(storagePath);
		if (mode === "create") {
			try {
				lstatSync(storagePath);
				const conflict = new Error(`Session destination already exists: ${filePath}`) as NodeJS.ErrnoException;
				conflict.code = "EEXIST";
				conflict.path = storagePath;
				throw conflict;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		let destinationEntries = fileEntries;
		if (copyImagesFromStoragePath) {
			copyReferencedImagesStrictly(destinationEntries, copyImagesFromStoragePath, storagePath);
			if (copyToolOutputs) {
				destinationEntries = copyReferencedToolOutputsStrictly(
					destinationEntries,
					copyImagesFromStoragePath,
					storagePath,
				);
			}
		}
		const durableFileEntries = prepareDurableRecords(destinationEntries, storagePath);
		validateSessionGraph(durableFileEntries, filePath);
		removeSessionDisplayMetadata(storagePath);
		removeSessionUnreadState(storagePath);
		if (mode === "create" || !existsSync(storagePath)) {
			journal = openSessionJournal<FileEntry>(storagePath, {
				...journalOptions(storagePath, lease, filePath),
				create: true,
				initialRecords: durableFileEntries,
			});
		} else {
			journal = openSessionJournal<FileEntry>(storagePath, journalOptions(storagePath, lease, filePath));
			journal.replaceAtomically(durableFileEntries);
		}
		const state = buildManagedSessionState(durableFileEntries, filePath, journal, lease, storagePath);
		if (mode === "replace") appendPendingRecoveryNotices(state);
		let name: string | undefined;
		for (const entry of durableFileEntries) {
			if (entry.type === "session_info") name = entry.name?.trim() || undefined;
		}
		try {
			writeSessionDisplayMetadata(storagePath, { sessionId: header.id, ...(name ? { name } : {}) });
		} catch {
			// The journal is authoritative; a missing derived cache is rebuilt on the next safe catalog scan.
		}
		projectLease?.close();
		projectLease = undefined;
		return state;
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			closeManagedSessionState({ journal, lease });
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			projectLease?.close();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], `Failed to publish and clean up session: ${filePath}`);
		}
		throw error;
	}
}

const SESSION_RECOVERY_CUSTOM_TYPE = "metis.session_recovery";

function isSessionRecoveryCustomType(value: string): boolean {
	return value === SESSION_RECOVERY_CUSTOM_TYPE;
}

function appendRecoveryNotice(state: ManagedSessionState, artifactPath: string, discardedBytes: number): void {
	const entry: CustomEntry = {
		type: "custom",
		customType: SESSION_RECOVERY_CUSTOM_TYPE,
		data: {
			artifactPath,
			discardedBytes,
		},
		id: generateId(state.recordIds),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
	};
	if (!state.journal || !state.storagePath) throw new Error("Persisted session is missing durable recovery state");
	const rawEntry = prepareDurableRecord(entry, state.storagePath);
	state.journal.append(rawEntry);
	state.rawFileEntries.push(rawEntry);
	state.fileEntries.push(entry);
	state.recordIds.add(entry.id);
	state.byId.set(entry.id, entry);
	state.leafId = entry.id;
}

function appendPendingRecoveryNotices(state: ManagedSessionState): void {
	if (!state.journal) return;
	if (!state.storagePath) throw new Error("Persisted session is missing its storage path");
	const recoveryDirectory = join(dirname(state.storagePath), ".recovery");
	let directoryStats: ReturnType<typeof lstatSync>;
	try {
		directoryStats = lstatSync(recoveryDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!directoryStats.isDirectory()) throw new Error(`Unsafe session recovery directory: ${recoveryDirectory}`);

	const recorded = new Set<string>();
	for (const entry of state.fileEntries) {
		if (entry.type !== "custom" || !isSessionRecoveryCustomType(entry.customType)) continue;
		const artifactPath = (entry.data as { artifactPath?: unknown } | undefined)?.artifactPath;
		if (typeof artifactPath === "string") recorded.add(resolve(artifactPath));
	}

	const prefix = `${parse(state.storagePath).name}-`;
	for (const name of readdirSync(recoveryDirectory).sort()) {
		if (!name.startsWith(prefix) || !name.endsWith(".partial")) continue;
		const artifactPath = join(recoveryDirectory, name);
		const artifactStats = lstatSync(artifactPath);
		if (!artifactStats.isFile() || artifactStats.nlink !== 1) {
			throw new Error(`Unsafe session recovery artifact: ${artifactPath}`);
		}
		if (recorded.has(resolve(artifactPath))) continue;
		appendRecoveryNotice(state, artifactPath, artifactStats.size);
		recorded.add(resolve(artifactPath));
	}
}

function openPersistedSessionState(
	filePath: string,
	emptyHeader: () => SessionHeader,
	storagePath = canonicalPath(filePath),
	options: { createIfMissing?: boolean; externalizeInlineImages?: boolean } = {},
): ManagedSessionState {
	const lease = SessionLease.acquire(storagePath);
	let projectLease: SessionLease | undefined;
	let journal: SessionJournal<FileEntry> | undefined;
	try {
		let records: FileEntry[] | undefined;
		try {
			journal = openSessionJournal<FileEntry>(storagePath, journalOptions(storagePath, lease, filePath));
		} catch (error) {
			if (!options.createIfMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const header = emptyHeader();
			projectLease = acquireModeProjectMutationLease(
				projectSessionDirForCreate(storagePath, header),
				header.mode ?? DEFAULT_AGENT_MODE,
			);
			records = [header];
			journal = openSessionJournal<FileEntry>(storagePath, {
				...journalOptions(storagePath, lease, filePath),
				create: true,
				initialRecords: records,
			});
		}
		if (!records) {
			const result = journal.readStrict();
			if (result.records.length === 0) {
				const header = emptyHeader();
				projectLease = acquireModeProjectMutationLease(
					projectSessionDirForCreate(storagePath, header),
					header.mode ?? DEFAULT_AGENT_MODE,
				);
				records = [header];
				journal.replaceAtomically(records);
			} else {
				const sourceVersion = (result.records[0] as SessionHeader | undefined)?.version ?? 1;
				const prepared = prepareRawSessionRecords(result.records, filePath);
				records = prepared.records;
				const shouldExternalize = options.externalizeInlineImages && containsExternalizableImage(records);
				if (prepared.migrated || shouldExternalize) {
					records = prepareDurableRecords(records, storagePath);
					validateSessionGraph(records, filePath);
				}
				if (prepared.migrated) {
					journal.replaceAtomically(records, { backupTag: `v${sourceVersion}` });
				} else if (shouldExternalize) {
					journal.replaceAtomically(records);
				}
			}
		}

		const state = buildManagedSessionState(records, filePath, journal, lease, storagePath);
		appendPendingRecoveryNotices(state);
		projectLease?.close();
		projectLease = undefined;
		return state;
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			closeManagedSessionState({ journal, lease });
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			projectLease?.close();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], `Failed to open and clean up session: ${filePath}`);
		}
		throw error;
	}
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private cwdOrigin: CwdOrigin = "user-selected";
	private permissionPreset: PermissionPreset = DEFAULT_PERMISSION_PRESET;
	private permissionPresetListeners = new Set<(next: PermissionPreset, previous: PermissionPreset) => void>();
	private ultraSelected = false;
	private additionalDirectories: string[] = [];
	private sessionFile: string | undefined;
	private storagePath: string | undefined;
	private toolOutputDir: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private readonly primaryWorkspaceRoot: string;
	private persist: boolean;
	private rawFileEntries: FileEntry[] = [];
	private durableJournalSnapshot?: readonly FileEntry[];
	private fileEntries: FileEntry[] = [];
	private imageReadBudget: ImageReadBudget = { used: 0, limit: MAX_SESSION_IMAGE_BLOB_BYTES };
	private recordIds: Set<string> = new Set();
	private byId: Map<string, SessionEntry> = new Map();
	private messageEntryIds = new WeakMap<object, string>();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private journal?: SessionJournal<FileEntry>;
	private lease?: SessionLease;
	private closed = false;

	private constructor(
		cwd: string,
		sessionDir: string,
		persist: boolean,
		init: {
			sessionFile?: string;
			newSessionOptions?: NewSessionOptions;
			state?: ManagedSessionState;
		} = {},
	) {
		this.cwd = resolvePath(cwd);
		this.primaryWorkspaceRoot = canonicalizePathForCreation(this.cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir) ensureDirectoryDurablySync(this.sessionDir);

		if (init.state) {
			this._applyManagedState(init.state);
		} else if (init.sessionFile) {
			this._setSessionFile(init.sessionFile);
		} else {
			this.newSession(init.newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string): void {
		this._assertOpen();
		const resolvedFile = resolvePath(sessionFile);
		const storagePath = canonicalPath(resolvedFile);
		if (this.storagePath === storagePath) return;

		const createHeader = (): SessionHeader => ({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: createSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.cwd,
			mode: DEFAULT_AGENT_MODE,
			cwdOrigin: "user-selected",
			permissionPreset: DEFAULT_PERMISSION_PRESET,
		});
		if (!this.persist) {
			const records = existsSync(storagePath) ? readSessionRecordsReadOnly(storagePath).records : [createHeader()];
			this._replaceManagedState(buildManagedSessionState(records, resolvedFile, undefined, undefined, storagePath));
			return;
		}
		const state = openPersistedSessionState(resolvedFile, createHeader, storagePath, { createIfMissing: true });
		this._replaceManagedState(state);
	}

	newSession(options?: NewSessionOptions): string | undefined {
		this._assertOpen();
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const mode = options?.mode ?? this.getMode();
		const requestedPermissionPreset = options?.permissionPreset;
		const permissionPreset =
			requestedPermissionPreset === undefined
				? DEFAULT_PERMISSION_PRESET
				: isPermissionPreset(requestedPermissionPreset)
					? requestedPermissionPreset
					: undefined;
		if (!permissionPreset) throw new TypeError("Invalid permission preset");
		if (options?.agent) {
			if (options.agent.agentId !== sessionId) throw new TypeError("Agent header id must match session id");
			assertValidSessionId(options.agent.parentSessionId);
			assertValidSessionId(options.agent.rootSessionId);
			if (
				typeof options.agent.name !== "string" ||
				options.agent.name.length < 1 ||
				options.agent.name.length > 128 ||
				/[\u0000-\u001f\u007f-\u009f]/u.test(options.agent.name)
			) {
				throw new TypeError("Invalid agent name");
			}
		}
		if (options?.scheduled) {
			if (options.agent) throw new TypeError("A session cannot be both scheduled and an agent");
			assertValidSessionId(options.scheduled.taskId);
			assertValidSessionId(options.scheduled.runId);
		}
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: this.cwd,
			mode,
			cwdOrigin: options?.cwdOrigin ?? "user-selected",
			permissionPreset,
			parentSession: options?.parentSession,
			agent: options?.agent,
			scheduled: options?.scheduled,
		};
		let state: ManagedSessionState;
		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
			state = createPersistedSessionState(sessionFile, [header], "create");
		} else {
			state = buildManagedSessionState([header]);
		}
		this._replaceManagedState(state);
		return this.sessionFile;
	}

	private _assertOpen(): void {
		if (this.closed) throw new Error("Session manager is closed");
	}

	private _applyManagedState(state: ManagedSessionState): void {
		this.sessionId = state.sessionId;
		this.cwdOrigin = state.cwdOrigin;
		this.permissionPreset = state.permissionPreset;
		this.ultraSelected = state.ultraSelected;
		this.additionalDirectories = state.additionalDirectories.filter((path) => path !== this.primaryWorkspaceRoot);
		this.sessionFile = state.sessionFile;
		this.storagePath = state.storagePath;
		this.toolOutputDir = state.toolOutputDir;
		this.rawFileEntries = state.rawFileEntries;
		this.durableJournalSnapshot = undefined;
		this.fileEntries = state.fileEntries;
		this.imageReadBudget = state.imageReadBudget;
		this.recordIds = state.recordIds;
		this.byId = state.byId;
		this.messageEntryIds = new WeakMap();
		for (const entry of state.fileEntries) {
			if (entry.type === "message") this.messageEntryIds.set(entry.message, entry.id);
		}
		this.labelsById = state.labelsById;
		this.labelTimestampsById = state.labelTimestampsById;
		this.leafId = state.leafId;
		this.journal = state.journal;
		this.lease = state.lease;
	}

	private _detachManagedState(): ManagedSessionState {
		const state: ManagedSessionState = {
			sessionId: this.sessionId,
			cwdOrigin: this.cwdOrigin,
			permissionPreset: this.permissionPreset,
			ultraSelected: this.ultraSelected,
			additionalDirectories: this.additionalDirectories,
			sessionFile: this.sessionFile,
			storagePath: this.storagePath,
			toolOutputDir: this.toolOutputDir,
			rawFileEntries: this.rawFileEntries,
			fileEntries: this.fileEntries,
			imageReadBudget: this.imageReadBudget,
			recordIds: this.recordIds,
			byId: this.byId,
			labelsById: this.labelsById,
			labelTimestampsById: this.labelTimestampsById,
			leafId: this.leafId,
			journal: this.journal,
			lease: this.lease,
		};
		this.journal = undefined;
		this.lease = undefined;
		this.storagePath = undefined;
		this.toolOutputDir = undefined;
		this.closed = true;
		return state;
	}

	private _replaceManagedState(state: ManagedSessionState): void {
		try {
			closeManagedSessionState({ journal: this.journal, lease: this.lease });
		} catch (error) {
			try {
				closeManagedSessionState(state);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Failed to switch session and clean up candidate");
			}
			throw error;
		}
		this._applyManagedState(state);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getAdditionalDirectories(): readonly string[] {
		return [...this.additionalDirectories];
	}

	getWorkspaceRoots(): readonly string[] {
		return [this.primaryWorkspaceRoot, ...this.additionalDirectories];
	}

	private _assertCodeWorkspaceDirectories(): void {
		if (this.getMode() !== "code") throw new Error("Additional directories are only available in Code mode");
	}

	private _validateDirectoryInput(input: string): string {
		if (typeof input !== "string" || !input.trim()) throw new TypeError("Directory path must not be empty");
		if (/[\u0000-\u001f\u007f-\u009f]/u.test(input))
			throw new TypeError("Directory path contains control characters");
		return resolvePath(input, this.cwd, { trim: true });
	}

	addWorkspaceDirectory(input: string): WorkspaceDirectoryChange {
		this._assertCodeWorkspaceDirectories();
		const resolved = this._validateDirectoryInput(input);
		let path: string;
		try {
			path = realpathSync(resolved);
		} catch {
			throw new Error(`Directory does not exist: ${resolved}`);
		}
		if (!statSync(path).isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);
		if (path === this.primaryWorkspaceRoot || this.additionalDirectories.includes(path)) {
			return { path, changed: false };
		}
		this._appendSessionControl({ type: "session_directory_added", path });
		this.additionalDirectories = [...this.additionalDirectories, path];
		return { path, changed: true };
	}

	removeWorkspaceDirectory(input: string): WorkspaceDirectoryChange {
		this._assertCodeWorkspaceDirectories();
		const path = canonicalizePathForCreation(this._validateDirectoryInput(input));
		if (path === this.primaryWorkspaceRoot) throw new Error("Primary working directory cannot be removed");
		if (!this.additionalDirectories.includes(path)) return { path, changed: false };
		this._appendSessionControl({ type: "session_directory_removed", path });
		this.additionalDirectories = this.additionalDirectories.filter((candidate) => candidate !== path);
		return { path, changed: true };
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/** Stable directory for large tool outputs owned by this persisted session. */
	getToolOutputDir(): string | undefined {
		if (this.toolOutputDir) assertSafeSessionAssetDirectory(this.toolOutputDir);
		return this.toolOutputDir;
	}

	private _readDurableImageRefs(refs: readonly DurableImageRef[]): Array<{ ref: DurableImageRef; bytes: Buffer }> {
		this._assertOpen();
		if (!this.persist || !this.storagePath) {
			throw new Error("Durable image references require a persisted session");
		}
		if (!Array.isArray(refs)) throw new TypeError("Durable image references must be an array");
		if (refs.length > MAX_DURABLE_PROMPT_IMAGES) {
			throw new TypeError(`Durable prompts support at most ${MAX_DURABLE_PROMPT_IMAGES} images`);
		}
		const prepared = refs.map((ref) => {
			const extension = isImageReference(ref) ? imageExtension(ref.mimeType) : undefined;
			if (
				!extension ||
				!/^[a-f0-9]{64}$/.test(ref.hash) ||
				ref.size === undefined ||
				ref.size > MAX_DURABLE_IMAGE_BYTES
			) {
				throw new TypeError("Invalid durable image reference");
			}
			return { ref, extension };
		});
		if (prepared.reduce((total, item) => total + item.ref.size, 0) > MAX_DURABLE_PROMPT_IMAGE_BYTES) {
			throw new TypeError(`Durable prompt images exceed ${MAX_DURABLE_PROMPT_IMAGE_BYTES} total bytes`);
		}
		const imageDir = getSessionAssetDirFromStoragePath(this.storagePath, "images");
		const imageBudget: ImageReadBudget = { used: 0, limit: MAX_DURABLE_PROMPT_IMAGE_BYTES };
		return prepared.map(({ ref, extension }) => {
			let bytes: Buffer;
			try {
				assertSafeSessionAssetDirectory(imageDir);
				bytes = readOwnedRegularFile(join(imageDir, `${ref.hash}.${extension}`), {
					expectedSize: ref.size,
					maxBytes: MAX_DURABLE_IMAGE_BYTES,
					budget: imageBudget,
				});
			} catch {
				throw new Error(`Durable image asset is unavailable or unsafe: ${ref.hash}`);
			}
			if (createHash("sha256").update(bytes).digest("hex") !== ref.hash) {
				throw new Error(`Durable image asset hash mismatch: ${ref.hash}`);
			}
			return { ref, bytes };
		});
	}

	/** Validate durable prompt refs and owned blobs without retaining provider payloads. */
	validateDurableImageRefs(refs: readonly DurableImageRef[]): void {
		this._readDurableImageRefs(refs);
	}

	/** Resolve durable prompt image refs without exposing storage paths or fail-to-text fallback. */
	resolveDurableImageRefs(refs: readonly DurableImageRef[]): ImageContent[] {
		return this._readDurableImageRefs(refs).map(({ ref, bytes }) => ({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: ref.mimeType,
		}));
	}

	close(): void {
		if (this.closed) return;
		closeManagedSessionState({ journal: this.journal, lease: this.lease });
		this.journal = undefined;
		this.lease = undefined;
		this.closed = true;
	}

	private _appendEntry(entry: SessionEntry): void {
		this._assertOpen();
		let rawEntry: SessionEntry = entry;
		let hydratedEntry: SessionEntry = entry;
		if (this.persist) {
			if (!this.journal || !this.storagePath) throw new Error("Persisted session is missing its journal");
			rawEntry = prepareDurableRecord(entry, this.storagePath) as SessionEntry;
			this.journal.append(rawEntry);
			hydratedEntry = hydrateSessionRecords([rawEntry], this.storagePath, this.imageReadBudget)[0] as SessionEntry;
		}
		this.rawFileEntries.push(rawEntry);
		this.durableJournalSnapshot = undefined;
		this.fileEntries.push(hydratedEntry);
		this.recordIds.add(entry.id);
		this.byId.set(entry.id, hydratedEntry);
		if (entry.type === "message") {
			this.messageEntryIds.set(entry.message, entry.id);
			if (hydratedEntry.type === "message") this.messageEntryIds.set(hydratedEntry.message, entry.id);
		}
		this.leafId = entry.id;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		toolOutput?: PersistedToolOutput,
		turnId?: string,
	): string {
		if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
			throw new TypeError("turnId must be a non-empty string");
		}
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
			...(toolOutput ? { toolOutput } : {}),
			...(turnId === undefined ? {} : { turnId }),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append one validated runtime control record durably without advancing the transcript leaf. */
	appendRuntimeControl(payload: RuntimeControlPayload): string {
		this._assertOpen();
		if (!this.persist || !this.journal || !this.storagePath) {
			throw new Error("Runtime control entries require a persisted session");
		}
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			throw new TypeError("Runtime control payload must be a plain object");
		}
		const prototype = Object.getPrototypeOf(payload);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Runtime control payload must be a plain object");
		}
		for (const field of ["id", "parentId", "timestamp"] as const) {
			if (Object.hasOwn(payload, field)) throw new TypeError(`Runtime control payload must not contain ${field}`);
		}

		const candidate = Object.create(Object.prototype);
		Object.defineProperties(candidate, Object.getOwnPropertyDescriptors(payload));
		Object.defineProperties(candidate, {
			id: { enumerable: true, value: generateId(this.recordIds) },
			parentId: { enumerable: true, value: this.leafId },
			timestamp: { enumerable: true, value: new Date().toISOString() },
		});
		const entry = parseRuntimeControlEntry(candidate);
		this.journal.append(entry);
		this.rawFileEntries.push(entry);
		this.durableJournalSnapshot = undefined;
		this.recordIds.add(entry.id);
		return entry.id;
	}

	private _appendSessionControl(payload: SessionControlPayload): SessionControlEntry {
		this._assertOpen();
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			throw new TypeError("Session control payload must be a plain object");
		}
		const prototype = Object.getPrototypeOf(payload);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Session control payload must be a plain object");
		}
		for (const field of ["id", "parentId", "timestamp"] as const) {
			if (Object.hasOwn(payload, field)) throw new TypeError(`Session control payload must not contain ${field}`);
		}

		const candidate = Object.create(Object.prototype);
		Object.defineProperties(candidate, Object.getOwnPropertyDescriptors(payload));
		Object.defineProperties(candidate, {
			id: { enumerable: true, value: generateId(this.recordIds) },
			parentId: { enumerable: true, value: this.leafId },
			timestamp: { enumerable: true, value: new Date().toISOString() },
		});
		const entry = parseSessionControlEntry(candidate);
		if (this.persist) {
			if (!this.journal) throw new Error("Persisted session is missing its journal");
			this.journal.append(entry);
		}
		this.rawFileEntries.push(entry);
		this.durableJournalSnapshot = undefined;
		this.recordIds.add(entry.id);
		return entry;
	}

	/** Persist the user's permission preset without advancing the transcript leaf. */
	setPermissionPreset(preset: PermissionPreset): string {
		if (!isPermissionPreset(preset)) throw new TypeError("Invalid permission preset");
		const previous = this.permissionPreset;
		const entry = this._appendSessionControl({
			type: "session_permission_preset",
			permissionPreset: preset,
		});
		if (entry.type !== "session_permission_preset") throw new Error("Unexpected session control entry");
		this.permissionPreset = entry.permissionPreset;
		for (const listener of [...this.permissionPresetListeners]) {
			listener(this.getPermissionPreset(), previous);
		}
		return entry.id;
	}

	/** Observe persisted preset changes. The listener is called only after the append succeeds. */
	subscribePermissionPreset(listener: (next: PermissionPreset, previous: PermissionPreset) => void): () => void {
		this.permissionPresetListeners.add(listener);
		return () => this.permissionPresetListeners.delete(listener);
	}

	/** Append one permission decision audit record without granting persistent authority. */
	appendPermissionAuditRecord(decision: PermissionDecisionPayload): string {
		return this._appendSessionControl({
			type: "session_permission_audit",
			...decision,
			reason: decision.reason ?? "No reason provided",
		}).id;
	}

	/** Append one validated agent control without advancing the transcript leaf. */
	appendAgentControl(payload: AgentControlPayload): string {
		const entry = this._appendSessionControl(payload);
		if (!isAgentControlEntryType(entry.type)) throw new Error("Unexpected session control entry");
		return entry.id;
	}

	getPlanState(): PlanState {
		const branchIds = new Set(this.getBranch().map(({ id }) => id));
		return reducePlanState(this.rawFileEntries, branchIds);
	}

	getCollaborationMode(): CollaborationMode {
		return this.getPlanState().collaborationMode;
	}

	setCollaborationMode(collaborationMode: CollaborationMode): void {
		if (collaborationMode === "default" && this.getPlanState().currentPlan) {
			throw new Error("Cancel or start the current plan before leaving Plan mode");
		}
		this._appendSessionControl({ type: "session_collaboration_mode", collaborationMode });
	}

	submitPlan(input: { readonly title: string; readonly markdown: string }): StoredPlan {
		if (this.getCollaborationMode() !== "plan") throw new Error("submit_plan is available only in Plan mode");
		const current = this.getPlanState().currentPlan;
		const entry = this._appendSessionControl({
			type: "session_plan_proposal",
			planId: current?.planId ?? randomUUID(),
			revision: current ? current.revision + 1 : 1,
			title: input.title,
			markdown: input.markdown,
		});
		return this.getPlanState().plans.find((plan) => plan.entryId === entry.id)!;
	}

	acceptPlan(ref: PlanRef): StoredPlan {
		return this._setPlanStatus(ref, "accepted");
	}

	cancelPlan(ref: PlanRef): StoredPlan {
		return this._setPlanStatus(ref, "cancelled");
	}

	private _setPlanStatus(ref: PlanRef, status: "accepted" | "cancelled"): StoredPlan {
		const current = this.getPlanState().currentPlan;
		if (!current || current.planId !== ref.planId || current.revision !== ref.revision) {
			throw new Error("Plan action must target the current plan");
		}
		this._appendSessionControl({ type: "session_plan_status", ...ref, status });
		return this.getPlanState().plans.find((plan) => plan.entryId === current.entryId)!;
	}

	/** Persist whether the user selected the virtual Ultra thinking level. */
	setUltraSelected(selected: boolean): string {
		if (typeof selected !== "boolean") throw new TypeError("selected must be a boolean");
		const id = this._appendSessionControl({ type: "session_ultra_selection", selected }).id;
		this.ultraSelected = selected;
		return id;
	}

	/** Raw journal-order snapshot for runtime reduction; callers cannot mutate manager state. */
	getDurableJournalSnapshot(): readonly FileEntry[] {
		this._assertOpen();
		this.durableJournalSnapshot ??= deepFreeze(structuredClone(this.rawFileEntries));
		return this.durableJournalSnapshot;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		if (this.persist && this.storagePath) removeSessionDisplayMetadata(this.storagePath);
		this._appendEntry(entry);
		if (this.persist && this.storagePath) {
			try {
				writeSessionDisplayMetadata(this.storagePath, {
					sessionId: this.sessionId,
					...(sanitizedName ? { name: sanitizedName } : {}),
				});
			} catch {
				// The journal is authoritative; a missing derived cache is rebuilt on the next safe catalog scan.
			}
		}
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	getSessionUnread(): boolean {
		return this.persist && this.storagePath ? readSessionUnreadState(this.storagePath, this.sessionId) : false;
	}

	setSessionUnread(unread: boolean): void {
		this._assertOpen();
		if (!this.persist || !this.storagePath) return;
		if (unread) writeSessionUnreadState(this.storagePath, this.sessionId);
		else removeSessionUnreadState(this.storagePath);
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getMessageEntryId(message: object): string | undefined {
		return this.messageEntryIds.get(message);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.recordIds),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? { ...(h as SessionHeader) } : null;
	}

	/** Get the effective immutable session classification mode. */
	getMode(): AgentMode {
		return this.getHeader()?.mode ?? DEFAULT_AGENT_MODE;
	}

	/** Whether Metis owns the working directory or the user selected it. */
	getCwdOrigin(): CwdOrigin {
		return this.cwdOrigin;
	}

	/** User-owned permission preset after reducing session control records. */
	getPermissionPreset(): PermissionPreset {
		return this.permissionPreset;
	}

	/** Effective axes derived from the persisted preset. Parent ceilings are applied at runtime. */
	getPermissionSettings(): PermissionSettings {
		return settingsForPreset(this.permissionPreset);
	}

	/** Whether the user selected the virtual Ultra thinking level. */
	getUltraSelected(): boolean {
		return this.ultraSelected;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter(
			(entry): entry is SessionEntry =>
				entry.type !== "session" &&
				!isRuntimeControlEntryType(entry.type) &&
				!isSessionControlEntryType(entry.type),
		);
	}

	/** Compare durable records while both source and target writer leases are held. */
	containsDurablePrefixOf(source: SessionManager): boolean {
		this._assertOpen();
		source._assertOpen();
		if (
			!this.persist ||
			!source.persist ||
			!this.storagePath ||
			!source.storagePath ||
			!this.lease ||
			!source.lease
		) {
			throw new Error("Durable session comparison requires two persisted sessions");
		}
		const targetStoragePath = this.storagePath;
		const sourceStoragePath = source.storagePath;
		const targetLease = this.lease;
		const sourceLease = source.lease;

		const compare = (): boolean =>
			targetContainsDurableSource(targetStoragePath, sourceStoragePath, sourceStoragePath);

		return targetStoragePath < sourceStoragePath
			? targetLease.withWritePermit(() => sourceLease.withWritePermit(compare))
			: sourceLease.withWritePermit(() => targetLease.withWritePermit(compare));
	}

	/** Revalidate an atomically retired source journal while retaining its original asset location. */
	containsRetiredDurableSource(sourceJournalPath: string, sourceAssetStoragePath: string): boolean {
		this._assertOpen();
		if (!this.persist || !this.storagePath || !this.lease) {
			throw new Error("Retired source comparison requires a persisted target session");
		}
		const sourceStoragePath = resolvePath(sourceJournalPath);
		const sourceAssetPath = canonicalPath(sourceAssetStoragePath);
		return this.lease.withWritePermit(() =>
			targetContainsDurableSource(this.storagePath!, sourceStoragePath, sourceAssetPath, {
				allowIncompleteTail: true,
				followSymlinkAlias: false,
			}),
		);
	}

	/**
	 * Reconcile a retained legacy source with this migration target.
	 *
	 * The retired journal may still grow through an old fd, so this adopts one
	 * fixed raw snapshot and leaves the backup in place for a later startup.
	 * Returns false when the journals diverged and neither may replace the other.
	 */
	reconcileRetiredDurableSource(sourceJournalPath: string, sourceAssetStoragePath: string): boolean {
		this._assertOpen();
		if (!this.persist || !this.storagePath || !this.journal || !this.lease) {
			throw new Error("Retired source reconciliation requires a persisted target session");
		}
		const sourceStoragePath = resolvePath(sourceJournalPath);
		const sourceAssetPath = canonicalPath(sourceAssetStoragePath);
		const sourceRecords = readSessionRecordsReadOnly(sourceStoragePath, {
			allowIncompleteTail: true,
			followSymlinkAlias: false,
		}).records;
		const targetRecords = readSessionRecordsReadOnly(this.storagePath).records;

		if (!recordsStartWith(targetRecords, sourceRecords) && !recordsStartWith(sourceRecords, targetRecords)) {
			return false;
		}

		// Equality and target-superset cases still pass through the strict copy so a
		// missing target image can be repaired from the original legacy asset store.
		copyReferencedImagesStrictly(sourceRecords, sourceAssetPath, this.storagePath);
		if (!recordsStartWith(targetRecords, sourceRecords)) {
			this.journal.replaceAtomically(sourceRecords);
			this._applyManagedState(
				buildManagedSessionState(sourceRecords, this.sessionFile, this.journal, this.lease, this.storagePath),
			);
		}
		return targetContainsDurableRecords(this.storagePath, sourceRecords, sourceAssetPath);
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		this._assertOpen();
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this._assertOpen();
		this.leafId = null;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		this._assertOpen();
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.recordIds),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Create an independent candidate containing the path from root to the selected leaf. */
	createBranchedSessionManager(
		leafId: string | null,
		options?: Pick<NewSessionOptions, "id"> & {
			readonly initialName?: string;
			readonly initialCustomEntries?: readonly { readonly customType: string; readonly data?: unknown }[];
			readonly managedWorkspaceRecoveryKey?: string;
		},
	): SessionManager {
		this._assertOpen();
		if (this.getHeader()?.scheduled) throw new Error("Scheduled sessions are read-only and cannot be branched");
		if (options?.id !== undefined) assertValidSessionId(options.id);
		let sourceStoragePath: string | undefined;
		let path: SessionEntry[];
		if (this.persist) {
			if (!this.storagePath || !this.lease) throw new Error("Persisted session is missing durable ownership");
			sourceStoragePath = this.storagePath;
			const storagePath = sourceStoragePath;
			const records = this.lease.withWritePermit(() => readSessionRecordsReadOnly(storagePath).records);
			const rawEntries = records
				.slice(1)
				.filter(
					(entry): entry is SessionEntry =>
						!isRuntimeControlEntryType(entry.type) && !isSessionControlEntryType(entry.type),
				);
			const rawById = buildEntryIndex(rawEntries);
			path = leafId === null ? [] : rawById.has(leafId) ? buildSessionPath(rawEntries, leafId, rawById) : [];
		} else {
			path = leafId === null ? [] : this.getBranch(leafId);
		}
		if (leafId !== null && path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Because labels are real tree entries, later entries can be children of labels;
		// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
		// Turn ids are also dropped: the branch carries the conversation path without the
		// turn's runtime-control entries, so a dangling turnId would make durable recovery
		// reject the branch.
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			pathWithoutLabels.push({
				...entry,
				parentId: pathParentId,
				...(entry.type === "message" ? { turnId: undefined } : {}),
			});
			pathParentId = entry.id;
		}

		const sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: this.cwd,
			mode: this.getMode(),
			cwdOrigin: this.getCwdOrigin(),
			permissionPreset: this.permissionPreset,
			parentSession: this.persist ? this.sessionFile : undefined,
		};

		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id ?? null;
		for (const [targetId, label] of this.labelsById) {
			if (!pathEntryIds.has(targetId)) continue;
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(pathEntryIds),
				parentId,
				timestamp: this.labelTimestampsById.get(targetId) ?? timestamp,
				targetId,
				label,
			};
			pathEntryIds.add(labelEntry.id);
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}

		const createManager = (targetCwd: string, targetSessionDir: string): SessionManager => {
			header.cwd = targetCwd;
			const initialEntries: SessionEntry[] = [];
			let initialParentId =
				labelEntries[labelEntries.length - 1]?.id ?? pathWithoutLabels[pathWithoutLabels.length - 1]?.id ?? null;
			if (options?.initialName !== undefined) {
				const entry: SessionInfoEntry = {
					type: "session_info",
					id: generateId(pathEntryIds),
					parentId: initialParentId,
					timestamp,
					name: options.initialName.replace(/[\r\n]+/g, " ").trim(),
				};
				pathEntryIds.add(entry.id);
				initialEntries.push(entry);
				initialParentId = entry.id;
			}
			for (const custom of options?.initialCustomEntries ?? []) {
				const entry: CustomEntry = {
					type: "custom",
					id: generateId(pathEntryIds),
					parentId: initialParentId,
					timestamp,
					customType: custom.customType,
					data: custom.data,
				};
				pathEntryIds.add(entry.id);
				initialEntries.push(entry);
				initialParentId = entry.id;
			}
			const records: FileEntry[] = [header, ...pathWithoutLabels, ...labelEntries, ...initialEntries];
			let state: ManagedSessionState;
			if (this.persist) {
				const sessionFile = join(targetSessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
				state = createPersistedSessionState(
					sessionFile,
					records,
					"create",
					canonicalPath(sessionFile),
					sourceStoragePath,
					true,
				);
			} else {
				state = buildManagedSessionState(records);
			}
			return new SessionManager(targetCwd, targetSessionDir, this.persist, { state });
		};

		if (this.getCwdOrigin() === "managed") {
			const sessionDirAgent = dirname(dirname(this.sessionDir));
			const sessionDirUsesManagedAgent =
				canonicalPath(this.sessionDir) === canonicalPath(getDefaultSessionDirPath(this.cwd, sessionDirAgent));
			const agentDir = sessionDirUsesManagedAgent ? sessionDirAgent : dirname(dirname(this.cwd));
			return publishManagedWorkspaceCopy({
				sourceId: this.sessionId,
				sourceCwd: this.cwd,
				targetId: sessionId,
				agentDir,
				recoveryKey: options?.managedWorkspaceRecoveryKey,
				publish: (targetCwd) => {
					const defaultSessionDir =
						canonicalPath(this.sessionDir) === canonicalPath(getDefaultSessionDirPath(this.cwd, agentDir));
					const targetSessionDir = defaultSessionDir ? getDefaultSessionDir(targetCwd, agentDir) : this.sessionDir;
					return createManager(targetCwd, targetSessionDir);
				},
			});
		}

		return createManager(this.cwd, this.sessionDir);
	}

	/**
	 * Compatibility wrapper that replaces this manager with a newly created branch.
	 * New lifecycle code should prefer createBranchedSessionManager().
	 */
	createBranchedSession(leafId: string): string | undefined {
		const candidate = this.createBranchedSessionManager(leafId);
		const sessionFile = candidate.getSessionFile();
		this._replaceManagedState(candidate._detachManagedState());
		return sessionFile;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.metis/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, true, { newSessionOptions: options });
	}

	/** Header-only check used before routing a visible scheduled session to the read-only viewer. */
	static isScheduledSession(path: string): boolean {
		return readSessionHeader(canonicalPath(resolvePath(path)))?.scheduled !== undefined;
	}

	private static openPinned(
		resolvedPath: string,
		storagePath: string,
		sessionDir?: string,
		cwdOverride?: string,
		options: { createIfMissing?: boolean; externalizeInlineImages?: boolean } = {},
	): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		ensureDirectoryDurablySync(dir);
		const headerHint = readSessionHeader(storagePath);
		if (headerHint?.scheduled) throw new Error("Scheduled sessions are read-only; use openReadOnly");
		const initialCwd = cwdOverride ?? headerHint?.cwd ?? process.cwd();
		const createHeader = (): SessionHeader => ({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: createSessionId(),
			timestamp: new Date().toISOString(),
			cwd: resolvePath(initialCwd),
			mode: DEFAULT_AGENT_MODE,
			cwdOrigin: "user-selected",
			permissionPreset: DEFAULT_PERMISSION_PRESET,
		});
		const state = openPersistedSessionState(resolvedPath, createHeader, storagePath, {
			createIfMissing: options.createIfMissing !== false,
			externalizeInlineImages: options.externalizeInlineImages,
		});
		const header = state.fileEntries[0] as SessionHeader;
		return new SessionManager(cwdOverride ?? header.cwd, dir, true, { state });
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		const storagePath = canonicalPath(resolvedPath);
		return SessionManager.openPinned(resolvedPath, storagePath, sessionDir, cwdOverride);
	}

	/** Open an immutable, no-lease snapshot. Legacy migrations are applied only in memory. */
	static openReadOnly(path: string, cwdOverride?: string): ReadonlySessionManager {
		const resolvedPath = resolvePath(path);
		const storagePath = canonicalPath(resolvedPath);
		const prepared = readSessionRecordsReadOnly(storagePath);
		const header = prepared.records[0] as SessionHeader;
		const state = buildManagedSessionState(prepared.records, resolvedPath, undefined, undefined, storagePath);
		deepFreeze(state.rawFileEntries);
		deepFreeze(state.fileEntries);
		return readonlySessionSnapshot(
			new SessionManager(cwdOverride ?? header.cwd, dirname(resolvedPath), false, { state }),
		);
	}

	/** Strictly inspect a retired migration journal without following its final path component. */
	static readRetiredSessionHeader(path: string): SessionHeader {
		const resolvedPath = resolvePath(path);
		return structuredClone(
			readSessionRecordsReadOnly(resolvedPath, {
				allowIncompleteTail: true,
				followSymlinkAlias: false,
			}).records[0] as SessionHeader,
		);
	}

	/** Create a clean source from the complete prefix of an immutable retired backup. */
	static restoreRetiredSessionPrefix(path: string, destinationPath: string): void {
		const resolvedPath = resolvePath(path);
		const records = readSessionRecordsReadOnly(resolvedPath, {
			allowIncompleteTail: true,
			followSymlinkAlias: false,
		}).records;
		const content = records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		createFileAtomicallySync(resolvePath(destinationPath), content, { mode: 0o600 });
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.metis/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string, options?: Pick<NewSessionOptions, "mode">): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		for (const candidate of findRecentSessionCandidates(dir, filterCwd ? cwd : undefined)) {
			try {
				// Opening is the validation pass. Do not first materialize the full
				// journal through findMostRecentSession and then read it again here.
				return SessionManager.open(candidate.path, dir, cwd);
			} catch (error) {
				if (error instanceof SessionLeaseError) throw error;
				// A corrupt or raced candidate must not hide an older valid session.
			}
		}
		return new SessionManager(cwd, dir, true, { newSessionOptions: options });
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, "", false, { newSessionOptions: options });
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: Pick<NewSessionOptions, "id">,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const sourceStoragePath = canonicalPath(resolvedSourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const source = readSessionRecordsReadOnly(sourceStoragePath);
		const sourceHeader = source.records[0] as SessionHeader;
		if (sourceHeader.scheduled) throw new Error("Scheduled sessions are read-only and cannot be forked");
		const sourcePreset = reducePermissionPreset(source.records);

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			mode: sourceHeader.mode ?? DEFAULT_AGENT_MODE,
			cwdOrigin: sourceHeader.cwdOrigin ?? "user-selected",
			permissionPreset: sourcePreset,
			parentSession: resolvedSourcePath,
		};
		const state = createPersistedSessionState(
			newSessionFile,
			[
				newHeader,
				...source.records
					.slice(1)
					.filter(
						(entry): entry is SessionEntry =>
							!isRuntimeControlEntryType(entry.type) && !isSessionControlEntryType(entry.type),
					),
			],
			"create",
			canonicalPath(newSessionFile),
			sourceStoragePath,
			true,
		);
		return new SessionManager(resolvedTargetCwd, dir, true, { state });
	}

	/** Strictly import a complete raw source snapshot and atomically publish the destination. */
	static importFrom(
		sourcePath: string,
		destinationPath: string,
		cwdOverride?: string,
		options: ImportSessionOptions = {},
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedDestinationPath = resolvePath(destinationPath);
		const sourceStoragePath = canonicalPath(resolvedSourcePath);
		const destinationStoragePath = canonicalPath(resolvedDestinationPath);
		if (sourceStoragePath === destinationStoragePath) {
			if (options.destinationMode === "create-exclusive") {
				throw new Error("Create-exclusive import requires a different destination");
			}
			return SessionManager.openPinned(resolvedDestinationPath, destinationStoragePath, undefined, cwdOverride, {
				createIfMissing: false,
				externalizeInlineImages: true,
			});
		}
		const source = readSessionRecordsReadOnly(sourceStoragePath);
		const records = source.records.filter((entry) => !isSessionDirectoryControlEntryType(entry.type));
		const header = records[0] as SessionHeader;
		if (header.scheduled) throw new Error("Scheduled sessions are read-only and cannot be imported");
		const mode =
			options.destinationMode === "create-exclusive"
				? "create"
				: existsSync(destinationStoragePath)
					? "replace"
					: "create";
		const state = createPersistedSessionState(
			resolvedDestinationPath,
			records,
			mode,
			destinationStoragePath,
			sourceStoragePath,
		);
		return new SessionManager(cwdOverride ?? header.cwd, dirname(resolvedDestinationPath), true, { state });
	}

	/** Delete one closed session and only the assets Metis can prove it owns. */
	static async deleteSession(
		sessionPath: string,
		options: {
			agentDir?: string;
			allowRetainedScheduled?: boolean;
			sessionsRoot?: string;
		} = {},
	): Promise<DeleteSessionResult> {
		const unresolvedPath = resolvePath(sessionPath);
		let before: ReturnType<typeof lstatSync>;
		try {
			before = lstatSync(unresolvedPath);
			if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
				throw new Error("Session path must be a single-link regular file");
			}
		} catch (error) {
			return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
		}

		const storagePath = canonicalPath(unresolvedPath);
		let lease: SessionLease;
		try {
			lease = SessionLease.acquire(storagePath);
		} catch (error) {
			return {
				ok: false,
				method: "unlink",
				code: error instanceof SessionLeaseError ? "SESSION_IN_USE" : "OPERATION_FAILED",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		try {
			const current = lstatSync(unresolvedPath);
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.nlink !== 1 ||
				current.dev !== before.dev ||
				current.ino !== before.ino
			) {
				throw new Error("Session path changed before deletion");
			}
			const records = readSessionRecordsReadOnly(storagePath, { followSymlinkAlias: false }).records;
			const header = records[0] as SessionHeader;
			if (header.scheduled && !options.allowRetainedScheduled) {
				throw new Error("Scheduled sessions can only be deleted with their task");
			}
			const agentDir = options.agentDir ?? getDefaultAgentDir();
			const attachmentDir = getOwnedSessionAttachmentDir(agentDir, header.id);
			const workspace = getOwnedManagedWorkspace({
				id: header.id,
				cwd: header.cwd,
				cwdOrigin: header.cwdOrigin ?? "user-selected",
				agentDir,
			});
			const ownedAgentTree = getSessionAgentDir(agentDir, header.id);
			const pathDerivedTargets = sessionStoragePathVariants(storagePath, options.sessionsRoot).flatMap((path) => [
				{ label: "display metadata", path: getSessionDisplayMetadataPath(path) },
				{ label: "unread state", path: getSessionUnreadStatePath(path) },
				{ label: "image", path: getSessionImageDir(path) },
				{ label: "tool output", path: getSessionToolOutputDir(path) },
				...getOwnedSessionJournalArtifacts(path).map((artifact) => ({ label: "journal recovery", path: artifact })),
			]);
			const ownedTargets = [
				...pathDerivedTargets,
				{ label: "agents", path: ownedAgentTree },
				...(attachmentDir ? [{ label: "attachment", path: attachmentDir }] : []),
				...(workspace ? [{ label: "managed workspace", path: workspace }] : []),
				...getOwnedSessionWorkDirs(agentDir, header.id).map((path) => ({ label: "document work", path })),
			].filter(
				(target, index, targets) => targets.findIndex((candidate) => candidate.path === target.path) === index,
			);
			const exists = (path: string): boolean => {
				try {
					lstatSync(path);
					return true;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code !== "ENOENT";
				}
			};
			const moveToTrash = (targets: readonly string[]): string | undefined => {
				if (targets.length === 0) return undefined;
				const detail = trashPathsSync(targets);
				const remaining = targets.filter(exists);
				if (remaining.length === 0) return undefined;
				return `Trash did not remove ${remaining.length} target(s)${detail ? `: ${detail}` : ""}`;
			};
			const assetPaths = ownedTargets.filter(({ path }) => exists(path)).map(({ path }) => path);
			for (const path of assetPaths) lstatSync(path);
			const journalError = moveToTrash([storagePath]);
			if (journalError) return { ok: false, method: "trash", code: "OPERATION_FAILED", error: journalError };
			const assetError = moveToTrash(assetPaths);
			return assetError
				? {
						ok: true,
						method: "trash",
						warning: `Session deleted, but owned asset cleanup is incomplete: ${assetError}`,
					}
				: { ok: true, method: "trash" };
		} catch (error) {
			return {
				ok: false,
				method: "trash",
				code: "OPERATION_FAILED",
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			lease.close();
		}
	}

	/** Move one closed mode-project and its proven-owned data to the OS Trash atomically. */
	static async trashModeProjectData(input: TrashModeProjectDataInput): Promise<TrashModeProjectDataResult> {
		return trashProjectData(input, {
			readSessionHeader: (path) =>
				structuredClone(
					readSessionRecordsReadOnly(path, { followSymlinkAlias: false }).records[0] as SessionHeader,
				),
			getSessionDisplayMetadataPath,
			getSessionUnreadStatePath,
			getSessionImageDir,
			getSessionToolOutputDir,
			getSessionAgentDir,
		});
	}

	/** Restore any project deletion that was interrupted before reaching the OS Trash. */
	static recoverInterruptedProjectTrash(agentDir: string): void {
		recoverProjectTrash(agentDir);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.metis/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (await listSessionsFromDir(dir, onProgress)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
		);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
		if (customSessionDir) {
			const sessions = await listSessionsFromDir(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}
