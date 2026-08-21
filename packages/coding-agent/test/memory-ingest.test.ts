import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalMemoryDirectory, getMemorySqlitePath, getProjectMemoryDirectory } from "../src/core/auto-memory.ts";
import { ingestExactProjectProjectionOnce, ingestGlobalMarkdownOnce } from "../src/core/memory/memory-ingest.ts";
import { memoryProjectIdentity } from "../src/core/memory/memory-project.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";

describe("bounded Markdown recovery", () => {
	const dirs: string[] = [];
	const makeAgentDir = (): string => {
		const agentDir = mkdtempSync(join(tmpdir(), "metis-ingest-"));
		dirs.push(agentDir);
		mkdirSync(join(agentDir, "memory"), { recursive: true });
		return agentDir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("prefers the new global projection and never scans project directories", async () => {
		const agentDir = makeAgentDir();
		const memoryRoot = join(agentDir, "memory");
		const globalDir = getGlobalMemoryDirectory(agentDir);
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(memoryRoot, "MEMORY.md"), "- [legacy.md](legacy.md) — legacy\n");
		writeFileSync(join(memoryRoot, "legacy.md"), "legacy global\n");
		writeFileSync(join(globalDir, "MEMORY.md"), "- [current.md](current.md) — current\n");
		writeFileSync(join(globalDir, "current.md"), "current global\n");
		const lossy = join(memoryRoot, "projects", "--legacy--", "code");
		mkdirSync(lossy, { recursive: true });
		writeFileSync(join(lossy, "project.md"), "- [leak.md](leak.md) — leak\n");
		writeFileSync(join(lossy, "leak.md"), "sibling leak marker\n");

		await ingestGlobalMarkdownOnce(agentDir);
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		const facts = store.listActiveFacts("global", null, null);
		expect(facts.map((fact) => fact.text)).toContain("current global");
		expect(facts.map((fact) => fact.text)).not.toContain("legacy global");
		expect(store.countFacts()).toBe(facts.length);
		expect(store.isMarkdownRecoveryHandled("global")).toBe(true);
		store.close();
	});

	it("recovers only the resolved exact-hash project once", async () => {
		const agentDir = makeAgentDir();
		const first = memoryProjectIdentity(join(agentDir, "first"));
		const sibling = memoryProjectIdentity(join(agentDir, "sibling"));
		for (const [identity, marker] of [
			[first, "first marker"],
			[sibling, "sibling marker"],
		] as const) {
			const directory = getProjectMemoryDirectory(agentDir, identity.projectKey);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "project.md"), "- [context.md](context.md) — context\n");
			writeFileSync(join(directory, "context.md"), `${marker}\n`);
		}
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		store.resolveProject(first);
		store.close();

		await ingestExactProjectProjectionOnce(agentDir, first.projectKey);
		await ingestExactProjectProjectionOnce(agentDir, first.projectKey);
		const reopened = openMemoryStore(getMemorySqlitePath(agentDir));
		const facts = reopened.listActiveFacts("project", first.projectKey, null);
		expect(facts.map((fact) => fact.text)).toEqual(["first marker"]);
		expect(reopened.listActiveFacts("project", sibling.projectKey, null)).toEqual([]);
		expect(reopened.isMarkdownRecoveryHandled(`project:${first.projectKey}`)).toBe(true);
		reopened.close();
	});

	it.skipIf(process.platform === "win32")("rejects symlinked and hard-linked recovery files", async () => {
		for (const kind of ["symlink", "hardlink"] as const) {
			const agentDir = makeAgentDir();
			const globalDir = getGlobalMemoryDirectory(agentDir);
			mkdirSync(globalDir, { recursive: true });
			const outside = join(agentDir, `${kind}.md`);
			writeFileSync(outside, "aliased secret marker\n");
			writeFileSync(join(globalDir, "MEMORY.md"), "- [topic.md](topic.md) — topic\n");
			if (kind === "symlink") symlinkSync(outside, join(globalDir, "topic.md"));
			else linkSync(outside, join(globalDir, "topic.md"));
			await ingestGlobalMarkdownOnce(agentDir);
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			expect(store.listActiveFacts("global", null, null)).toEqual([]);
			expect(store.listHealth().find((row) => row.operation === "migration")).toMatchObject({ status: "error" });
			store.close();
		}
	});

	it("bounds an oversized topic, marks recovery handled, and leaves source retry-free", async () => {
		const agentDir = makeAgentDir();
		const globalDir = getGlobalMemoryDirectory(agentDir);
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "MEMORY.md"), "- [large.md](large.md) — large\n");
		writeFileSync(join(globalDir, "large.md"), `${"x".repeat(1024 * 1024 + 100)}\n`);
		await ingestGlobalMarkdownOnce(agentDir);
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		const facts = store.listActiveFacts("global", null, null);
		expect(facts.length).toBeGreaterThan(0);
		expect(facts.every((fact) => Array.from(fact.text).length <= 4_000)).toBe(true);
		expect(store.isMarkdownRecoveryHandled("global")).toBe(true);
		expect(store.listHealth().find((row) => row.operation === "migration")).toMatchObject({ status: "error" });
		const count = store.countFacts();
		store.close();
		await ingestGlobalMarkdownOnce(agentDir);
		const reopened = openMemoryStore(getMemorySqlitePath(agentDir));
		expect(reopened.countFacts()).toBe(count);
		reopened.close();
	});
});
