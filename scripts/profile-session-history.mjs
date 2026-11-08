// Offline production runtime benchmark. Build coding-agent and app-server first.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../packages/coding-agent/dist/host.js";
import { AgentSessionRuntimeHost, SessionRegistry } from "../packages/app-server/dist/index.js";

const count = Number(process.env.METIS_PROFILE_HISTORY_MESSAGES ?? 2500);
const sessions = Number(process.env.METIS_PROFILE_HISTORY_SESSIONS ?? 12);
if (!Number.isSafeInteger(count) || count < 20 || !Number.isSafeInteger(sessions) || sessions < 1) {
	throw new Error("History messages must be an integer >= 20 and sessions must be a positive integer");
}
const root = mkdtempSync(join(tmpdir(), "metis-session-history-"));
const cwd = join(root, "workspace");
const agentDir = join(root, "agent");
mkdirSync(cwd);
mkdirSync(agentDir);
const epoch = "11111111-1111-4111-8111-111111111111";
const refs = [];
for (let index = 0; index < sessions; index++) {
	const manager = SessionManager.inMemory(cwd, { mode: "code", permissionPreset: "full" });
	const ids = [];
	for (let message = 0; message < count; message++) {
		ids.push(manager.appendMessage({ role: "user", content: `${message}: ${"正文".repeat(680)}`, timestamp: message + 1 }));
	}
	manager.appendCompaction("Earlier work summary", ids.at(-20), count * 1024, undefined, undefined, {
		version: 1,
		messages: [],
	});
	const header = manager.getHeader();
	const path = join(agentDir, `${header.id}.jsonl`);
	writeFileSync(path, `${manager.getDurableJournalSnapshot().map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	refs.push({ path, relativePath: basename(path), summary: {
		sessionId: header.id, cwd, cwdOrigin: "user-selected", mode: "code", createdAt: header.timestamp,
		updatedAt: header.timestamp, state: "idle", archived: false, unread: false, useMemory: true, contributeMemory: true,
	} });
	manager.close();
}
const registry = new SessionRegistry(new AgentSessionRuntimeHost({ agentDir }), {
	maxIdleRuntimes: 8,
	idleRuntimeGraceMs: 10,
});
function memory() {
	globalThis.gc?.();
	return process.memoryUsage();
}
const measure = async (operation) => {
	const started = performance.now();
	await operation();
	return performance.now() - started;
};
try {
	const before = memory();
	const coldOpenMs = await measure(() => registry.open(refs[0]));
	let firstPage;
	const firstPageMs = await measure(async () => {
		firstPage = await registry.run(refs[0], (runtime) => runtime.snapshot(epoch, () => 1));
	});
	const cachedPageMs = await measure(() => registry.run(refs[0], (runtime) => runtime.readItems({ sessionId: refs[0].summary.sessionId, limit: 200 })));
	const olderPageMs = await measure(() => registry.run(refs[0], (runtime) => runtime.readItems({ sessionId: refs[0].summary.sessionId, beforeItemId: firstPage.nextBeforeItemId, limit: 200 })));
	const warmOpenMs = await measure(() => registry.run(refs[0], (runtime) => runtime.snapshot(epoch, () => 1)));
	const afterOne = memory();
	for (const ref of refs.slice(1)) await registry.run(ref, (runtime) => runtime.snapshot(epoch, () => 1));
	// Wait only for the explicitly shortened profiling grace period.
	await new Promise((resolve) => setTimeout(resolve, 100));
	const afterMany = memory();
	const retainedRuntimes = refs.filter((ref) => registry.has(ref.summary.sessionId)).length;
	const reopenMs = await measure(() => registry.run(refs[0], (runtime) => runtime.snapshot(epoch, () => 1)));
	process.stdout.write(`${JSON.stringify({ count, sessions, coldOpenMs, firstPageMs, cachedPageMs, olderPageMs, warmOpenMs, reopenMs, retainedRuntimes, before, afterOne, afterMany, gc: Boolean(globalThis.gc) }, null, 2)}\n`);
} finally {
	await registry.shutdown();
	rmSync(root, { recursive: true, force: true });
}
