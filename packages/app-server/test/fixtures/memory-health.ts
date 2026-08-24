import { DatabaseSync } from "node:sqlite";
import { getLatestMemoryError, getMemorySqlitePath } from "@metis/coding-agent";

interface TestMemoryHealthRow {
	operation: "extract" | "embedding" | "rerank" | "backfill" | "projection" | "migration";
	status: "running" | "ok" | "error";
	updatedAt: string;
	reason: string | null;
}

export function recordMemoryHealth(agentDir: string, ...rows: TestMemoryHealthRow[]): void {
	getLatestMemoryError(agentDir);
	const db = new DatabaseSync(getMemorySqlitePath(agentDir));
	try {
		const insert = db.prepare(
			"INSERT INTO memory_health (operation, status, updated_at, reason) VALUES (?, ?, ?, ?)",
		);
		for (const row of rows) insert.run(row.operation, row.status, row.updatedAt, row.reason);
	} finally {
		db.close();
	}
}
