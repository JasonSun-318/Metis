import { createHash } from "node:crypto";

export const MAX_FACTS_PER_MUTATION = 32;
export const MAX_FACT_TEXT_CHARS = 4_000;
export const MAX_RECONCILE_OPERATIONS = 200;
export const MAX_TOPICS_PER_CONTEXT = 32;
export const MAX_ORDINARY_TOPICS_PER_CONTEXT = 30;
export const SAFE_TOPIC_FILE = /^(?!.*\.\.)[a-z0-9][a-z0-9._-]{0,119}\.md$/u;
export const RESERVED_TOPIC_FILES = new Set(["memory.md", "project.md", "overflow.md", "legacy-overflow.md"]);

export function isSafeTopicFile(value: string): boolean {
	return SAFE_TOPIC_FILE.test(value) && !RESERVED_TOPIC_FILES.has(value);
}

export function isManagedProjectionTopicFile(value: string): boolean {
	return SAFE_TOPIC_FILE.test(value) && value !== "memory.md" && value !== "project.md";
}

export function normalizeMemoryFactText(text: string): string {
	return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function memoryFactFingerprint(text: string): string {
	return createHash("sha256").update(normalizeMemoryFactText(text)).digest("hex");
}

export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_FACT_STATUSES = ["active", "superseded", "deleted"] as const;
export type MemoryFactStatus = (typeof MEMORY_FACT_STATUSES)[number];

export interface MemoryFact {
	id: string;
	scope: MemoryScope;
	cwdKey: string | null;
	mode: string | null;
	topicFile: string;
	text: string;
	/** Filled by MemoryStore on insert and always present on persisted rows. */
	fingerprint?: string | null;
	status: MemoryFactStatus;
	createdAt: string;
	sourceTurn: string | null;
	embedding: Float32Array | null;
	embeddingModel: string | null;
}

export interface MemorySearchOptions {
	scope: MemoryScope;
	cwdKey: string | null;
	mode: string | null;
	limit: number;
}

export interface MemorySearchHit {
	id: string;
	text: string;
	score: number;
	scope: MemoryScope;
	topicFile: string;
	createdAt: string;
}

export const MEMORY_EXTRACT_RUN_STATUSES = ["success", "failed", "skipped"] as const;
export type MemoryExtractRunStatus = (typeof MEMORY_EXTRACT_RUN_STATUSES)[number];

export interface MemoryExtractRun {
	id: string;
	startedAt: string;
	trigger: string;
	status: MemoryExtractRunStatus;
	reason: string | null;
}

export const MEMORY_HEALTH_OPERATIONS = [
	"extract",
	"embedding",
	"rerank",
	"backfill",
	"projection",
	"migration",
] as const;
export type MemoryHealthOperation = (typeof MEMORY_HEALTH_OPERATIONS)[number];

export const MEMORY_HEALTH_STATUSES = ["running", "ok", "error"] as const;
export type MemoryHealthStatus = (typeof MEMORY_HEALTH_STATUSES)[number];

export interface MemoryHealth {
	operation: MemoryHealthOperation;
	status: MemoryHealthStatus;
	updatedAt: string;
	reason: string | null;
}
