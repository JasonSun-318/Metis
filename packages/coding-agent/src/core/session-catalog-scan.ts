import type { Message, TextContent } from "@metis/ai";
import { existsSync, constants as fsConstants } from "fs";
import { lstat, open, readdir } from "fs/promises";
import { join } from "path";
import { setImmediate as yieldToEventLoop } from "timers/promises";
import { TextDecoder } from "util";
import { DEFAULT_PERMISSION_PRESET } from "./permissions/settings.ts";
import { isRuntimeControlEntryType } from "./runtime-recovery.ts";
import { formatSessionAttachmentDisplayText } from "./session-attachments.ts";
import { isSessionControlEntryType } from "./session-control.ts";
import { CorruptSessionError } from "./session-journal.ts";
import { MAX_SESSION_RECORD_BYTES, SESSION_READ_BUFFER_BYTES } from "./session-limits.ts";
import type { SessionEntry, SessionHeader, SessionInfo, SessionMessageEntry } from "./session-manager.ts";
import {
	CURRENT_SESSION_VERSION,
	corruptSession,
	isJsonObject,
	migrateLegacyPermissionFields,
	migrateLegacyPermissionJournalRecord,
	validateAgentConversationVersion,
	validateSessionRecordVersion,
	validateSourceSessionHeaderVersion,
} from "./session-migrations.ts";
import {
	parseRuntimeRecord,
	parseSessionControlRecord,
	validateControlGraphEntry,
	validateRawSessionRecord,
	validateSessionGraphEntry,
	validateSessionHeader,
} from "./session-record-validation.ts";

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
		const version = validateSourceSessionHeaderVersion(raw, filePath);
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
	validateSessionRecordVersion(raw.type as string, header.version ?? 1, filePath, index + 1);
	validateAgentConversationVersion(raw, header.version ?? 1, filePath, index + 1);
	if ((header.version ?? 1) < CURRENT_SESSION_VERSION) {
		migrateLegacyPermissionJournalRecord(raw, filePath, index + 1);
	}
	const type = raw.type as string;
	if (type.startsWith("runtime_")) {
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

export async function buildSessionInfosWithConcurrency(
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

export async function listSessionsFromDir(
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
