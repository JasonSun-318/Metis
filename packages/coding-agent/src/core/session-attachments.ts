import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { canonicalizePathForCreation, resolvePath } from "../utils/paths.ts";
import {
	formatSessionConversationQuoteDisplayText,
	type SessionConversationQuote,
	splitSessionConversationQuotePrompt,
} from "./session-conversation-quotes.ts";
import {
	formatSessionFileSelectionDisplayText,
	type SessionFileSelection,
	splitSessionFileSelectionPrompt,
} from "./session-file-selections.ts";
import { assertValidSessionId } from "./session-id.ts";
import { stringifyPromptJson } from "./session-prompt-blocks.ts";

export const MAX_SESSION_ATTACHMENTS = 16;
export const MAX_SESSION_ATTACHMENT_BYTES = 128 * 1024 * 1024;
export const MAX_SESSION_ATTACHMENTS_BYTES = 256 * 1024 * 1024;
export const MAX_SESSION_DELIVERED_FILES = 32;
export const SESSION_DELIVERED_DIR_NAME = "delivered";
export const SESSION_WORK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionAttachmentInput {
	readonly path: string;
	readonly name?: string;
}

export interface SessionAttachment {
	readonly name: string;
	readonly path: string;
	readonly size: number;
}

function assertRealDirectory(path: string, label: string): string {
	const metadata = lstatSync(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
	return realpathSync(path);
}

function attachmentName(input: string): string {
	const name = basename(input)
		.replace(/[\u0000-\u001f\u007f[\]<>]/g, "_")
		.trim();
	if (!name) throw new Error("Attachment name must not be empty");
	return Array.from(name).slice(0, 255).join("");
}

function ensureAttachmentDirectory(agentDir: string, sessionId: string): string {
	assertValidSessionId(sessionId);
	const resolvedAgentDir = resolvePath(agentDir);
	mkdirSync(resolvedAgentDir, { recursive: true });
	const canonicalAgentDir = assertRealDirectory(resolvedAgentDir, "Agent directory");
	const root = join(resolvedAgentDir, "attachments");
	if (!existsSync(root)) mkdirSync(root);
	const canonicalRoot = assertRealDirectory(root, "Attachment root");
	if (dirname(canonicalRoot) !== canonicalAgentDir) throw new Error("Attachment root escapes the agent directory");

	const target = join(root, sessionId);
	if (!existsSync(target)) mkdirSync(target);
	const canonicalTarget = assertRealDirectory(target, "Session attachment directory");
	if (dirname(canonicalTarget) !== canonicalRoot) throw new Error("Session attachment directory escapes its root");
	return canonicalTarget;
}

export function getSessionAttachmentDir(agentDir: string, sessionId: string): string {
	assertValidSessionId(sessionId);
	return join(canonicalizePathForCreation(resolvePath(agentDir)), "attachments", sessionId);
}

function getOwnedSessionWorkRoot(agentDir: string, create: boolean): string | undefined {
	try {
		const resolvedAgentDir = resolvePath(agentDir);
		if (create) mkdirSync(resolvedAgentDir, { recursive: true });
		const canonicalAgentDir = assertRealDirectory(resolvedAgentDir, "Agent directory");
		const tmpRoot = join(resolvedAgentDir, "tmp");
		if (create) mkdirSync(tmpRoot, { recursive: true });
		const canonicalTmpRoot = assertRealDirectory(tmpRoot, "Temporary root");
		if (dirname(canonicalTmpRoot) !== canonicalAgentDir) return undefined;

		const workRoot = join(tmpRoot, "document-work");
		if (create) mkdirSync(workRoot, { recursive: true });
		const canonicalWorkRoot = assertRealDirectory(workRoot, "Document work root");
		if (dirname(canonicalWorkRoot) !== canonicalTmpRoot) return undefined;
		return canonicalWorkRoot;
	} catch {
		return undefined;
	}
}

/** Create one Metis-owned disposable directory for an agent run. */
export function createSessionWorkDir(agentDir: string, sessionId: string): string {
	assertValidSessionId(sessionId);
	const root = getOwnedSessionWorkRoot(agentDir, true);
	if (!root) throw new Error("Unable to create the Metis document work root");
	return mkdtempSync(join(root, `${sessionId}-`));
}

/** Return an exact Metis-owned attachment directory, or undefined if ownership cannot be proven. */
export function getOwnedSessionAttachmentDir(agentDir: string, sessionId: string): string | undefined {
	try {
		assertValidSessionId(sessionId);
		const resolvedAgentDir = resolvePath(agentDir);
		const canonicalAgentDir = assertRealDirectory(resolvedAgentDir, "Agent directory");
		const root = join(resolvedAgentDir, "attachments");
		const canonicalRoot = assertRealDirectory(root, "Attachment root");
		if (dirname(canonicalRoot) !== canonicalAgentDir) return undefined;
		const target = join(root, sessionId);
		const canonicalTarget = assertRealDirectory(target, "Session attachment directory");
		if (dirname(canonicalTarget) !== canonicalRoot || relative(root, target) !== sessionId) return undefined;
		return target;
	} catch {
		return undefined;
	}
}

/** Return only direct mkdtemp work directories owned by one session. */
export function getOwnedSessionWorkDirs(agentDir: string, sessionId: string): readonly string[] {
	assertValidSessionId(sessionId);
	const resolvedAgentDir = resolvePath(agentDir);
	if (!existsSync(resolvedAgentDir)) return [];
	const canonicalAgentDir = assertRealDirectory(resolvedAgentDir, "Agent directory");
	const tmpRoot = join(resolvedAgentDir, "tmp");
	if (!existsSync(tmpRoot)) return [];
	const canonicalTmpRoot = assertRealDirectory(tmpRoot, "Temporary root");
	if (dirname(canonicalTmpRoot) !== canonicalAgentDir) throw new Error("Temporary root escapes the agent directory");
	const workRoot = join(tmpRoot, "document-work");
	if (!existsSync(workRoot)) return [];
	const canonicalWorkRoot = assertRealDirectory(workRoot, "Document work root");
	if (dirname(canonicalWorkRoot) !== canonicalTmpRoot)
		throw new Error("Document work root escapes the temporary root");

	const prefix = `${sessionId}-`;
	const result: string[] = [];
	for (const name of readdirSync(workRoot).sort()) {
		if (!name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) continue;
		const path = join(canonicalWorkRoot, name);
		const metadata = lstatSync(path);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error(`Session document work path must be a real directory: ${path}`);
		}
		if (dirname(realpathSync(path)) !== canonicalWorkRoot) {
			throw new Error(`Session document work path escapes its root: ${path}`);
		}
		result.push(path);
	}
	return result;
}

