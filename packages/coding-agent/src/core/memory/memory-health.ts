import { getMemorySqlitePath } from "../auto-memory.ts";
import { openMemoryStore } from "./memory-store.ts";
import type { MemoryHealthOperation } from "./memory-types.ts";

export function getLatestMemoryError(agentDir: string): string | null {
	const store = openMemoryStore(getMemorySqlitePath(agentDir));
	try {
		return store.listHealth().find((health) => health.status === "error")?.reason ?? null;
	} finally {
		store.close();
	}
}

export function clearMemoryHealth(agentDir: string, ...operations: MemoryHealthOperation[]): void {
	const store = openMemoryStore(getMemorySqlitePath(agentDir));
	try {
		store.clearHealth(...operations);
	} finally {
		store.close();
	}
}
