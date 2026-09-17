import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { pruneSnapshots, readChangelog, saveSnapshot } from "../src/core/memory/vault-history.ts";
import { getSnapshotDir } from "../src/core/memory/vault-paths.ts";
import type { VaultProjectIdentity } from "../src/core/memory/vault-project.ts";
import { MEMORY_LIMITS, type MemoryActor } from "../src/core/memory/vault-types.ts";

const AGENT: MemoryActor = { kind: "agent", sessionId: "sess-1" };
const DREAM = (runId: string): MemoryActor => ({ kind: "dream", runId });

describe("memory history and undo", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-vault-hist-"));
		tempDirs.push(dir);
		return dir;
	};
	const makeVault = () => {
		const vault = new MemoryVault({ agentDir: join(makeTemp(), "agent") });
		vault.ensureLayout();
		return vault;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createNote(vault: MemoryVault, slug: string, actor: MemoryActor = AGENT) {
		return vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug },
				frontmatter: { type: "reference", description: slug },
				content: `body of ${slug}`,
			},
			actor,
		);
	}

	it("snapshots before mutation and undo restores the previous content", async () => {
		const vault = makeVault();
		await createNote(vault, "note");
		const append = await vault.write(
			{ op: "append", scope: "global", target: { slug: "note" }, content: "extra" },
			AGENT,
		);
		expect(append.ok).toBe(true);
		expect(vault.readNote("global", "note")!.body).toContain("extra");

		const undone = await vault.undo(append.ok ? append.changeId : "", AGENT);
		expect(undone.ok).toBe(true);
		expect(vault.readNote("global", "note")!.body).toBe("body of note");

		const log = readChangelog(vault.root);
		const undoEntry = log.find((entry) => entry.op === "undo");
		expect(undoEntry?.undoes).toBe(append.ok ? append.changeId : "");
		const original = log.find((entry) => entry.id === (append.ok ? append.changeId : ""));
		expect(original?.undoneBy).toBe(undoEntry?.id);
	});

	it("undo of create deletes the note; undo of delete restores it", async () => {
		const vault = makeVault();
		const created = await createNote(vault, "temp-note");
		expect(created.ok).toBe(true);
		const undoCreate = await vault.undo(created.ok ? created.changeId : "", AGENT);
		expect(undoCreate.ok).toBe(true);
		expect(vault.readNote("global", "temp-note")).toBeUndefined();

		const recreated = await createNote(vault, "temp-note");
		expect(recreated.ok).toBe(true);
		const removed = await vault.write({ op: "delete", scope: "global", target: { slug: "temp-note" } }, AGENT);
		expect(removed.ok).toBe(true);
		const undoDelete = await vault.undo(removed.ok ? removed.changeId : "", AGENT);
		expect(undoDelete.ok).toBe(true);
		expect(vault.readNote("global", "temp-note")!.body).toBe("body of temp-note");
	});

	it("only allows undoing the latest change for a target", async () => {
		const vault = makeVault();
		const created = await createNote(vault, "seq");
		const appended = await vault.write(
			{ op: "append", scope: "global", target: { slug: "seq" }, content: "more" },
			AGENT,
		);
		const early = await vault.undo(created.ok ? created.changeId : "", AGENT);
		expect(early.ok).toBe(false);
		expect(early.error).toContain(appended.ok ? appended.changeId : "");
		const late = await vault.undo(appended.ok ? appended.changeId : "", AGENT);
		expect(late.ok).toBe(true);
		const again = await vault.undo(created.ok ? created.changeId : "", AGENT);
		expect(again.ok).toBe(true);
		expect(vault.readNote("global", "seq")).toBeUndefined();
	});

	it("undoing a rename restores the old slug and removes the new one", async () => {
		const vault = makeVault();
		await createNote(vault, "before");
		const renamed = await vault.write(
			{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
			AGENT,
		);
		expect(renamed.ok).toBe(true);
		const undone = await vault.undo(renamed.ok ? renamed.changeId : "", AGENT);
		expect(undone.ok).toBe(true);
		expect(vault.readNote("global", "before")!.body).toBe("body of before");
		expect(vault.readNote("global", "after")).toBeUndefined();
	});

	it("undoRun reverses a run and skips targets changed afterwards", async () => {
		const vault = makeVault();
		const run = DREAM("run-1");
		await createNote(vault, "clean", run);
		await createNote(vault, "dirty", run);
		await createNote(vault, "bystander", AGENT);

		// A non-run change lands on "dirty" after the dream run.
		await vault.write({ op: "append", scope: "global", target: { slug: "dirty" }, content: "human edit" }, AGENT);

		const result = await vault.undoRun("run-1", AGENT);
		expect(result.undone).toHaveLength(1);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.reason).toContain("newer change");
		expect(vault.readNote("global", "clean")).toBeUndefined();
		expect(vault.readNote("global", "dirty")!.body).toContain("human edit");
		expect(vault.readNote("global", "bystander")).toBeDefined();
	});

	it("prunes snapshots per target and by age", () => {
		const vault = makeVault();
		const target = { slug: "snap-target" };
		for (let index = 0; index < MEMORY_LIMITS.snapshotsPerTarget + 3; index++) {
			saveSnapshot(vault.root, "global", target, `snapshot ${index}`);
		}
		const dir = getSnapshotDir(vault.root, "global", target);
		expect(readdirSync(dir)).toHaveLength(MEMORY_LIMITS.snapshotsPerTarget + 3);

		pruneSnapshots(vault.root, {
			snapshotsPerTarget: MEMORY_LIMITS.snapshotsPerTarget,
			snapshotMaxAgeDays: 90,
		});
		expect(readdirSync(dir)).toHaveLength(MEMORY_LIMITS.snapshotsPerTarget);

		const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
		for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old);
		pruneSnapshots(vault.root, {
			snapshotsPerTarget: MEMORY_LIMITS.snapshotsPerTarget,
			snapshotMaxAgeDays: 90,
		});
		expect(existsSync(dir)).toBe(false);
	});

	describe("cross-project undo", () => {
		const identity = (root: string, projectKey: string): VaultProjectIdentity => ({
			root,
			projectKey,
			source: "cwd",
		});
		const makeProjectVaults = () => {
			const agentDir = join(makeTemp(), "agent");
			const vaultA = new MemoryVault({ agentDir, project: identity("/project-a", "key-a") });
			const vaultB = new MemoryVault({ agentDir, project: identity("/project-b", "key-b") });
			vaultA.ensureLayout();
			vaultB.ensureLayout();
			return { vaultA, vaultB };
		};
		const createProjectNote = (vault: MemoryVault, slug: string, content: string, actor: MemoryActor = AGENT) =>
			vault.write(
				{
					op: "create",
					scope: "project",
					target: { slug },
					frontmatter: { type: "project", description: slug },
					content,
				},
				actor,
			);

		it("rejects undoing a project-scope change from a different project", async () => {
			const { vaultA, vaultB } = makeProjectVaults();
			await createProjectNote(vaultA, "shared", "from A");
			const appended = await vaultA.write(
				{ op: "append", scope: "project", target: { slug: "shared" }, content: "more" },
				AGENT,
			);
			expect(appended.ok).toBe(true);

			const rejected = await vaultB.undo(appended.ok ? appended.changeId : "", AGENT);
			expect(rejected.ok).toBe(false);
			expect(rejected.error).toContain("different project");
			expect(vaultA.readNote("project", "shared")!.body).toContain("more");

			// The owning project can still undo it.
			const allowed = await vaultA.undo(appended.ok ? appended.changeId : "", AGENT);
			expect(allowed.ok).toBe(true);
			expect(vaultA.readNote("project", "shared")!.body).toBe("from A");
		});

		it("undoRun skips project-scope changes from a different project", async () => {
			const { vaultA, vaultB } = makeProjectVaults();
			const run = DREAM("run-9");
			await createProjectNote(vaultA, "dream-note", "from A", run);

			const result = await vaultB.undoRun("run-9", AGENT);
			expect(result.undone).toHaveLength(0);
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0]!.reason).toContain("different project");
			expect(vaultA.readNote("project", "dream-note")).toBeDefined();

			const own = await vaultA.undoRun("run-9", AGENT);
			expect(own.undone).toHaveLength(1);
			expect(vaultA.readNote("project", "dream-note")).toBeUndefined();
		});

		it("a same-slug change in another project does not block undo", async () => {
			const { vaultA, vaultB } = makeProjectVaults();
			await createProjectNote(vaultA, "shared", "from A");
			const appended = await vaultA.write(
				{ op: "append", scope: "project", target: { slug: "shared" }, content: "more" },
				AGENT,
			);
			expect(appended.ok).toBe(true);
			// Project B writes a same-slug note afterwards; it lives in a different file.
			await createProjectNote(vaultB, "shared", "from B");

			const undone = await vaultA.undo(appended.ok ? appended.changeId : "", AGENT);
			expect(undone.ok).toBe(true);
			expect(vaultA.readNote("project", "shared")!.body).toBe("from A");
			expect(vaultB.readNote("project", "shared")!.body).toBe("from B");
		});
	});

	it("undo restores a pinned block snapshot", async () => {
		const vault = makeVault();
		await vault.write({ op: "replace", scope: "global", target: { block: "user" }, content: "v1" }, AGENT);
		const second = await vault.write(
			{ op: "replace", scope: "global", target: { block: "user" }, content: "v2" },
			AGENT,
		);
		expect(second.ok).toBe(true);
		const undone = await vault.undo(second.ok ? second.changeId : "", AGENT);
		expect(undone.ok).toBe(true);
		expect(vault.readPinned("global", "user")).toBe("v1\n");
	});
});