/**
 * Remove directories and other non-file entries accidentally created beside
 * attachments. Uploaded files and final deliverables are regular files.
 */
export function clearSessionAttachmentNonFiles(agentDir: string, sessionId: string): number {
	const directory = getOwnedSessionAttachmentDir(agentDir, sessionId);
	if (!directory) return 0;
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return 0;
	}
	for (const name of names) {
		if (name === SESSION_DELIVERED_DIR_NAME) continue;
		const path = join(directory, name);
		try {
			if (lstatSync(path).isFile()) continue;
			rmSync(path, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Best effort: a later run or session deletion can retry.
		}
	}
	return removed;
}

/** Remove one exact Metis-owned run directory without following symlinks. */
export function clearSessionWorkDir(agentDir: string, workDir: string): boolean {
	const root = getOwnedSessionWorkRoot(agentDir, false);
	if (!root) return false;
	const target = resolvePath(workDir);
	if (dirname(target) !== root) return false;
	try {
		rmSync(target, { recursive: true, force: true });
		return !existsSync(target);
	} catch {
		return false;
	}
}

/** Best-effort crash recovery for run directories older than the retention window. */
export function pruneStaleSessionWorkDirs(
	agentDir: string,
	maxAgeMs = SESSION_WORK_MAX_AGE_MS,
	now = Date.now(),
): number {
	const root = getOwnedSessionWorkRoot(agentDir, false);
	if (!root) return 0;
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return 0;
	}
	for (const name of names) {
		const path = join(root, name);
		try {
			if (now - lstatSync(path).mtimeMs < maxAgeMs) continue;
			rmSync(path, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Best effort: active or locked entries are retried on a later startup.
		}
	}
	return removed;
}

