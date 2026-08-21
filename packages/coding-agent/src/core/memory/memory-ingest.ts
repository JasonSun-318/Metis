import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import {
	getAutoMemoryRoot,
	getGlobalMemoryDirectory,
	getMemorySqlitePath,
	getProjectMemoryDirectory,
} from "../auto-memory.ts";
import { readSingleLinkFilePrefixSync } from "../durable-file.ts";
import { looksLikeSecret } from "./memory-secrets.ts";
import { type MemoryIngestContextKey, type MemoryStore, openMemoryStore } from "./memory-store.ts";
import type { MemoryFact, MemoryScope } from "./memory-types.ts";

const MAX_INDEX_BYTES = 25 * 1024;
const MAX_INDEX_LINES = 200;
const MAX_TOPIC_BYTES = 1024 * 1024;
const MAX_AGGREGATE_TOPIC_BYTES = 16 * 1024 * 1024;
const MAX_FACT_CHARACTERS = 4_000;
const INDEX_ENTRY = /^- \[([^\]]+\.md)\]\(\1\) — .{1,120}$/u;
const SAFE_MEMORY_FILE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;
const INGEST_LOCK_OPTIONS = {
	realpath: false,
	stale: 15_000,
	retries: { retries: 8, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true },
} as const;

export async function ingestGlobalMarkdownOnce(agentDir: string): Promise<void> {
	const memoryRoot = getAutoMemoryRoot(agentDir);
	if (!existsSync(memoryRoot)) return;
	await withMemoryLock(memoryRoot, async () => {
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		try {
			if (store.isMarkdownRecoveryHandled("global")) return;
			const preferred = join(getGlobalMemoryDirectory(agentDir), "MEMORY.md");
			const indexPath = existsSync(preferred) ? preferred : join(memoryRoot, "MEMORY.md");
			const recovery =
				store.listActiveFacts("global", null, null).length === 0
					? collectFacts(indexPath, "global", null)
					: { facts: [], warnings: [] };
			commitRecovery(store, "global", recovery);
		} finally {
			store.close();
		}
	});
}

export async function ingestExactProjectProjectionOnce(agentDir: string, projectKey: string): Promise<void> {
	if (!/^[0-9a-f]{64}$/u.test(projectKey)) throw new Error("Invalid memory project key");
	const memoryRoot = getAutoMemoryRoot(agentDir);
	if (!existsSync(memoryRoot)) return;
	await withMemoryLock(memoryRoot, async () => {
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		try {
			const contextKey = `project:${projectKey}` as const;
			if (store.isMarkdownRecoveryHandled(contextKey)) return;
			const recovery =
				store.listActiveFacts("project", projectKey, null).length === 0
					? collectFacts(
							join(getProjectMemoryDirectory(agentDir, projectKey), "project.md"),
							"project",
							projectKey,
						)
					: { facts: [], warnings: [] };
			commitRecovery(store, contextKey, recovery);
		} finally {
			store.close();
		}
	});
}

/** @deprecated Use the scoped recovery entry points. */
export const ingestMarkdownIfEmpty = ingestGlobalMarkdownOnce;

function commitRecovery(
	store: MemoryStore,
	contextKey: MemoryIngestContextKey,
	recovery: { facts: MemoryFact[]; warnings: string[] },
): void {
	const now = new Date().toISOString();
	store.runInTransaction(() => {
		for (const fact of recovery.facts) store.insertFact(fact);
		store.markMarkdownRecoveryHandled(contextKey, now);
		store.recordHealth({
			operation: "migration",
			status: recovery.warnings.length === 0 ? "ok" : "error",
			updatedAt: now,
			reason: recovery.warnings.length === 0 ? null : recovery.warnings.join("; "),
		});
	});
}

