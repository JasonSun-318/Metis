import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { canonicalizePathForCreation, resolvePath } from "../utils/paths.ts";
import { assertValidSessionId } from "./session-id.ts";

export const MAX_SESSION_ATTACHMENTS = 16;
export const MAX_SESSION_ATTACHMENT_BYTES = 128 * 1024 * 1024;
export const MAX_SESSION_ATTACHMENTS_BYTES = 256 * 1024 * 1024;

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

export function getSessionAttachmentWorkDir(agentDir: string, sessionId: string): string {
	return join(getSessionAttachmentDir(agentDir, sessionId), ".work");
}

/** Return an exact ArcMind-owned attachment directory, or undefined if ownership cannot be proven. */
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

/** Best-effort removal of disposable files without following symlinks. */
export function clearSessionAttachmentWorkDir(agentDir: string, sessionId: string): boolean {
	const directory = getOwnedSessionAttachmentDir(agentDir, sessionId);
	if (!directory) return false;
	const workDir = join(directory, ".work");
	try {
		rmSync(workDir, { recursive: true, force: true });
		return !existsSync(workDir);
	} catch {
		return false;
	}
}

export function importSessionAttachments(options: {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly attachments: readonly SessionAttachmentInput[];
	readonly key?: string;
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
			imported.push({ name, path: realpathSync(destination), size: sourceMetadata.size });
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

export function formatSessionAttachments(text: string, attachments: readonly SessionAttachment[]): string {
	if (attachments.length === 0) return text;
	const block = stringifyAttachmentMetadata(
		attachments.map(({ name, path, size }) => ({ name, path, size })),
		2,
	);
	const attachmentBlock = `<attachments>\n${block}\n</attachments>`;
	const prompt = text.trimStart();
	return prompt ? `${prompt}\n\n${attachmentBlock}` : attachmentBlock;
}

function stringifyAttachmentMetadata(value: unknown, space?: number): string {
	return JSON.stringify(value, null, space).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

export function formatSessionAttachment(attachment: SessionAttachment): string {
	return `<attachment>${stringifyAttachmentMetadata(attachment)}</attachment>`;
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

/** Replace private model-facing attachment metadata with compact CLI labels. */
export function formatSessionAttachmentDisplayText(text: string): string {
	return replaceSessionAttachmentReferences(text, (attachments) =>
		attachments.map(({ name }) => `[${name}]`).join(" "),
	);
}
