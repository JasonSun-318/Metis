import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeChangeTracker } from "../src/core/code-changes.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(repository = false) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "metis-code-changes-")));
	directories.push(cwd);
	const path = join(cwd, "app.ts");
	await writeFile(path, "const value = 1;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	if (repository) {
		git("init", "-q");
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
	}
	return { cwd, path, git, tracker: new CodeChangeTracker(), scope: { cwd, paths: [path] } };
}

describe("Code change tracking", () => {
	it("bounds the net file list without losing full turn totals", async () => {
		const { cwd, tracker } = await fixture();
		const paths = Array.from({ length: 40 }, (_, i) => join(cwd, `${i}-${"name".repeat(15)}.ts`));
		await tracker.run("turn", "create-many", { cwd, paths }, () =>
			Promise.all(paths.map((path) => writeFile(path, "line\n"))),
		);
		const changes = tracker.take("create-many")!;
		expect(changes.turn.additions).toBe(40);
		expect(changes.turn.partial).toBe(true);
		expect(changes.turnFiles!.length).toBeLessThan(40);
		expect(changes.turnFiles?.every((file) => file.diff === undefined && file.truncated === undefined)).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(changes), "utf8")).toBeLessThan(20 * 1024);
	});
	it("keeps each step's diff and compares the turn against its first contents", async () => {
		const { tracker, scope, path } = await fixture();
		await tracker.run("turn-1", "first", scope, () => writeFile(path, "const value = 2;\n"));
		const first = tracker.take("first")!;
		expect(first.files[0]).toMatchObject({ path: "app.ts", additions: 1, deletions: 1 });
		expect(first.files[0]?.diff).toContain("-const value = 1;\n+const value = 2;");
		await tracker.run("turn-1", "second", scope, () => writeFile(path, "const value = 3;\n"));
		const second = tracker.take("second")!;
		expect(second.turn).toEqual({ additions: 1, deletions: 1, partial: false });
		expect(second.turnFiles).toEqual([{ path: "app.ts", kind: "modified", additions: 1, deletions: 1 }]);
		expect(second.files[0]?.diff).toContain("-const value = 2;\n+const value = 3;");
		expect(first.files[0]?.diff).toContain("+const value = 2;");
		await tracker.run("turn-1", "revert", scope, () => writeFile(path, "const value = 1;\n"));
		const reverted = tracker.take("revert")!;
		expect(reverted.turn).toEqual({ additions: 0, deletions: 0, partial: false });
		expect(reverted.turnFiles).toEqual([]);
	});

	it("resets the baseline for the next user turn and retains separate added and removed counts", async () => {
		const { tracker, scope, path } = await fixture();
		await tracker.run("turn-1", "first", scope, () => writeFile(path, "const value = 2;\nextra\n"));
		expect(tracker.take("first")?.turn).toMatchObject({ additions: 2, deletions: 1 });
		await tracker.run("turn-2", "next", scope, () => writeFile(path, "const value = 2;\nextra\nlast\n"));
		expect(tracker.take("next")?.turn).toMatchObject({ additions: 1, deletions: 0 });
	});

	it("counts create/delete and no-final-newline files, including a full create/delete cancellation", async () => {
		const { tracker, cwd } = await fixture();
		const path = join(cwd, "new.ts");
		const scope = { cwd, paths: [path] };
		await tracker.run("turn", "create", scope, () => writeFile(path, "one\ntwo"));
		expect(tracker.take("create")?.files[0]).toMatchObject({ kind: "added", additions: 2, deletions: 0 });
		await tracker.run("turn", "delete", scope, () => rm(path));
		const deleted = tracker.take("delete")!;
		expect(deleted.files[0]).toMatchObject({ kind: "deleted", additions: 0, deletions: 2 });
		expect(deleted.turn).toMatchObject({ additions: 0, deletions: 0 });
		expect(deleted.turnFiles).toEqual([]);
	});

	it("captures command edits, new files and removals without including preexisting Git changes", async () => {
		const { cwd, path, tracker, git } = await fixture(true);
		await writeFile(path, "already dirty\n");
		const scope = { cwd, paths: [], scanWorkspace: true };
		await tracker.run("turn", "command", scope, async () => {
			await writeFile(path, "command edit\n");
			await writeFile(join(cwd, "new.ts"), "new\n");
			git("add", ".");
			git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "inside command");
		});
		const result = tracker.take("command")!;
		expect(result.files).toHaveLength(2);
		expect(result.files.find((file) => file.path === "app.ts")?.diff).toContain("-already dirty");
		expect(result.turn).toEqual({ additions: 2, deletions: 1, partial: false });
		await tracker.run("turn", "remove", scope, () => rm(path));
		expect(tracker.take("remove")?.files[0]).toMatchObject({ additions: 0, deletions: 1, kind: "deleted" });
	});

	it("uses the pre-command Git revision for files that were initially clean", async () => {
		const { cwd, path, tracker } = await fixture(true);
		await tracker.run("turn", "command", { cwd, paths: [], scanWorkspace: true }, () => writeFile(path, "changed\n"));
		expect(tracker.take("command")?.files[0]?.diff).toContain("-const value = 1;");
	});

	it("captures commands in a folder without Git and does not add counts to a read-only command", async () => {
		const { cwd, path, tracker } = await fixture();
		const scope = { cwd, paths: [], scanWorkspace: true };
		await tracker.run("turn", "read", scope, () => readFile(path));
		expect(tracker.take("read")).toBeUndefined();
		await tracker.run("turn", "command", scope, () => writeFile(path, "changed\n"));
		expect(tracker.take("command")?.turn).toEqual({ additions: 1, deletions: 1, partial: false });
	});

	it("does not report incomplete workspace scans as changes when a command edits nothing", async () => {
		const { cwd, path, tracker } = await fixture(true);
		// An existing oversized file makes the bounded scan partial even when
		// the command only reads another file, as browser-control commands can.
		await writeFile(join(cwd, "existing-large.txt"), "x".repeat(2 * 1024 * 1024));
		await writeFile(path, "already dirty\n");
		const scope = { cwd, paths: [], scanWorkspace: true };
		await tracker.run("turn", "read-only", scope, () => readFile(path));
		expect(tracker.take("read-only")).toBeUndefined();
		await tracker.run("turn", "actual-edit", scope, () => writeFile(path, "command edit\n"));
		const changed = tracker.take("actual-edit")!;
		expect(changed.files).toHaveLength(1);
		expect(changed.files[0]).toMatchObject({ path: "app.ts", additions: 1, deletions: 1 });
		expect(changed.partial).toBe(true);
		expect(changed.turn).toEqual({ additions: 1, deletions: 1, partial: true });
	});

	it("captures tools that declare a writable directory rather than an individual file", async () => {
		const { cwd, path, tracker } = await fixture();
		await tracker.run("turn", "directory-tool", { cwd, paths: [cwd] }, () => writeFile(path, "changed\n"));
		expect(tracker.take("directory-tool")?.files[0]).toMatchObject({ path: "app.ts", additions: 1, deletions: 1 });
	});

	it("retains actual modifications even if the command later fails", async () => {
		const { tracker, path, scope } = await fixture();
		await expect(
			tracker.run("turn", "failed", scope, async () => {
				await writeFile(path, "partially changed\n");
				throw new Error("exit 1");
			}),
		).rejects.toThrow("exit 1");
		expect(tracker.take("failed")?.files[0]?.diff).toContain("+partially changed");
	});

	it("serializes concurrent mutations so one step does not count another step's changes", async () => {
		const { tracker, scope, path } = await fixture();
		await Promise.all([
			tracker.run("turn", "first", scope, () => writeFile(path, "second\n")),
			tracker.run("turn", "second", scope, () => writeFile(path, "third\n")),
		]);
		expect(tracker.take("first")?.files[0]?.diff).toContain("+second");
		expect(tracker.take("second")?.files[0]?.diff).toContain("-second\n+third");
	});

	it("excludes binary assets, ASCII PDFs and empty resources from text statistics", async () => {
		const { tracker, cwd, path, scope } = await fixture();
		await tracker.run("turn", "binary", scope, () => writeFile(path, Buffer.from([0, 1, 2])));
		expect(tracker.take("binary")).toBeUndefined();
		const paths = ["report.pdf", "metis.rsrc", "photo.png", "notes.md"].map((file) => join(cwd, file));
		await tracker.run("next", "mixed", { cwd, paths }, async () => {
			await writeFile(paths[0]!, "%PDF-1.4\nplain ASCII PDF\n");
			await writeFile(paths[1]!, "");
			await writeFile(paths[2]!, Buffer.from([0, 1, 2]));
			await writeFile(paths[3]!, "# Notes\n");
		});
		const mixed = tracker.take("mixed")!;
		expect(mixed.files.map((file) => file.path)).toEqual(["notes.md"]);
		expect(mixed.turnFiles).toEqual([{ path: "notes.md", kind: "added", additions: 1, deletions: 0 }]);
		expect(mixed.turn).toEqual({ additions: 1, deletions: 0, partial: false });
		await writeFile(path, "normal text\n");
		await tracker.run("large-turn", "large", scope, () => writeFile(path, "x".repeat(2 * 1024 * 1024)));
		expect(tracker.take("large")?.files[0]?.unavailable).toBe(true);
	});

	it("removes prior text counts when the file becomes binary in the same turn", async () => {
		const { tracker, scope, path } = await fixture();
		await tracker.run("turn", "text", scope, () => writeFile(path, "changed\n"));
		tracker.take("text");
		await tracker.run("turn", "binary", scope, () => writeFile(path, Buffer.from([0, 1])));
		expect(tracker.take("binary")?.turnFiles).toEqual([]);
	});

	it("bounds long historical previews without counting only the visible part", async () => {
		const { tracker, scope, path } = await fixture();
		const content = Array.from({ length: 500 }, (_, index) => `${index}: ${"内容".repeat(40)}`).join("\n");
		await tracker.run("turn", "long", scope, () => writeFile(path, content));
		const changes = tracker.take("long")!;
		expect(changes.files[0]).toMatchObject({ additions: 500, deletions: 1, truncated: true });
		expect(changes.turn).toEqual({ additions: 500, deletions: 1, partial: false });
		expect(Buffer.byteLength(JSON.stringify(changes), "utf8")).toBeLessThan(20 * 1024);
	});
});