function collectFacts(
	indexPath: string,
	scope: MemoryScope,
	projectKey: string | null,
): {
	facts: MemoryFact[];
	warnings: string[];
} {
	const warnings: string[] = [];
	let index: { lines: string[]; partial: boolean };
	try {
		index = readIndex(indexPath);
	} catch (error) {
		return { facts: [], warnings: [`Skipped unsafe memory index: ${errorMessage(error)}`] };
	}
	if (index.partial) warnings.push("Memory index recovery was truncated to bounded complete input");

	const facts: MemoryFact[] = [];
	const createdAt = new Date().toISOString();
	const seenTopics = new Set<string>();
	let aggregateBytes = 0;
	for (const line of index.lines) {
		const match = INDEX_ENTRY.exec(line.trim());
		if (!match) continue;
		const topicFile = match[1]!;
		if (!SAFE_MEMORY_FILE.test(topicFile) || seenTopics.has(topicFile)) continue;
		seenTopics.add(topicFile);
		if (aggregateBytes >= MAX_AGGREGATE_TOPIC_BYTES) {
			warnings.push("Memory topic recovery reached the aggregate byte limit");
			break;
		}

		const limit = Math.min(MAX_TOPIC_BYTES, MAX_AGGREGATE_TOPIC_BYTES - aggregateBytes);
		let topic: ReturnType<typeof readSingleLinkFilePrefixSync>;
		try {
			topic = readSingleLinkFilePrefixSync(join(dirname(indexPath), topicFile), limit);
		} catch (error) {
			warnings.push(`Skipped unsafe memory topic ${topicFile}: ${errorMessage(error)}`);
			continue;
		}
		if (!topic) continue;
		aggregateBytes += topic.bytes.byteLength;
		if (topic.truncated) warnings.push(`Memory topic ${topicFile} was truncated during recovery`);
		const body = decodeCompleteUtf8Prefix(topic.bytes, topic.truncated);
		for (const chunk of splitTopicChunks(body)) {
			if (looksLikeSecret(chunk)) continue;
			facts.push({
				id: randomUUID(),
				scope,
				cwdKey: projectKey,
				mode: null,
				topicFile,
				text: chunk,
				status: "active",
				createdAt,
				sourceTurn: "ingest",
				embedding: null,
				embeddingModel: null,
			});
		}
	}
	return { facts, warnings };
}

function readIndex(indexPath: string): { lines: string[]; partial: boolean } {
	const source = readSingleLinkFilePrefixSync(indexPath, MAX_INDEX_BYTES);
	if (!source) return { lines: [], partial: false };
	let text = decodeCompleteUtf8Prefix(source.bytes, source.truncated);
	if (source.truncated) {
		const lastLineBreak = text.lastIndexOf("\n");
		text = lastLineBreak < 0 ? "" : text.slice(0, lastLineBreak);
	}
	const lines = text.split(/\r?\n/u);
	const tooManyLines = lines.length > MAX_INDEX_LINES;
	return { lines: lines.slice(0, MAX_INDEX_LINES), partial: source.truncated || tooManyLines };
}

function splitTopicChunks(body: string): string[] {
	const chunks: string[] = [];
	for (const section of body.split(/(?=^#{1,6}\s+)/mu)) {
		for (const paragraph of section.split(/\n\s*\n/u)) {
			let remaining = paragraph.trim();
			while (remaining.length > 0) {
				const chunk = takeUnicodePrefix(remaining, MAX_FACT_CHARACTERS).trim();
				if (chunk) chunks.push(chunk);
				remaining = remaining.slice(chunk.length).trimStart();
			}
		}
	}
	return chunks;
}

function takeUnicodePrefix(text: string, maxCharacters: number): string {
	let end = 0;
	let count = 0;
	for (const character of text) {
		if (count >= maxCharacters) break;
		end += character.length;
		count += 1;
	}
	return text.slice(0, end);
}

function decodeCompleteUtf8Prefix(bytes: Buffer, mayEndMidCharacter: boolean): string {
	if (!mayEndMidCharacter) return bytes.toString("utf8");
	for (let end = bytes.length; end >= Math.max(0, bytes.length - 3); end--) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
		} catch {
			// A UTF-8 code point spans at most four bytes.
		}
	}
	return "";
}

async function withMemoryLock<T>(memoryRoot: string, operation: () => Promise<T>): Promise<T> {
	const release = await lockfile.lock(memoryRoot, INGEST_LOCK_OPTIONS);
	let primaryError: unknown;
	let result: T | undefined;
	try {
		result = await operation();
	} catch (error) {
		primaryError = error;
	}
	let releaseError: unknown;
	try {
		await release();
	} catch (error) {
		releaseError = error;
	}
	if (primaryError !== undefined) throw primaryError;
	if (releaseError !== undefined) throw releaseError;
	return result as T;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 200);
}