export function importSessionAttachments(options: {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly attachments: readonly SessionAttachmentInput[];
	readonly key?: string;
	/** Reports files created by this import, excluding existing idempotent copies. */
	readonly onFileCreated?: (path: string) => void;
}): SessionAttachment[] {
	if (options.attachments.length > MAX_SESSION_ATTACHMENTS) {
		throw new Error(`A prompt can attach at most ${MAX_SESSION_ATTACHMENTS} files`);
	}
	if (options.attachments.length === 0) return [];

	const directory = ensureAttachmentDirectory(options.agentDir, options.sessionId);
	const imported: SessionAttachment[] = [];
	const created: string[] = [];
	let totalBytes = 0;
	try {
		for (const [index, attachment] of options.attachments.entries()) {
			const source = resolvePath(attachment.path, options.cwd, { trim: true });
			const sourceMetadata = lstatSync(source);
			if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
				throw new Error(`Attachment must be a regular file: ${attachment.path}`);
			}
			if (sourceMetadata.size === 0) throw new Error(`Attachment is empty: ${attachment.path}`);
			if (sourceMetadata.size > MAX_SESSION_ATTACHMENT_BYTES) {
				throw new Error(`Attachment exceeds ${MAX_SESSION_ATTACHMENT_BYTES} bytes: ${attachment.path}`);
			}
			totalBytes += sourceMetadata.size;
			if (totalBytes > MAX_SESSION_ATTACHMENTS_BYTES) {
				throw new Error(`Attachments exceed ${MAX_SESSION_ATTACHMENTS_BYTES} bytes in total`);
			}

			const name = attachmentName(attachment.name ?? source);
			const token = options.key
				? createHash("sha256")
						.update(`${options.key}:${index}:${source}:${sourceMetadata.size}:${sourceMetadata.mtimeMs}`)
						.digest("hex")
						.slice(0, 16)
				: randomUUID();
			const extension = extname(name);
			const suffix = /^\.[a-z0-9_-]{1,31}$/i.test(extension) ? extension : "";
			const destination = join(directory, `${token}${suffix}`);
			try {
				copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
				created.push(destination);
				if (process.platform !== "win32") chmodSync(destination, 0o600);
			} catch (error) {
				if (!options.key || !existsSync(destination)) throw error;
			}
			const copied = lstatSync(destination);
			if (copied.isSymbolicLink() || !copied.isFile() || copied.size !== sourceMetadata.size) {
				throw new Error(`Attachment changed while it was being copied: ${attachment.path}`);
			}
			const path = realpathSync(destination);
			imported.push({ name, path, size: sourceMetadata.size });
			if (created.includes(destination)) options.onFileCreated?.(path);
		}
		return imported;
	} catch (error) {
		for (const path of created) rmSync(path, { force: true });
		throw error;
	}
}

export function removeSessionAttachment(agentDir: string, sessionId: string, attachmentPath: string): boolean {
	const directory = getOwnedSessionAttachmentDir(agentDir, sessionId);
	if (!directory) return false;
	try {
		const resolved = resolvePath(attachmentPath);
		if (dirname(resolved) !== realpathSync(directory)) return false;
		const metadata = lstatSync(resolved);
		if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
		rmSync(resolved);
		return !existsSync(resolved);
	} catch {
		return false;
	}
}

function ensureOwnedSessionDeliveredDir(agentDir: string, sessionId: string): string {
	const attachmentDir = ensureAttachmentDirectory(agentDir, sessionId);
	const delivered = join(attachmentDir, SESSION_DELIVERED_DIR_NAME);
	if (!existsSync(delivered)) mkdirSync(delivered);
	const canonicalDelivered = assertRealDirectory(delivered, "Delivered files directory");
	if (dirname(canonicalDelivered) !== realpathSync(attachmentDir)) {
		throw new Error("Delivered files directory escapes the session attachment directory");
	}
	return canonicalDelivered;
}

