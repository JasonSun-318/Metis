import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { getPinnedPath, getScopeDir } from "../src/core/memory/vault-paths.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { buildMemoryPromptSnapshot, formatMemorySnapshot } from "../src/core/memory/vault-snapshot.ts";
import { MEMORY_LIMITS, type MemoryActor } from "../src/core/memory/vault-types.ts";
import { withMemoryFixture } from "./helpers/memory-vault-fixture.ts";

const AGENT: MemoryActor = { kind: "agent", sessionId: "sess-1" };

describe("memory prompt snapshot", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-vault-snap-"));
		tempDirs.push(dir);
		return dir;
	};
	const makeVault = (opts?: { project?: boolean }) => {
		const root = makeTemp();
		const vault = new MemoryVault({
			agentDir: join(root, "agent"),
			project: opts?.project ? resolveVaultProject(join(root, "work"), "user-selected") : undefined,
		});
		vault.ensureLayout();
		return vault;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("omits the project section when there is no project identity", async () => {
		const vault = makeVault();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "n1" },
				frontmatter: { type: "reference", description: "first note" },
				content: "body",
			},
			AGENT,
		);
		const snapshot = buildMemoryPromptSnapshot(vault);
		expect(snapshot.project).toBeUndefined();
		expect(snapshot.truncated).toBe(false);
		const text = formatMemorySnapshot(snapshot);
		expect(text).toContain("<auto_memory>");
		expect(text).toContain("</auto_memory>");
		expect(text).toContain("Global memory");
		expect(text).not.toContain("Project memory");
		expect(text).toContain("memory_search");
		expect(text).toContain("memory_write");
	});

	it("includes the project section with the project root", () => {
		const vault = makeVault({ project: true });
		const snapshot = buildMemoryPromptSnapshot(vault);
		expect(snapshot.project).toBeDefined();
		expect(snapshot.project!.root).toBeTruthy();
		const text = formatMemorySnapshot(snapshot);
		expect(text).toContain("Project memory");
		expect(text).toContain("Project root:");
	});

	it("marks truncation when pinned blocks exceed the total budget", () => {
		const vault = makeVault();
		const pinnedPath = getPinnedPath(getScopeDir(vault.root, "global"), "user");
		writeFileSync(pinnedPath, "x".repeat(MEMORY_LIMITS.pinnedTotalBytes + 100), { mode: 0o600 });
		const snapshot = buildMemoryPromptSnapshot(vault);
		expect(snapshot.truncated).toBe(true);
		expect(formatMemorySnapshot(snapshot)).toContain("Memory truncated");
	});

	it("escapes markup inside memory content", async () => {
		const vault = makeVault();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "esc" },
				frontmatter: { type: "reference", description: "has <tags> & amp" },
				content: "body with <xml> & entities",
			},
			AGENT,
		);
		const text = formatMemorySnapshot(buildMemoryPromptSnapshot(vault));
		expect(text).toContain("&lt;tags&gt;");
		expect(text).not.toContain("has <tags>");
	});

	it("emits the activeContext maintenance protocol only for project scope", async () => {
		await withMemoryFixture(async (f) => {
			const projectVault = f.vault("a");
			const off = buildMemoryPromptSnapshot(projectVault, { activeContextEnabled: false });
			expect(off.protocol).not.toContain('"block":"active"');
			expect(off.project?.pinned ?? "").not.toContain("active");
			const on = buildMemoryPromptSnapshot(projectVault, { activeContextEnabled: true });
			expect(on.protocol).toContain('"block":"active"');
			expect(on.protocol).toContain("memory_write");
			expect(on.project?.pinned ?? "").not.toContain("active");
			const globalVault = new MemoryVault({ agentDir: join(f.root, "global-agent") });
			globalVault.ensureLayout();
			const globalOn = buildMemoryPromptSnapshot(globalVault, { activeContextEnabled: true });
			expect(globalOn.protocol).not.toContain('"block":"active"');
			expect(globalOn.project).toBeUndefined();
			expect(
				existsSync(join(projectVault.root, "projects", projectVault.project!.projectKey, "_pinned", "active.md")),
			).toBe(false);
		});
	});
});
