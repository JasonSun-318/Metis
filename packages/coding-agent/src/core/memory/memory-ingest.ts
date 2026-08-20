import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getAutoMemoryRoot, getMemorySqlitePath } from "../auto-memory.ts";
import { looksLikeSecret } from "./memory-secrets.ts";
import { openMemoryStore } from "./memory-store.ts";
import type { MemoryFact, MemoryScope } from "./memory-types.ts";

const INDEX_ENTRY = /^- \[([^\]]+\.md)\]\(\1\) — (.{1,120})$/u;
const SAFE_MEMORY_FILE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;
const INGEST_LOCK_OPTIONS = {
	realpath: false,
	stale: 15_000,
	retries: {
		retries: 8,
		factor: 1.5,
		minTimeout: 20,
		maxTimeout: 250,
		randomize: true,
	},
} as const;

/** One-time Markdown → SQLite ingest when the facts table is empty. */
export async function ingestMarkdownIfEmpty(agentDir: string): Promise<void> {
	const memoryDir = getAutoMemoryRoot(agentDir);
	if (!existsSync(memoryDir)) return;

	const release = await lockfile.lock(memoryDir, INGEST_LOCK_OPTIONS);
	try {
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		try {
			if (store.countFacts() > 0) return;
			const facts = collectFactsFromMemoryRoot(memoryDir);
			if (facts.length === 0) return;
			store.runInTransaction(() => {
				for (const fact of facts) store.insertFact(fact);
			});
		} finally {
			store.close();
		}
	} finally {
		await release();
	}
}

function collectFactsFromMemoryRoot(memoryDir: string): MemoryFact[] {
	const facts: MemoryFact[] = [];
	facts.push(...ingestScopeDirectory(memoryDir, "MEMORY.md", "global", null, null));

	const projectsDir = join(memoryDir, "projects");
	if (!existsSync(projectsDir)) return facts;

	for (const cwdEntry of readdirSync(projectsDir, { withFileTypes: true })) {
		if (!cwdEntry.isDirectory()) continue;
		const cwdKey = cwdEntry.name;
		const cwdPath = join(projectsDir, cwdKey);
		for (const modeEntry of readdirSync(cwdPath, { withFileTypes: true })) {
			if (!modeEntry.isDirectory()) continue;
			const mode = modeEntry.name;
			facts.push(...ingestScopeDirectory(join(cwdPath, mode), "project.md", "project", cwdKey, mode));
		}
	}
	return facts;
}

function ingestScopeDirectory(
	directory: string,
	indexFile: string,
	scope: MemoryScope,
	cwdKey: string | null,
	mode: string | null,
): MemoryFact[] {
	const indexPath = join(directory, indexFile);
	if (!existsSync(indexPath)) return [];

	let indexContent: string;
	try {
		indexContent = readFileSync(indexPath, "utf8");
	} catch {
		return [];
	}

	const facts: MemoryFact[] = [];
	const createdAt = new Date().toISOString();
	for (const line of indexContent.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = INDEX_ENTRY.exec(trimmed);
		if (!match) continue;
		const topicFile = match[1]!;
		if (!SAFE_MEMORY_FILE.test(topicFile) || topicFile === indexFile) continue;

		const topicPath = join(directory, topicFile);
		if (!existsSync(topicPath)) continue;
		let topicBody: string;
		try {
			topicBody = readFileSync(topicPath, "utf8");
		} catch {
			continue;
		}

		for (const chunk of splitTopicChunks(topicBody)) {
			if (looksLikeSecret(chunk)) continue;
			facts.push({
				id: randomUUID(),
				scope,
				cwdKey,
				mode,
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
	return facts;
}

function splitTopicChunks(body: string): string[] {
	const chunks: string[] = [];
	for (const section of body.split(/(?=^#{1,6}\s+)/m)) {
		for (const paragraph of section.split(/\n\s*\n/)) {
			const trimmed = paragraph.trim();
			if (trimmed) chunks.push(trimmed);
		}
	}
	return chunks;
}
