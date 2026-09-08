import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAutoMemoryRoot, getGlobalMemoryDirectory, getProjectMemoryDirectory } from "../auto-memory.ts";
import {
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	syncDirectorySync,
	syncFileSync,
	writeAllSync,
} from "../durable-file.ts";
import { withMemoryRootLock } from "./memory-lock.ts";
import type { MemoryProjectionFact, MemoryStore } from "./memory-store.ts";
import { isManagedProjectionTopicFile, MAX_TOPICS_PER_CONTEXT } from "./memory-types.ts";

const INDEX_SENTENCE_MAX = 120;
const INDEX_MAX_BYTES = 25 * 1024;
const STRICT_INDEX_ENTRY = /^- \[([^\]]+\.md)\]\(\1\) — .{1,120}$/u;

interface TopicMetadata {
	topicFile: string;
	latestCreatedAt: string;
	sentence: string;
}

export async function withMemoryProjectionLock<T>(agentDir: string, fn: () => Promise<T> | T): Promise<T> {
	const root = getAutoMemoryRoot(agentDir);
	ensureRealDirectoryDurablySync(root, 0o700);
	return withMemoryRootLock(root, fn);
}

export async function writeProjection(agentDir: string, projectKey: string, store: MemoryStore): Promise<void> {
	const now = new Date().toISOString();
	store.recordHealth({ operation: "projection", status: "running", updatedAt: now, reason: null });
	try {
		await withMemoryProjectionLock(agentDir, async () => {
			await writeScopeProjection(
				getGlobalMemoryDirectory(agentDir),
				"MEMORY.md",
				store.iterateProjectionFacts(null),
			);
			await writeScopeProjection(
				getProjectMemoryDirectory(agentDir, projectKey),
				"project.md",
				store.iterateProjectionFacts(projectKey),
			);
		});
		store.recordHealth({ operation: "projection", status: "ok", updatedAt: new Date().toISOString(), reason: null });
	} catch (error) {
		store.recordHealth({
			operation: "projection",
			status: "error",
			updatedAt: new Date().toISOString(),
			reason: errorMessage(error),
		});
		throw error;
	}
}

export async function writeGlobalProjection(agentDir: string, store: MemoryStore): Promise<void> {
	await withMemoryProjectionLock(agentDir, () =>
		writeScopeProjection(getGlobalMemoryDirectory(agentDir), "MEMORY.md", store.iterateProjectionFacts(null)),
	);
}

export const rebuildGlobalProjection = writeGlobalProjection;

export async function writeProjectProjection(agentDir: string, projectKey: string, store: MemoryStore): Promise<void> {
	await withMemoryProjectionLock(agentDir, () =>
		writeScopeProjection(
			getProjectMemoryDirectory(agentDir, projectKey),
			"project.md",
			store.iterateProjectionFacts(projectKey),
		),
	);
}

async function writeScopeProjection(
	directory: string,
	indexFile: "MEMORY.md" | "project.md",
	facts: Iterable<MemoryProjectionFact>,
): Promise<void> {
	ensureRealDirectoryDurablySync(directory, 0o700);
	const oldTopics = readOldTopics(join(directory, indexFile));
	const published = new Set<string>();
	const metadata: TopicMetadata[] = [];
	let currentTopic: string | undefined;
	let temporary: string | undefined;
	let fd: number | undefined;
	let latestCreatedAt = "";
	let sentence = "";
	let rowCount = 0;

	const publishCurrent = () => {
		if (!currentTopic || !temporary || fd === undefined) return;
		syncFileSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, join(directory, currentTopic));
		syncDirectorySync(directory);
		published.add(currentTopic);
		metadata.push({ topicFile: currentTopic, latestCreatedAt, sentence });
		temporary = undefined;
	};

	let operationError: unknown;
	try {
		for (const fact of facts) {
			if (!isManagedProjectionTopicFile(fact.topicFile))
				throw new Error(`Invalid managed memory topic: ${fact.topicFile}`);
			if (fact.topicFile !== currentTopic) {
				publishCurrent();
				if (metadata.length >= MAX_TOPICS_PER_CONTEXT)
					throw new Error("Memory context exceeds the 32-topic projection limit");
				currentTopic = fact.topicFile;
				latestCreatedAt = fact.createdAt;
				sentence = "";
				temporary = join(directory, `.${fact.topicFile}.${randomUUID()}.tmp`);
				fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			}
			latestCreatedAt = fact.createdAt > latestCreatedAt ? fact.createdAt : latestCreatedAt;
			sentence = appendRetrievalText(sentence, fact.text);
			writeAllSync(fd!, Buffer.from(`${fact.text}${fact.text.endsWith("\n") ? "" : "\n"}`));
			if (++rowCount % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		}
		publishCurrent();
		for (const stale of oldTopics) {
			if (!published.has(stale)) removeStableGeneratedTopic(join(directory, stale));
		}
		metadata.sort(
			(a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt) || a.topicFile.localeCompare(b.topicFile),
		);
		const index = metadata.map((topic) => indexLine(topic.topicFile, topic.sentence)).join("\n");
		replaceFileAtomicallySync(join(directory, indexFile), index ? `${index}\n` : "", { mode: 0o600 });
	} catch (error) {
		operationError = error;
	}
	let cleanupError: unknown;
	try {
		if (fd !== undefined) closeSync(fd);
		if (temporary) {
			try {
				unlinkSync(temporary);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
			}
		}
	} catch (error) {
		cleanupError = error;
	}
	if (operationError !== undefined) throw operationError;
	if (cleanupError !== undefined) throw cleanupError;
}

function readOldTopics(indexPath: string): Set<string> {
	const contents = readSingleLinkTextFileSync(indexPath, { maxBytes: INDEX_MAX_BYTES });
	if (contents === undefined || contents === "") return new Set();
	const topics = new Set<string>();
	for (const line of contents.split(/\r?\n/u)) {
		if (!line) continue;
		const match = STRICT_INDEX_ENTRY.exec(line);
		if (!match || !isManagedProjectionTopicFile(match[1]!))
			throw new Error("Existing memory index is not a strict generated projection");
		topics.add(match[1]!);
	}
	return topics;
}

function removeStableGeneratedTopic(path: string): void {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stats.isFile() || stats.nlink !== 1) throw new Error(`Refusing to delete aliased memory topic: ${path}`);
	unlinkSync(path);
}

function indexLine(topicFile: string, sentence: string): string {
	return `- [${topicFile}](${topicFile}) — ${sentence || "Memory facts"}`;
}

function appendRetrievalText(current: string, text: string): string {
	const normalized = text.replace(/\s+/gu, " ").trim();
	if (!normalized || [...current].length >= INDEX_SENTENCE_MAX) return current;
	return [...`${current}${current && normalized ? " " : ""}${normalized}`].slice(0, INDEX_SENTENCE_MAX).join("");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
