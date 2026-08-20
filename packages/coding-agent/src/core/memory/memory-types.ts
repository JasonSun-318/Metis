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
