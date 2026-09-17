import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { applyVaultFileChanges } from "../src/core/memory/vault-file-changes.ts";
import { appendChangelog, pruneSnapshots, readChangelog, saveSnapshot } from "../src/core/memory/vault-history.ts";
import { undoMemoryRun } from "../src/core/memory/vault-run-undo.ts";
import { type MemoryFixture, mustWrite, putNote, withMemoryFixture } from "./helpers/memory-vault-fixture.ts";

const durableMock = vi.hoisted(() => ({ failOnce: new Set<string>() }));
vi.mock("../src/core/durable-file.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/core/durable-file.ts")>();
	return {
		...mod,
		replaceFileAtomicallySync: (path: string, data: string | Uint8Array, options?: { mode?: number }) => {
			if (durableMock.failOnce.delete(path)) throw new Error("injected write failure");
			return mod.replaceFileAtomicallySync(path, data, options);
		},
	};
});

import { getScopeDir, getSnapshotDir } from "../src/core/memory/vault-paths.ts";
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
			const snapshot = saveSnapshot(vault.root, "global", target, `snapshot ${index}`);
			appendChangelog(vault.root, {
				id: `snap-${index}`,
				ts: new Date().toISOString(),
				actor: AGENT,
				op: "replace",
				scope: "global",
				target,
				snapshot,
			});
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

	it("only age-prunes snapshots that no changelog entry references", () => {
		const vault = makeVault();
		const orphan = saveSnapshot(vault.root, "global", { slug: "orphan" }, "orphan content")!;
		pruneSnapshots(vault.root, {
			snapshotsPerTarget: MEMORY_LIMITS.snapshotsPerTarget,
			snapshotMaxAgeDays: 90,
		});
		expect(existsSync(join(vault.root, orphan))).toBe(true);
		const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
		utimesSync(join(vault.root, orphan), old, old);
		pruneSnapshots(vault.root, {
			snapshotsPerTarget: MEMORY_LIMITS.snapshotsPerTarget,
			snapshotMaxAgeDays: 90,
		});
		expect(existsSync(join(vault.root, orphan))).toBe(false);
	});

	it("another project cannot consume this target's snapshot retention", async () => {
		await withMemoryFixture(async (f) => {
			const a = f.vault("a");
			const b = f.vault("b");
			await putNote(a, "project", "shared", "a");
			await putNote(b, "project", "shared", "b");
			const edit = mustWrite(
				await a.write(
					{ op: "append", scope: "project", target: { slug: "shared" }, content: "edit a" },
					{ kind: "user" },
				),
			);
			const snapshot = readChangelog(a.root).find((e) => e.id === edit.changeId)!.snapshot!;
			await new Promise((resolve) => setTimeout(resolve, 10));
			for (let i = 0; i < 21; i++) {
				mustWrite(
					await b.write(
						{ op: "append", scope: "project", target: { slug: "shared" }, content: `b ${i}` },
						{ kind: "user" },
					),
				);
			}
			pruneSnapshots(a.root, { snapshotsPerTarget: 20, snapshotMaxAgeDays: 90 });
			expect(existsSync(join(a.root, snapshot))).toBe(true);
			expect((await a.undo(edit.changeId, { kind: "user" })).ok).toBe(true);
		});
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

	it.each(["append", "replace"] as const)("undo removes a first pinned %s", async (op) => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			const changed = mustWrite(
				await v.write({ op, scope: "global", target: { block: "user" }, content: "pref" }, { kind: "user" }),
			);
			expect(await v.undo(changed.changeId, { kind: "user" })).toEqual({ ok: true });
			expect(existsSync(join(v.root, "global", "_pinned", "user.md"))).toBe(false);
		});
	});
	it("missing rename snapshot never deletes the only live copy", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "old", "unique body");
			const renamed = mustWrite(
				await v.write({ op: "rename", scope: "global", target: { slug: "old" }, newSlug: "new" }, { kind: "user" }),
			);
			const entry = readChangelog(v.root).find((e) => e.id === renamed.changeId)!;
			rmSync(join(v.root, entry.snapshot!));
			const before = readFileSync(v.readNote("global", "new")!.path, "utf8");
			expect((await v.undo(renamed.changeId, { kind: "user" })).ok).toBe(false);
			expect(readFileSync(v.readNote("global", "new")!.path, "utf8")).toBe(before);
			expect(v.readNote("global", "old")).toBeUndefined();
			expect(readChangelog(v.root).some((e) => e.op === "undo")).toBe(false);
		});
	});
	it("undoRun removes a first pinned write", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			mustWrite(
				await v.write(
					{ op: "replace", scope: "global", target: { block: "feedback" }, content: "first" },
					{ kind: "dream", runId: "run-first" },
				),
			);
			const result = await v.undoRun("run-first", { kind: "user" });
			expect(result.skipped).toEqual([]);
			expect(existsSync(join(v.root, "global", "_pinned", "feedback.md"))).toBe(false);
		});
	});

	it("undo restores a rename's rewritten backlinks in the same operation", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "before", "original");
			await putNote(v, "global", "ref", "see [[before]]");
			const renamed = mustWrite(
				await v.write(
					{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
					{ kind: "user" },
				),
			);
			expect(v.readNote("global", "ref")!.body).toContain("[[after]]");
			expect((await v.undo(renamed.changeId, { kind: "user" })).ok).toBe(true);
			expect(v.readNote("global", "before")!.body).toBe("original");
			expect(v.readNote("global", "after")).toBeUndefined();
			expect(v.readNote("global", "ref")!.body).toBe("see [[before]]");
		});
	});

	it.each([
		{ name: "rewrites a fallback link in another project", localOld: false, localNew: false, expected: "[[after]]" },
		{
			name: "keeps links shadowed by a local note in another project",
			localOld: true,
			localNew: false,
			expected: "[[before]]",
		},
	])("global rename $name", async ({ localOld, localNew, expected }) => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			const b = f.vault("b");
			await putNote(v, "global", "before", "global note");
			if (localOld) await putNote(b, "project", "before", "local shadow");
			if (localNew) await putNote(b, "project", "after", "local note");
			await putNote(b, "project", "ref", "see [[before]]");
			const renamed = await v.write(
				{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
				{ kind: "user" },
			);
			expect(renamed.ok).toBe(true);
			expect(b.readNote("project", "ref")!.body).toBe(`see ${expected}`);
		});
	});

	it("refuses a global rename whose rewritten links would resolve to a local note", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			const b = f.vault("b");
			await putNote(v, "global", "before", "global note");
			await putNote(b, "project", "after", "local note");
			await putNote(b, "project", "ref", "see [[before]]");
			const renamed = await v.write(
				{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
				{ kind: "user" },
			);
			expect(renamed.ok).toBe(false);
			expect(b.readNote("project", "ref")!.body).toBe("see [[before]]");
			expect(v.readNote("global", "before")!.body).toBe("global note");
			expect(v.readNote("global", "after")).toBeUndefined();
		});
	});

	it("undo refuses a rename group after an external edit to a rewritten note", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "before", "original");
			await putNote(v, "global", "ref", "see [[before]]");
			const renamed = mustWrite(
				await v.write(
					{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
					{ kind: "user" },
				),
			);
			mustWrite(
				await v.write(
					{ op: "append", scope: "global", target: { slug: "ref" }, content: "human edit" },
					{ kind: "user" },
				),
			);
			const result = await v.undo(renamed.changeId, { kind: "user" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("newer change");
			expect(v.readNote("global", "ref")!.body).toContain("[[after]]");
			expect(v.readNote("global", "ref")!.body).toContain("human edit");
			expect(v.readNote("global", "after")).toBeDefined();
			expect(readChangelog(v.root).some((e) => e.op === "undo")).toBe(false);
		});
	});

	it("undo leaves all files when a rewritten note's snapshot is missing", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "before", "original");
			await putNote(v, "global", "ref", "see [[before]]");
			const renamed = mustWrite(
				await v.write(
					{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
					{ kind: "user" },
				),
			);
			const refEntry = readChangelog(v.root).find(
				(e) => e.op === "replace" && "slug" in e.target && e.target.slug === "ref",
			)!;
			rmSync(join(v.root, refEntry.snapshot!));
			const refRaw = readFileSync(v.readNote("global", "ref")!.path, "utf8");
			expect((await v.undo(renamed.changeId, { kind: "user" })).ok).toBe(false);
			expect(readFileSync(v.readNote("global", "ref")!.path, "utf8")).toBe(refRaw);
			expect(v.readNote("global", "before")).toBeUndefined();
			expect(v.readNote("global", "after")).toBeDefined();
			expect(readChangelog(v.root).some((e) => e.op === "undo")).toBe(false);
		});
	});

	it("undoRun skips a rename group when a referrer has an outside change", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			const run = DREAM("run-rename");
			await putNote(v, "global", "before", "original", run);
			await putNote(v, "global", "ref", "see [[before]]", run);
			mustWrite(await v.write({ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" }, run));
			mustWrite(
				await v.write(
					{ op: "append", scope: "global", target: { slug: "ref" }, content: "human edit" },
					{ kind: "user" },
				),
			);
			const result = await v.undoRun("run-rename", { kind: "user" });
			// The rename group stays applied (a referrer was edited outside the run),
			// and its still-applied entries block the run's earlier creates.
			expect(result.undone).toHaveLength(0);
			expect(result.skipped).toHaveLength(5);
			expect(v.readNote("global", "ref")!.body).toContain("[[after]]");
			expect(v.readNote("global", "ref")!.body).toContain("human edit");
			expect(v.readNote("global", "after")).toBeDefined();
			expect(v.readNote("global", "before")).toBeUndefined();
		});
	});

	it("whole-run undo preserves a later human edit in one project", async () => {
		await withMemoryFixture(async (f) => {
			const a = f.vault("a");
			const b = f.vault("b");
			const actor = { kind: "dream", runId: "run-conflict" } as const;
			await putNote(a, "project", "shared", "a", actor);
			await putNote(b, "project", "shared", "b", actor);
			mustWrite(
				await a.write(
					{ op: "append", scope: "project", target: { slug: "shared" }, content: "human edit" },
					{ kind: "user" },
				),
			);
			const result = await undoMemoryRun({ agentDir: f.agentDir, runId: actor.runId, actor: { kind: "user" } });
			expect(result.skipped).toHaveLength(1);
			expect(result.undone).toHaveLength(1);
			expect(a.readNote("project", "shared")!.body).toContain("human edit");
			expect(b.readNote("project", "shared")).toBeUndefined();
			// A second pass rolls nothing back again.
			const again = await undoMemoryRun({ agentDir: f.agentDir, runId: actor.runId, actor: { kind: "user" } });
			expect(again.undone).toEqual([]);
		});
	});

	describe("cross-project rename groups", () => {
		const setup = async (f: MemoryFixture, actor: MemoryActor) => {
			const globalVault = f.vault();
			const vaultA = f.vault("a");
			const vaultB = f.vault("b");
			await putNote(globalVault, "global", "before", "target");
			await putNote(vaultA, "project", "ref-a", "See [[before]]");
			await putNote(vaultB, "project", "ref-b", "See [[before]]");
			const renamed = mustWrite(
				await globalVault.write(
					{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
					actor,
				),
			);
			expect(vaultA.readNote("project", "ref-a")!.body).toContain("[[after]]");
			expect(vaultB.readNote("project", "ref-b")!.body).toContain("[[after]]");
			return { globalVault, vaultA, vaultB, renamed };
		};

		it("the host-level vault undoes a global rename spanning several projects", async () => {
			await withMemoryFixture(async (f) => {
				const { globalVault, vaultA, vaultB, renamed } = await setup(f, { kind: "user" });
				expect((await globalVault.undo(renamed.changeId, { kind: "user" })).ok).toBe(true);
				expect(globalVault.readNote("global", "before")).toBeDefined();
				expect(globalVault.readNote("global", "after")).toBeUndefined();
				expect(vaultA.readNote("project", "ref-a")!.body).toContain("[[before]]");
				expect(vaultB.readNote("project", "ref-b")!.body).toContain("[[before]]");
			});
		});

		it("undoMemoryRun reverts a rename group spanning several projects", async () => {
			await withMemoryFixture(async (f) => {
				const { globalVault, vaultA, vaultB } = await setup(f, DREAM("run-links"));
				const result = await undoMemoryRun({ agentDir: f.agentDir, runId: "run-links", actor: { kind: "user" } });
				expect(result.skipped).toEqual([]);
				expect(result.undone).not.toHaveLength(0);
				expect(globalVault.readNote("global", "before")).toBeDefined();
				expect(globalVault.readNote("global", "after")).toBeUndefined();
				expect(vaultA.readNote("project", "ref-a")!.body).toContain("[[before]]");
				expect(vaultB.readNote("project", "ref-b")!.body).toContain("[[before]]");
			});
		});

		it("a project-bound vault still refuses a group that touches another project", async () => {
			await withMemoryFixture(async (f) => {
				const { globalVault, vaultA, vaultB, renamed } = await setup(f, { kind: "user" });
				const refused = await vaultA.undo(renamed.changeId, { kind: "user" });
				expect(refused.ok).toBe(false);
				expect(refused.error).toContain("different project");
				expect(vaultA.readNote("project", "ref-a")!.body).toContain("[[after]]");
				expect(vaultB.readNote("project", "ref-b")!.body).toContain("[[after]]");
				expect(globalVault.readNote("global", "after")).toBeDefined();
			});
		});

		it("refuses a foreign group member whose snapshot was never a referrer", async () => {
			await withMemoryFixture(async (f) => {
				const globalVault = f.vault();
				const vaultA = f.vault("a");
				await putNote(globalVault, "global", "before", "target");
				await putNote(vaultA, "project", "keep", "unrelated");
				const renamed = mustWrite(
					await globalVault.write(
						{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
						{ kind: "user" },
					),
				);
				const operationId = readChangelog(globalVault.root).find(
					(entry) => entry.id === renamed.changeId,
				)!.operationId;
				// Well-formed replace leg into a stored project — but its snapshot does
				// not contain [[before]], so it was never rewritten by this rename.
				const projectKey = f.project("a").projectKey;
				const snapshot = saveSnapshot(globalVault.root, "project", { slug: "keep" }, "unrelated", projectKey);
				appendChangelog(globalVault.root, {
					id: "crafted-leg",
					ts: new Date().toISOString(),
					actor: AGENT,
					op: "replace",
					scope: "project",
					projectKey,
					target: { slug: "keep" },
					beforeExists: true,
					...(snapshot !== undefined ? { snapshot } : {}),
					...(operationId !== undefined ? { operationId } : {}),
				});

				const refused = await globalVault.undo(renamed.changeId, { kind: "user" });
				expect(refused.ok).toBe(false);
				expect(refused.error).toContain("different project");
				expect(vaultA.readNote("project", "keep")!.body).toBe("unrelated");
				expect(globalVault.readNote("global", "after")).toBeDefined();
			});
		});
	});

	it("undoRun keeps an older change when a newer same-run change cannot be undone", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			const run = DREAM("run-partial");
			await putNote(v, "global", "x", "v1", run);
			const appended = mustWrite(
				await v.write({ op: "append", scope: "global", target: { slug: "x" }, content: "v2" }, run),
			);
			// Destroy the append's snapshot so it stays applied but un-undoable.
			const snapEntry = readChangelog(v.root).find((e) => e.id === appended.changeId)!;
			rmSync(join(v.root, snapEntry.snapshot!), { force: true });

			const result = await v.undoRun("run-partial", AGENT);
			expect(result.undone).toEqual([]);
			expect(result.skipped).toHaveLength(2);
			expect(v.readNote("global", "x")!.body).toContain("v2");
		});
	});

	it("undo rolls back applied changes when a later write fails", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "before", "original");
			const renamed = mustWrite(
				await v.write(
					{ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" },
					{ kind: "user" },
				),
			);
			const notePath = join(v.root, "global", "notes", "after.md");
			const indexPath = join(v.root, "global", "MEMORY.md");
			const logPath = join(v.root, ".history", "changelog.jsonl");
			const bytes = {
				note: readFileSync(notePath, "utf8"),
				index: readFileSync(indexPath, "utf8"),
				log: readFileSync(logPath, "utf8"),
			};
			durableMock.failOnce.add(indexPath);
			expect((await v.undo(renamed.changeId, { kind: "user" })).ok).toBe(false);
			expect(readFileSync(notePath, "utf8")).toBe(bytes.note);
			expect(existsSync(join(v.root, "global", "notes", "before.md"))).toBe(false);
			expect(readFileSync(indexPath, "utf8")).toBe(bytes.index);
			expect(readFileSync(logPath, "utf8")).toBe(bytes.log);
		});
	});

	it("undo still removes a legacy first pinned write without beforeExists", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			const changed = mustWrite(
				await v.write(
					{ op: "replace", scope: "global", target: { block: "user" }, content: "pref" },
					{ kind: "user" },
				),
			);
			// Legacy entries carried no beforeExists flag; strip it to simulate one.
			const logPath = join(v.root, ".history", "changelog.jsonl");
			const entries = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			delete entries.find((entry) => entry.id === changed.changeId)!.beforeExists;
			writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			expect((await v.undo(changed.changeId, { kind: "user" })).ok).toBe(true);
			expect(existsSync(join(v.root, "global", "_pinned", "user.md"))).toBe(false);
		});
	});

	it("undo fails without touching content when the snapshot file is gone", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			mustWrite(
				await v.write(
					{ op: "replace", scope: "global", target: { block: "user" }, content: "v1" },
					{ kind: "user" },
				),
			);
			const second = mustWrite(
				await v.write(
					{ op: "replace", scope: "global", target: { block: "user" }, content: "v2" },
					{ kind: "user" },
				),
			);
			const entry = readChangelog(v.root).find((e) => e.id === second.changeId)!;
			rmSync(join(v.root, entry.snapshot!));
			expect((await v.undo(second.changeId, { kind: "user" })).ok).toBe(false);
			expect(v.readPinned("global", "user")).toBe("v2\n");
			expect(readChangelog(v.root).some((e) => e.op === "undo")).toBe(false);
		});
	});

	it("rolls back earlier writes if a later file cannot be written", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "keep", "original");
			const path = v.readNote("global", "keep")!.path;
			const raw = readFileSync(path, "utf8");
			expect(() =>
				applyVaultFileChanges([
					{ path, before: raw, after: "changed" },
					{ path: join(path, "child.md"), before: undefined, after: "fail" },
				]),
			).toThrow();
			expect(readFileSync(path, "utf8")).toBe(raw);
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

	describe("crafted changelog entries", () => {
		it("undo refuses a traversal slug and leaves outside files intact", async () => {
			await withMemoryFixture(async (f) => {
				const v = f.vault();
				const victim = join(f.root, "outside", "keep.md");
				mkdirSync(dirname(victim), { recursive: true });
				writeFileSync(victim, "precious");
				const notesDir = join(getScopeDir(v.root, "global"), "notes");
				const slug = relative(notesDir, victim).replace(/\.md$/, "");
				expect(slug).toContain("..");
				appendChangelog(v.root, {
					id: "evil-traversal",
					ts: new Date().toISOString(),
					actor: AGENT,
					op: "create",
					scope: "global",
					target: { slug },
					beforeExists: false,
				});

				const undone = await v.undo("evil-traversal", AGENT);
				expect(undone.ok).toBe(false);
				expect(existsSync(victim)).toBe(true);
				expect(readChangelog(v.root).some((entry) => entry.op === "undo")).toBe(false);
			});
		});

		it("undo refuses a group member pointing at another project", async () => {
			await withMemoryFixture(async (f) => {
				const v = f.vault();
				await putNote(v, "global", "before", "x");
				const renamed = mustWrite(
					await v.write({ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" }, AGENT),
				);
				const operationId = readChangelog(v.root).find((entry) => entry.id === renamed.changeId)?.operationId;
				// A foreign-but-well-formed project key: inside the vault root, outside this vault's scope.
				const foreignKey = "a".repeat(64);
				const foreignNotes = join(getScopeDir(v.root, "project", foreignKey), "notes");
				mkdirSync(foreignNotes, { recursive: true });
				writeFileSync(join(foreignNotes, "keep.md"), "other project's note");
				appendChangelog(v.root, {
					id: "evil-member",
					ts: new Date().toISOString(),
					actor: AGENT,
					op: "create",
					scope: "project",
					projectKey: foreignKey,
					target: { slug: "keep" },
					beforeExists: false,
					...(operationId !== undefined ? { operationId } : {}),
				});

				const undone = await v.undo(renamed.changeId, AGENT);
				expect(undone.ok).toBe(false);
				expect(existsSync(join(foreignNotes, "keep.md"))).toBe(true);
				expect(v.readNote("global", "after")).toBeDefined();
			});
		});

		it("undo refuses a group member with a traversal project key", async () => {
			await withMemoryFixture(async (f) => {
				const v = f.vault();
				await putNote(v, "global", "before", "x");
				const renamed = mustWrite(
					await v.write({ op: "rename", scope: "global", target: { slug: "before" }, newSlug: "after" }, AGENT),
				);
				const operationId = readChangelog(v.root).find((entry) => entry.id === renamed.changeId)?.operationId;
				const projectsDir = dirname(getScopeDir(v.root, "project", "x"));
				const victim = join(f.root, "escape", "notes", "keep.md");
				mkdirSync(dirname(victim), { recursive: true });
				writeFileSync(victim, "precious");
				appendChangelog(v.root, {
					id: "evil-member-traversal",
					ts: new Date().toISOString(),
					actor: AGENT,
					op: "create",
					scope: "project",
					projectKey: relative(projectsDir, join(f.root, "escape")),
					target: { slug: "keep" },
					beforeExists: false,
					...(operationId !== undefined ? { operationId } : {}),
				});

				const undone = await v.undo(renamed.changeId, AGENT);
				expect(undone.ok).toBe(false);
				expect(existsSync(victim)).toBe(true);
				expect(v.readNote("global", "after")).toBeDefined();
			});
		});

		it("undoRun skips a traversal target instead of deleting outside files", async () => {
			await withMemoryFixture(async (f) => {
				const v = f.vault();
				const victim = join(f.root, "outside-run", "keep.md");
				mkdirSync(dirname(victim), { recursive: true });
				writeFileSync(victim, "precious");
				const notesDir = join(getScopeDir(v.root, "global"), "notes");
				const slug = relative(notesDir, victim).replace(/\.md$/, "");
				appendChangelog(v.root, {
					id: "evil-run-entry",
					ts: new Date().toISOString(),
					actor: DREAM("evil-run"),
					op: "create",
					scope: "global",
					target: { slug },
					beforeExists: false,
				});

				const result = await v.undoRun("evil-run", AGENT);
				expect(result.undone).toHaveLength(0);
				expect(result.skipped).toHaveLength(1);
				expect(existsSync(victim)).toBe(true);
			});
		});

		it("undoMemoryRun skips malformed project identities and actors", async () => {
			await withMemoryFixture(async (f) => {
				const v = f.vault();
				const projectsDir = dirname(getScopeDir(v.root, "project", "x"));
				const victim = join(f.root, "escape2", "notes", "keep.md");
				mkdirSync(dirname(victim), { recursive: true });
				writeFileSync(victim, "precious");
				appendChangelog(v.root, {
					id: "evil-run-project",
					ts: new Date().toISOString(),
					actor: DREAM("run-bad"),
					op: "create",
					scope: "project",
					projectKey: relative(projectsDir, join(f.root, "escape2")),
					target: { slug: "keep" },
					beforeExists: false,
				});
				// A run entry with no actor must not crash the run filter.
				appendChangelog(v.root, {
					id: "evil-run-noactor",
					ts: new Date().toISOString(),
					actor: null,
					op: "create",
					scope: "global",
					target: { slug: "irrelevant" },
					beforeExists: false,
				} as unknown as Parameters<typeof appendChangelog>[1]);

				const result = await undoMemoryRun({ agentDir: f.agentDir, runId: "run-bad", actor: AGENT });
				expect(result.undone).toHaveLength(0);
				expect(result.skipped).toHaveLength(1);
				expect(result.skipped[0]!.reason).toContain("project identity");
				expect(existsSync(victim)).toBe(true);
			});
		});

		it("undo reports a clean error for a malformed target", async () => {
			await withMemoryFixture(async (f) => {
				const v = f.vault();
				appendChangelog(v.root, {
					id: "evil-target",
					ts: new Date().toISOString(),
					actor: AGENT,
					op: "delete",
					scope: "global",
					target: 42,
				} as unknown as Parameters<typeof appendChangelog>[1]);

				const undone = await v.undo("evil-target", AGENT);
				expect(undone.ok).toBe(false);
				expect(undone.error).toContain("malformed");
			});
		});

		it("snapshot pruning survives malformed entries", () => {
			const vault = makeVault();
			appendChangelog(vault.root, {
				id: "bad-snap-project",
				ts: new Date().toISOString(),
				actor: AGENT,
				op: "create",
				scope: "project",
				projectKey: "../../outside",
				target: { slug: "y" },
				snapshot: "x",
			});
			appendChangelog(vault.root, {
				id: "bad-snap-target",
				ts: new Date().toISOString(),
				actor: AGENT,
				op: "create",
				scope: "global",
				target: 42,
				snapshot: "z",
			} as unknown as Parameters<typeof appendChangelog>[1]);
			expect(() =>
				pruneSnapshots(vault.root, {
					snapshotsPerTarget: MEMORY_LIMITS.snapshotsPerTarget,
					snapshotMaxAgeDays: 90,
				}),
			).not.toThrow();
		});
	});
});
