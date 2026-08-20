import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	MemoryExtractRun,
	MemoryExtractRunStatus,
	MemoryFact,
	MemoryFactStatus,
	MemoryScope,
	MemorySearchHit,
	MemorySearchOptions,
} from "./memory-types.ts";

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

CREATE TABLE IF NOT EXISTS extract_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS extract_runs_started ON extract_runs(started_at DESC);
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

type ExtractRunRow = {
	id: string;
	started_at: string;
	trigger: string;
	status: string;
	reason: string | null;
};

export interface MemoryStore {
	insertFact(fact: MemoryFact): void;
	getFactById(id: string): MemoryFact | null;
	updateFactStatus(id: string, status: MemoryFactStatus): void;
	updateFactScope(id: string, scope: MemoryScope, cwdKey: string | null, mode: string | null): void;
	updateFactEmbedding(id: string, embedding: Float32Array | null, embeddingModel: string | null): void;
	deleteFact(id: string): void;
	countFacts(): number;
	runInTransaction(fn: () => void): void;
	searchByEmbedding(query: Float32Array, options: MemorySearchOptions): MemorySearchHit[];
	listActiveFacts(scope: MemoryScope, cwdKey: string | null, mode: string | null): MemoryFact[];
	listFactsByStatus(status: MemoryFactStatus, limit: number): MemoryFact[];
	/** Active facts with null embedding or embedding_model !== expectedModel. */
	listFactsNeedingEmbedding(expectedModel: string, limit: number): MemoryFact[];
	recordExtractRun(run: MemoryExtractRun): void;
	listExtractRuns(limit?: number): MemoryExtractRun[];
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

	const selectById = db.prepare(`
		SELECT id, scope, cwd_key, mode, topic_file, text, status, created_at, source_turn, embedding, embedding_model
		FROM facts
		WHERE id = ?
	`);

	const updateStatus = db.prepare(`UPDATE facts SET status = ? WHERE id = ?`);
	const updateScope = db.prepare(`UPDATE facts SET scope = ?, cwd_key = ?, mode = ? WHERE id = ?`);
	const updateEmbedding = db.prepare(`UPDATE facts SET embedding = ?, embedding_model = ? WHERE id = ?`);

	const selectNeedingEmbedding = db.prepare(`
		SELECT id, scope, cwd_key, mode, topic_file, text, status, created_at, source_turn, embedding, embedding_model
		FROM facts
		WHERE status = 'active'
		  AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?)
		ORDER BY created_at ASC, id ASC
		LIMIT ?
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

	const selectByStatus = db.prepare(`
		SELECT id, scope, cwd_key, mode, topic_file, text, status, created_at, source_turn, embedding, embedding_model
		FROM facts
		WHERE status = ?
		ORDER BY created_at DESC, id ASC
		LIMIT ?
	`);

	const countAll = db.prepare(`SELECT COUNT(*) AS n FROM facts`);

	const insertExtractRun = db.prepare(`
		INSERT INTO extract_runs (id, started_at, trigger, status, reason)
		VALUES (?, ?, ?, ?, ?)
	`);

	const listExtractRunsStmt = db.prepare(`
		SELECT id, started_at, trigger, status, reason
		FROM extract_runs
		ORDER BY started_at DESC
		LIMIT ?
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

		getFactById(id) {
			const row = selectById.get(id) as FactRow | undefined;
			return row ? rowToFact(row) : null;
		},

		updateFactStatus(id, status) {
			updateStatus.run(status, id);
		},

		updateFactScope(id, scope, cwdKey, mode) {
			updateScope.run(scope, cwdKey, mode, id);
		},

		updateFactEmbedding(id, embedding, embeddingModel) {
			updateEmbedding.run(embedding ? embeddingToBlob(embedding) : null, embeddingModel, id);
		},

		deleteFact(id) {
			updateStatus.run("deleted" satisfies MemoryFactStatus, id);
		},

		countFacts() {
			return Number((countAll.get() as { n: number | bigint }).n);
		},

		runInTransaction(fn) {
			db.exec("BEGIN IMMEDIATE");
			try {
				fn();
				db.exec("COMMIT");
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// Ignore rollback errors when the transaction never started.
				}
				throw error;
			}
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

		listFactsByStatus(status, limit) {
			return (selectByStatus.all(status, Math.max(0, limit)) as FactRow[]).map(rowToFact);
		},

		listFactsNeedingEmbedding(expectedModel, limit) {
			return (selectNeedingEmbedding.all(expectedModel, Math.max(0, limit)) as FactRow[]).map(rowToFact);
		},

		recordExtractRun(run) {
			insertExtractRun.run(run.id, run.startedAt, run.trigger, run.status, run.reason);
		},

		listExtractRuns(limit = 20) {
			return (listExtractRunsStmt.all(Math.max(0, limit)) as ExtractRunRow[]).map((row) => ({
				id: row.id,
				startedAt: row.started_at,
				trigger: row.trigger,
				status: row.status as MemoryExtractRunStatus,
				reason: row.reason,
			}));
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