/** Return the Metis-owned delivered-files directory for one session, if it exists. */
export function getOwnedSessionDeliveredDir(agentDir: string, sessionId: string): string | undefined {
	const attachmentDir = getOwnedSessionAttachmentDir(agentDir, sessionId);
	if (!attachmentDir) return undefined;
	const delivered = join(attachmentDir, SESSION_DELIVERED_DIR_NAME);
	if (!existsSync(delivered)) return undefined;
	try {
		const canonicalDelivered = assertRealDirectory(delivered, "Delivered files directory");
		if (dirname(canonicalDelivered) !== realpathSync(attachmentDir)) return undefined;
		return canonicalDelivered;
	} catch {
		return undefined;
	}
}

export function deliveredFileStorageName(fileId: string, name: string): string {
	if (!/^[a-f0-9]{16}$/u.test(fileId)) throw new TypeError("Invalid delivered file id");
	const extension = extname(name);
	const suffix = /^\.[a-z0-9_-]{1,31}$/i.test(extension) ? extension : "";
	return `${fileId}${suffix}`;
}

/** Resolve one staged delivered file by id within a Metis-owned session directory. */
export function resolveDeliveredFilePath(
	agentDir: string,
	sessionId: string,
	fileId: string,
	name: string,
): string | undefined {
	let storageName: string;
	try {
		storageName = deliveredFileStorageName(fileId, name);
	} catch {
		return undefined;
	}
	const deliveredDir = getOwnedSessionDeliveredDir(agentDir, sessionId);
	if (!deliveredDir) return undefined;
	const path = join(deliveredDir, storageName);
	try {
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
		const resolved = realpathSync(path);
		if (dirname(resolved) !== realpathSync(deliveredDir)) return undefined;
		return resolved;
	} catch {
		return undefined;
	}
}

/** Copy staged delivered files into a forked session so open/reveal keeps working. */
export function copySessionDeliveredFiles(options: {
	readonly agentDir: string;
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly artifacts: readonly { readonly fileId: string; readonly name: string; readonly byteLength: number }[];
}): void {
	try {
		if (options.artifacts.length === 0) return;
		const sourceDir = getOwnedSessionDeliveredDir(options.agentDir, options.sourceSessionId);
		if (!sourceDir) return;
		const targetDir = ensureOwnedSessionDeliveredDir(options.agentDir, options.targetSessionId);
		for (const artifact of options.artifacts) {
			let storageName: string;
			try {
				storageName = deliveredFileStorageName(artifact.fileId, artifact.name);
			} catch {
				continue;
			}
			const sourcePath = join(sourceDir, storageName);
			const destination = join(targetDir, storageName);
			try {
				const metadata = lstatSync(sourcePath);
				if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.byteLength) continue;
				copyFileSync(sourcePath, destination, fsConstants.COPYFILE_EXCL);
				if (process.platform !== "win32") chmodSync(destination, 0o600);
			} catch {
				// Best-effort copy keeps fork usable even when one file is missing.
			}
		}
	} catch {
		// Best-effort copy also keeps fork usable when its target directory is unavailable.
		return;
	}
}

/** Remove files in one owned delivered directory that have no durable journal reference. */
export function removeUnreferencedSessionDeliveredFiles(
	agentDir: string,
	sessionId: string,
	referencedArtifacts: readonly { readonly fileId: string; readonly name: string }[],
): void {
	const deliveredDir = getOwnedSessionDeliveredDir(agentDir, sessionId);
	if (!deliveredDir) return;
	let names: string[];
	try {
		names = readdirSync(deliveredDir);
	} catch {
		return;
	}
	const referencedNames = new Set(
		referencedArtifacts.flatMap((artifact) => {
			try {
				return [deliveredFileStorageName(artifact.fileId, artifact.name)];
			} catch {
				return [];
			}
		}),
	);
	for (const name of names) {
		if (referencedNames.has(name)) continue;
		try {
			rmSync(join(deliveredDir, name), { force: true });
		} catch {
			// Reconciliation is best-effort; an unsafe entry remains inaccessible through resolve().
		}
	}
}

