import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryFact, MemoryScope, MemorySearchHit, MemorySearchOptions } from "./memory-types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  cwd_key TEXT,
  mode TEXT,
  topic_file TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_turn TEXT,
  embedding BLOB,
  embedding_model TEXT
);
CREATE INDEX IF NOT EXISTS facts_scope_status ON facts(scope, status, cwd_key, mode);
`;

type FactRow = {
	id: string;
	scope: string;
	cwd_key: string | null;
	mode: string | null;
	topic_file: string;
	text: string;
	status: string;
	created_at: string;
	source_turn: string | null;
	embedding: Buffer | Uint8Array | null;
	embedding_model: string | null;
};

export interface MemoryStore {
	insertFact(fact: MemoryFact): void;
	searchByEmbedding(query: Float32Array, options: MemorySearchOptions): MemorySearchHit[];
	listActiveFacts(scope: MemoryScope, cwdKey: string | null, mode: string | null): MemoryFact[];
	close(): void;
}

export function openMemoryStore(path: string): MemoryStore {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec(SCHEMA);

	const insert = db.prepare(`
		INSERT INTO facts (
			id, scope, cwd_key, mode, topic_file, text, status, created_at, source_turn, embedding, embedding_model
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const selectActiveGlobal = db.prepare(`
		SELECT id, scope, cwd_key, mode, topic_file, text, status, created_at, source_turn, embedding, embedding_model
		FROM facts
		WHERE scope = ?
		  AND status = 'active'
		  AND cwd_key IS NULL
		  AND mode IS NULL
	`);

	const selectActiveProject = db.prepare(`
		SELECT id, scope, cwd_key, mode, topic_file, text, status, created_at, source_turn, embedding, embedding_model
		FROM facts
		WHERE scope = ?
		  AND status = 'active'
		  AND cwd_key IS ?
		  AND mode IS ?
	`);

	function loadActiveRows(scope: MemoryScope, cwdKey: string | null, mode: string | null): FactRow[] {
		if (scope === "global" || (cwdKey === null && mode === null)) {
			return selectActiveGlobal.all(scope) as FactRow[];
		}
		return selectActiveProject.all(scope, cwdKey, mode) as FactRow[];
	}

	return {
		insertFact(fact) {
			insert.run(
				fact.id,
				fact.scope,
				fact.cwdKey,
				fact.mode,
				fact.topicFile,
				fact.text,
				fact.status,
				fact.createdAt,
				fact.sourceTurn,
				fact.embedding ? embeddingToBlob(fact.embedding) : null,
				fact.embeddingModel,
			);
		},

		searchByEmbedding(query, options) {
			const rows = loadActiveRows(options.scope, options.cwdKey, options.mode);
			const hits: MemorySearchHit[] = [];
			for (const row of rows) {
				const embedding = blobToEmbedding(row.embedding);
				if (!embedding) continue;
				const score = cosineSimilarity(query, embedding);
				if (score === null) continue;
				hits.push({
					id: row.id,
					text: row.text,
					score,
					scope: row.scope as MemoryScope,
					topicFile: row.topic_file,
					createdAt: row.created_at,
				});
			}
			hits.sort((a, b) => b.score - a.score);
			return hits.slice(0, Math.max(0, options.limit));
		},

		listActiveFacts(scope, cwdKey, mode) {
			return loadActiveRows(scope, cwdKey, mode).map(rowToFact);
		},

		close() {
			db.close();
		},
	};
}

function embeddingToBlob(embedding: Float32Array): Buffer {
	return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function blobToEmbedding(blob: Buffer | Uint8Array | null): Float32Array | null {
	if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
	const copy = Buffer.from(blob);
	return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number | null {
	if (a.length !== b.length) return null;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) return null;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function rowToFact(row: FactRow): MemoryFact {
	return {
		id: row.id,
		scope: row.scope as MemoryScope,
		cwdKey: row.cwd_key,
		mode: row.mode,
		topicFile: row.topic_file,
		text: row.text,
		status: row.status as MemoryFact["status"],
		createdAt: row.created_at,
		sourceTurn: row.source_turn,
		embedding: blobToEmbedding(row.embedding),
		embeddingModel: row.embedding_model,
	};
}
