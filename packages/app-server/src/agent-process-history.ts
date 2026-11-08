import { AgentStore, type FileEntry, SessionManager } from "@metis/coding-agent/host";
import { opaqueId } from "./item-projection.ts";
import { ProcessHistory } from "./process-history.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";

interface CachedHistory {
	readonly fingerprint: string;
	readonly history: ProcessHistory;
	readonly view: readonly FileEntry[];
	readonly bytes: number;
	readonly close: () => void;
}

/** Runtime-owned LRU. Only command identities and disk offsets survive a cold read. */
export class AgentProcessHistory {
	private readonly entries = new Map<string, CachedHistory>();
	private bytes = 0;
	private readonly agentDir: string;
	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	async read(ref: SessionRef, agentId: string, toolCallId: string) {
		const key = `${ref.summary.sessionId}:${agentId}`;
		const previous = this.entries.get(key);
		const header = SessionManager.readHeaderReadOnly(ref.path);
		if (!header || header.id !== ref.summary.sessionId || header.agent || header.scheduled)
			throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
		const store = new AgentStore({ getSessionId: () => header.id, getSessionFile: () => ref.path }, this.agentDir);
		const file = store.findJournal(agentId);
		if (!file) {
			this.remove(key);
			throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
		}
		const { stat, path } = file;
		const fingerprint = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		let cached = previous;
		if (cached?.fingerprint !== fingerprint) {
			this.remove(key);
			const source = SessionManager.openJournalReadOnly(path);
			try {
				const history = new ProcessHistory();
				history.index(source.records, ref.summary.sessionId);
				cached = {
					fingerprint,
					history,
					view: source.view,
					bytes: source.retainedBytes + history.retainedBytes,
					close: source.close,
				};
			} catch (error) {
				source.close();
				throw error;
			}
		} else {
			this.entries.delete(key);
			this.bytes -= cached.bytes;
		}
		const retain = cached.bytes <= 8 * 1024 * 1024;
		if (retain) {
			while (this.entries.size >= 8 || this.bytes + cached.bytes > 8 * 1024 * 1024) {
				this.remove(this.entries.keys().next().value!);
			}
			this.entries.set(key, cached);
			this.bytes += cached.bytes;
		}
		try {
			const result = await cached.history.read(cached.view, {
				sessionId: ref.summary.sessionId,
				processId: opaqueId(`root:${toolCallId}`, "process"),
			});
			return result.process;
		} finally {
			if (!retain) cached.close();
		}
	}

	private remove(key: string): void {
		const cached = this.entries.get(key);
		if (!cached) return;
		this.entries.delete(key);
		this.bytes -= cached.bytes;
		cached.close();
	}

	close(): void {
		for (const key of this.entries.keys()) this.remove(key);
	}
}