export function formatSessionAttachments(text: string, attachments: readonly SessionAttachment[]): string {
	if (attachments.length === 0) return text;
	const block = stringifyPromptJson(
		attachments.map(({ name, path, size }) => ({ name, path, size })),
		2,
	);
	const attachmentBlock = `<attachments>\n${block}\n</attachments>`;
	const prompt = text.trimStart();
	return prompt ? `${prompt}\n\n${attachmentBlock}` : attachmentBlock;
}

export function formatSessionAttachment(attachment: SessionAttachment): string {
	return `<attachment>${stringifyPromptJson(attachment)}</attachment>`;
}

function parseSessionAttachments(value: unknown): SessionAttachment[] | undefined {
	const values = Array.isArray(value) ? value : [value];
	if (values.length === 0 || values.length > MAX_SESSION_ATTACHMENTS) return undefined;
	const attachments: SessionAttachment[] = [];
	for (const attachment of values) {
		if (
			typeof attachment !== "object" ||
			attachment === null ||
			typeof (attachment as Record<string, unknown>).name !== "string" ||
			typeof (attachment as Record<string, unknown>).path !== "string" ||
			typeof (attachment as Record<string, unknown>).size !== "number"
		) {
			return undefined;
		}
		let name: string;
		try {
			name = attachmentName((attachment as { name: string }).name);
		} catch {
			return undefined;
		}
		const path = (attachment as { path: string }).path;
		const size = (attachment as { size: number }).size;
		if (!name || !path || !Number.isFinite(size) || size < 0) return undefined;
		attachments.push({ name, path, size });
	}
	return attachments;
}

function replaceTaggedAttachments(
	text: string,
	tag: "attachment" | "attachments",
	replacement: (attachments: readonly SessionAttachment[]) => string,
): string {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	let cursor = 0;
	let output = "";
	while (true) {
		const start = text.indexOf(open, cursor);
		if (start < 0) return output + text.slice(cursor);
		const end = text.indexOf(close, start + open.length);
		if (end < 0) return output + text.slice(cursor);
		let attachments: SessionAttachment[] | undefined;
		try {
			attachments = parseSessionAttachments(JSON.parse(text.slice(start + open.length, end).trim()));
		} catch {}
		if (!attachments) {
			output += text.slice(cursor, end + close.length);
			cursor = end + close.length;
			continue;
		}
		output += text.slice(cursor, start) + replacement(attachments);
		cursor = end + close.length;
	}
}

export function replaceSessionAttachmentReferences(
	text: string,
	replacement: (attachments: readonly SessionAttachment[]) => string,
): string {
	return replaceTaggedAttachments(
		replaceTaggedAttachments(text, "attachments", replacement),
		"attachment",
		replacement,
	);
}

/** Separate user-visible text from private model-facing attachment metadata. */
export function splitSessionAttachmentPrompt(text: string): {
	readonly text: string;
	readonly attachments: readonly SessionAttachment[];
	readonly fileSelections: readonly SessionFileSelection[];
	readonly conversationQuotes?: readonly SessionConversationQuote[];
} {
	const attachments: SessionAttachment[] = [];
	const publicText = replaceSessionAttachmentReferences(text, (found) => {
		attachments.push(...found);
		return "";
	}).trim();
	const quotes = splitSessionConversationQuotePrompt(publicText);
	return {
		...splitSessionFileSelectionPrompt(quotes.text),
		attachments,
		...(quotes.conversationQuotes.length ? { conversationQuotes: quotes.conversationQuotes } : {}),
	};
}

/** Replace private model-facing attachment metadata with compact CLI labels. */
export function formatSessionAttachmentDisplayText(text: string): string {
	return formatSessionConversationQuoteDisplayText(
		formatSessionFileSelectionDisplayText(
			replaceSessionAttachmentReferences(text, (attachments) =>
				attachments.map(({ name }) => `[${name}]`).join(" "),
			),
		),
	);
}
