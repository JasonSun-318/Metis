import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileManager } from "../src/main/workspace-file-manager.ts";

const SESSION_ID = "10000000-0000-4000-8000-000000000099";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHarness() {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-workspace-files-"));
	roots.push(tempRoot);
	const project = path.join(tempRoot, "project");
	await Promise.all([
		mkdir(path.join(project, "assets"), { recursive: true }),
		mkdir(path.join(project, "src"), { recursive: true }),
		mkdir(path.join(project, "many"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(path.join(project, ".hidden"), "hidden"),
		writeFile(path.join(project, "README.md"), "# Preview"),
		writeFile(path.join(project, "src", "App.tsx"), "export const App = 1;"),
		writeFile(path.join(project, "assets", "logo.png"), Buffer.from("iVBORw0KGgo=", "base64")),
		writeFile(path.join(project, "binary.dat"), Buffer.from([0, 1, 2, 3])),
		writeFile(path.join(project, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 97)),
		writeFile(path.join(tempRoot, "outside.txt"), "outside"),
		...Array.from({ length: 220 }, (_, index) =>
			writeFile(path.join(project, "many", `file-${String(index).padStart(3, "0")}.txt`), "x"),
		),
	]);
	if (process.platform !== "win32") {
		await symlink(path.join(tempRoot, "outside.txt"), path.join(project, "outside-link"));
		await symlink(tempRoot, path.join(project, "outside-directory-link"), "dir");
		await symlink(path.join(project, "src"), path.join(project, "src-link"), "dir");
	}
	const fakeRipgrep = path.join(tempRoot, "fake-rg.mjs");
	const scanCounter = path.join(tempRoot, "rg-scans.txt");
	await writeFile(
		fakeRipgrep,
		[
			'import { appendFile, readdir } from "node:fs/promises";',
			'import path from "node:path";',
			`await appendFile(${JSON.stringify(scanCounter)}, "1");`,
			"await new Promise((resolve) => setTimeout(resolve, 25));",
			'async function walk(directory, prefix = "") {',
			"  const found = [];",
			"  for (const entry of await readdir(directory, { withFileTypes: true })) {",
			'    if (entry.name === ".git" || entry.isSymbolicLink()) continue;',
			'    const relative = prefix ? prefix + "/" + entry.name : entry.name;',
			"    if (entry.isDirectory()) found.push(...await walk(path.join(directory, entry.name), relative));",
			"    else if (entry.isFile()) found.push(relative);",
			"  }",
			"  return found;",
			"}",
			'process.stdout.write((await walk(process.cwd())).join("\\0"));',
		].join("\n"),
	);
	const openPath = vi.fn(async () => "");
	const showItemInFolder = vi.fn();
	const trashItem = vi.fn(async (target: string) => rm(target, { recursive: true }));
	const manager = new WorkspaceFileManager({
		rgCommand: process.execPath,
		rgArgsPrefix: [fakeRipgrep],
		openPath,
		showItemInFolder,
		trashItem,
	});
	return { manager, openPath, project: await realpath(project), scanCounter, showItemInFolder, trashItem };
}

function git(cwd: string, ...args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, stdio: "pipe" });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trim();
}

async function createReviewHarness() {
	const harness = await createHarness();
	const project = path.join(harness.project, "review-repository");
	await mkdir(project);
	await writeFile(path.join(project, "README.md"), "# Metis\n");
	git(project, "init");
	git(project, "config", "user.email", "review@example.com");
	git(project, "config", "user.name", "Metis Review");
	git(project, "add", "README.md");
	git(project, "commit", "-m", "initial");
	harness.manager.authorize(SESSION_ID, project);
	return { ...harness, project };
}

describe("WorkspaceFileManager", () => {
	it("returns lightweight review metadata and lazily loads one patch", async () => {
		const { manager, project } = await createReviewHarness();
		await appendFile(path.join(project, "README.md"), "Changed\n");
		await mkdir(path.join(project, "src"));
		await writeFile(path.join(project, "src", "new file.ts"), "export const value = 1;\n");

		const snapshot = await manager.getReview({ sessionId: SESSION_ID, revision: "working-tree" });
		expect(snapshot.kind).toBe("review");
		if (snapshot.kind !== "review") throw new Error("Expected review snapshot");
		expect(snapshot.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relativePath: "README.md",
					status: "modified",
					additions: 1,
					deletions: 0,
				}),
				expect.objectContaining({
					relativePath: "src/new file.ts",
					status: "untracked",
					additions: 1,
					deletions: 0,
				}),
			]),
		);
		expect(snapshot.commits[0]?.subject).toBe("initial");
		expect(JSON.stringify(snapshot)).not.toContain("@@");

		await expect(
			manager.getReviewFileDiff({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "README.md",
			}),
		).resolves.toEqual(expect.objectContaining({ kind: "text", patch: expect.stringContaining("+Changed") }));
		await expect(
			manager.getReviewFileDiff({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "src/new file.ts",
			}),
		).resolves.toEqual(expect.objectContaining({ kind: "text", patch: expect.stringContaining("+export const") }));
	});

	it("reads commit and rename metadata by full object id", async () => {
		const { manager, project } = await createReviewHarness();
		git(project, "mv", "README.md", "Guide.md");
		await appendFile(path.join(project, "Guide.md"), "Renamed\n");
		git(project, "add", "-A");
		git(project, "commit", "-m", "rename guide");
		const head = git(project, "rev-parse", "HEAD");

		const snapshot = await manager.getReview({ sessionId: SESSION_ID, revision: head });
		expect(snapshot.kind).toBe("review");
		if (snapshot.kind !== "review") throw new Error("Expected review snapshot");
		expect(snapshot.files).toContainEqual(
			expect.objectContaining({
				relativePath: "Guide.md",
				previousRelativePath: "README.md",
				status: "renamed",
				additions: 1,
				deletions: 0,
			}),
		);
		await expect(
			manager.getReviewFileDiff({ sessionId: SESSION_ID, revision: head, relativePath: "Guide.md" }),
		).resolves.toEqual(expect.objectContaining({ kind: "text", patch: expect.stringContaining("Renamed") }));
		await expect(
			manager.getReviewFileContext({ sessionId: SESSION_ID, revision: head, relativePath: "Guide.md" }),
		).resolves.toEqual({
			kind: "text",
			oldFile: expect.objectContaining({ name: "README.md", contents: "# Metis\n" }),
			newFile: expect.objectContaining({ name: "Guide.md", contents: "# Metis\nRenamed\n" }),
		});
	});

	it("returns selectable full object ids for older recent commits", async () => {
		const { manager, project } = await createReviewHarness();
		git(project, "commit", "--allow-empty", "-m", "empty fixture");

		const workingTree = await manager.getReview({ sessionId: SESSION_ID, revision: "working-tree" });
		expect(workingTree.kind).toBe("review");
		if (workingTree.kind !== "review") throw new Error("Expected review snapshot");
		const initial = workingTree.commits.find((commit) => commit.subject === "initial");
		expect(initial?.hash).toMatch(/^[a-f0-9]{40}$/u);
		await expect(manager.getReview({ sessionId: SESSION_ID, revision: initial!.hash })).resolves.toMatchObject({
			kind: "review",
			revision: initial!.hash,
		});
	});

	it("loads complete working-tree context lazily and bounds binary or oversized files", async () => {
		const { manager, project } = await createReviewHarness();
		const original = `${Array.from({ length: 120 }, (_, index) => `original-${index + 1}`).join("\n")}\n`;
		await writeFile(path.join(project, "long.ts"), original);
		await writeFile(path.join(project, "binary.dat"), Buffer.from([0, 1, 2]));
		await writeFile(path.join(project, "huge.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 97));
		git(project, "add", ".");
		git(project, "commit", "-m", "context fixtures");
		const changed = original.replace("original-60", "changed-60");
		await writeFile(path.join(project, "long.ts"), changed);
		await writeFile(path.join(project, "binary.dat"), Buffer.from([0, 1, 3]));
		await writeFile(path.join(project, "huge.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 98));

		await expect(
			manager.getReviewFileContext({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "long.ts",
			}),
		).resolves.toEqual({
			kind: "text",
			oldFile: expect.objectContaining({ name: "long.ts", contents: original }),
			newFile: expect.objectContaining({ name: "long.ts", contents: changed }),
		});
		await expect(
			manager.getReviewFileContext({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "binary.dat",
			}),
		).resolves.toEqual({ kind: "unavailable", reason: "binary" });
		await expect(
			manager.getReviewFileContext({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "huge.txt",
			}),
		).resolves.toEqual({ kind: "unavailable", reason: "too-large" });
	});

	it("returns safe non-rendering states for binary and oversized untracked files", async () => {
		const { manager, project } = await createReviewHarness();
		await writeFile(path.join(project, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		await writeFile(path.join(project, "huge.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 97));

		await expect(
			manager.getReviewFileDiff({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "binary.dat",
			}),
		).resolves.toEqual({ kind: "binary" });
		await expect(
			manager.getReviewFileDiff({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "huge.txt",
			}),
		).resolves.toEqual({ kind: "too-large" });
	});

	it("rejects unsafe review inputs and reports non-repositories", async () => {
		const { manager, project } = await createHarness();
		manager.authorize(SESSION_ID, project);
		await expect(manager.getReview({ sessionId: SESSION_ID, revision: "working-tree" })).resolves.toEqual({
			kind: "not-repository",
		});
		await expect(manager.getReview({ sessionId: SESSION_ID, revision: "HEAD" })).rejects.toThrow(
			"Invalid workspace review revision",
		);
		await expect(
			manager.getReviewFileDiff({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "../outside.txt",
			}),
		).rejects.toThrow("Invalid workspace review path");
		await expect(
			manager.getReviewFileContext({
				sessionId: SESSION_ID,
				revision: "working-tree",
				relativePath: "../outside.txt",
			}),
		).rejects.toThrow("Invalid workspace review path");
	});

	it("shares a short-lived file index and invalidates it after mutations", async () => {
		const { manager, project, scanCounter } = await createHarness();
		manager.authorize(SESSION_ID, project);
		await Promise.all([
			manager.search({ sessionId: SESSION_ID, query: "app" }),
			manager.search({ sessionId: SESSION_ID, query: "readme" }),
		]);
		await expect(readFile(scanCounter, "utf8")).resolves.toBe("1");

		await manager.mutateEntry({
			action: "create",
			sessionId: SESSION_ID,
			parentRelativePath: "src",
			name: "cached.ts",
			kind: "file",
		});
		await expect(manager.search({ sessionId: SESSION_ID, query: "cached" })).resolves.toEqual(["src/cached.ts"]);
		await expect(readFile(scanCounter, "utf8")).resolves.toBe("11");
	});

	it("lists, searches, and previews only authorized workspace files", async () => {
		const { manager, project } = await createHarness();
		await expect(manager.listDirectory({ sessionId: SESSION_ID, relativePath: "" })).rejects.toThrow(
			"Workspace session is not authorized",
		);
		await expect(
			manager.writeFile({
				sessionId: SESSION_ID,
				relativePath: "README.md",
				text: "blocked",
				expectedRevision: "a".repeat(64),
			}),
		).rejects.toThrow("Workspace session is not authorized");

		manager.authorize(SESSION_ID, project);
		const root = await manager.listDirectory({ sessionId: SESSION_ID, relativePath: "" });
		expect(root.slice(0, 3).map((entry) => [entry.name, entry.kind])).toEqual([
			["assets", "directory"],
			["many", "directory"],
			["src", "directory"],
		]);
		expect(root).toContainEqual({ name: ".hidden", relativePath: ".hidden", kind: "file" });
		if (process.platform !== "win32") {
			expect(root).toContainEqual({ name: "outside-link", relativePath: "outside-link", kind: "symlink" });
			expect(root).toContainEqual({
				name: "outside-directory-link",
				relativePath: "outside-directory-link",
				kind: "symlink",
			});
			expect(root).toContainEqual({ name: "src-link", relativePath: "src-link", kind: "directory" });
			await expect(
				manager.listDirectory({ sessionId: SESSION_ID, relativePath: "src-link" }),
			).resolves.toContainEqual({
				name: "App.tsx",
				relativePath: "src-link/App.tsx",
				kind: "file",
			});
			await expect(manager.readFile({ sessionId: SESSION_ID, relativePath: "src-link" })).rejects.toThrow(
				"Workspace target is not a file",
			);
			await expect(manager.readFile({ sessionId: SESSION_ID, relativePath: "outside-link" })).rejects.toThrow(
				"Workspace path escapes the authorized root",
			);
			await expect(
				manager.writeFile({
					sessionId: SESSION_ID,
					relativePath: "outside-link",
					text: "blocked",
					expectedRevision: "a".repeat(64),
				}),
			).rejects.toThrow("Workspace path escapes the authorized root");
		}

		await expect(manager.search({ sessionId: SESSION_ID, query: "app" })).resolves.toEqual(["src/App.tsx"]);
		await expect(manager.search({ sessionId: SESSION_ID, query: "FILE-" })).resolves.toHaveLength(200);

		const opened = await manager.readFile({ sessionId: SESSION_ID, relativePath: "README.md" });
		expect(opened).toMatchObject({
			kind: "text",
			absolutePath: path.join(project, "README.md"),
			text: "# Preview",
			revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		if (opened.kind !== "text") throw new Error("Expected text fixture");
		const originalMode = (await stat(path.join(project, "README.md"))).mode;
		await expect(
			manager.writeFile({
				sessionId: SESSION_ID,
				relativePath: "README.md",
				text: "# Edited",
				expectedRevision: opened.revision,
			}),
		).resolves.toMatchObject({ revision: expect.stringMatching(/^[a-f0-9]{64}$/u), byteLength: 8 });
		await expect(readFile(path.join(project, "README.md"), "utf8")).resolves.toBe("# Edited");
		expect((await stat(path.join(project, "README.md"))).mode).toBe(originalMode);

		await writeFile(path.join(project, "README.md"), "external change");
		await expect(
			manager.writeFile({
				sessionId: SESSION_ID,
				relativePath: "README.md",
				text: "stale draft",
				expectedRevision: opened.revision,
			}),
		).rejects.toThrow("Workspace file changed on disk");
		await expect(readFile(path.join(project, "README.md"), "utf8")).resolves.toBe("external change");
		await expect(manager.readFile({ sessionId: SESSION_ID, relativePath: "assets/logo.png" })).resolves.toMatchObject(
			{
				kind: "image",
				mediaType: "image/png",
				dataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
			},
		);
		await expect(manager.readFile({ sessionId: SESSION_ID, relativePath: "binary.dat" })).resolves.toMatchObject({
			kind: "unsupported",
			reason: "binary",
		});
		await expect(manager.readFile({ sessionId: SESSION_ID, relativePath: "large.txt" })).resolves.toMatchObject({
			kind: "unsupported",
			reason: "too-large",
		});

		manager.revoke(SESSION_ID);
		await expect(manager.search({ sessionId: SESSION_ID, query: "app" })).rejects.toThrow(
			"Workspace session is not authorized",
		);
		manager.authorize(SESSION_ID, project);
		manager.clear();
		await expect(manager.readFile({ sessionId: SESSION_ID, relativePath: "README.md" })).rejects.toThrow(
			"Workspace session is not authorized",
		);
	});

	it("opens and reveals only contained regular files", async () => {
		const { manager, openPath, project, showItemInFolder } = await createHarness();
		manager.authorize(SESSION_ID, project);
		await manager.openFile({ sessionId: SESSION_ID, relativePath: "README.md", action: "default" });
		expect(openPath).toHaveBeenCalledWith(path.join(project, "README.md"));
		await manager.openFile({ sessionId: SESSION_ID, relativePath: "README.md", action: "reveal" });
		expect(showItemInFolder).toHaveBeenCalledWith(path.join(project, "README.md"));

		openPath.mockResolvedValueOnce("No default application");
		await expect(
			manager.openFile({ sessionId: SESSION_ID, relativePath: "README.md", action: "default" }),
		).rejects.toThrow("No default application");
		await expect(manager.openFile({ sessionId: SESSION_ID, relativePath: "src", action: "default" })).rejects.toThrow(
			"Workspace target is not a file",
		);
	});

	it("creates, renames, moves, and trashes contained entries without overwrite", async () => {
		const { manager, project, trashItem } = await createHarness();
		manager.authorize(SESSION_ID, project);

		await expect(
			manager.mutateEntry({
				action: "create",
				sessionId: SESSION_ID,
				parentRelativePath: "src",
				name: "new.ts",
				kind: "file",
			}),
		).resolves.toMatchObject({ action: "create", kind: "file", relativePath: "src/new.ts" });
		await expect(readFile(path.join(project, "src", "new.ts"), "utf8")).resolves.toBe("");
		await expect(
			manager.mutateEntry({
				action: "create",
				sessionId: SESSION_ID,
				parentRelativePath: "",
				name: "archive",
				kind: "directory",
			}),
		).resolves.toMatchObject({ action: "create", kind: "directory", relativePath: "archive" });

		await expect(
			manager.mutateEntry({
				action: "rename",
				sessionId: SESSION_ID,
				relativePath: "src/new.ts",
				name: "renamed.ts",
			}),
		).resolves.toMatchObject({ previousRelativePath: "src/new.ts", relativePath: "src/renamed.ts" });
		await expect(
			manager.mutateEntry({
				action: "move",
				sessionId: SESSION_ID,
				relativePath: "src/renamed.ts",
				destinationDirectoryRelativePath: "archive",
			}),
		).resolves.toMatchObject({ previousRelativePath: "src/renamed.ts", relativePath: "archive/renamed.ts" });

		await expect(
			manager.mutateEntry({
				action: "create",
				sessionId: SESSION_ID,
				parentRelativePath: "archive",
				name: "renamed.ts",
				kind: "file",
			}),
		).rejects.toThrow("Workspace destination already exists");
		await expect(
			manager.mutateEntry({
				action: "trash",
				sessionId: SESSION_ID,
				relativePath: "archive/renamed.ts",
			}),
		).resolves.toMatchObject({ action: "trash", previousRelativePath: "archive/renamed.ts" });
		expect(trashItem).toHaveBeenCalledWith(path.join(project, "archive", "renamed.ts"));
		await expect(stat(path.join(project, "archive", "renamed.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects unsafe mutation targets and directory cycles", async () => {
		const { manager, project } = await createHarness();
		await expect(
			manager.mutateEntry({
				action: "create",
				sessionId: SESSION_ID,
				parentRelativePath: "",
				name: "blocked",
				kind: "file",
			}),
		).rejects.toThrow("Workspace session is not authorized");
		manager.authorize(SESSION_ID, project);

		await expect(manager.mutateEntry({ action: "trash", sessionId: SESSION_ID, relativePath: "" })).rejects.toThrow(
			"Workspace root cannot be changed",
		);
		await expect(
			manager.mutateEntry({
				action: "rename",
				sessionId: SESSION_ID,
				relativePath: "README.md",
				name: "src/App.tsx",
			}),
		).rejects.toThrow("Invalid workspace entry name");
		await expect(
			manager.mutateEntry({
				action: "move",
				sessionId: SESSION_ID,
				relativePath: "src",
				destinationDirectoryRelativePath: "src",
			}),
		).rejects.toThrow("Workspace directory cannot be moved into itself");
		await expect(
			manager.mutateEntry({
				action: "move",
				sessionId: SESSION_ID,
				relativePath: "README.md",
				destinationDirectoryRelativePath: "src/App.tsx",
			}),
		).rejects.toThrow("Workspace destination is not a directory");
		await expect(
			manager.mutateEntry({
				action: "rename",
				sessionId: SESSION_ID,
				relativePath: "README.md",
				name: "src",
			}),
		).rejects.toThrow("Workspace destination already exists");

		if (process.platform !== "win32") {
			await expect(
				manager.mutateEntry({
					action: "trash",
					sessionId: SESSION_ID,
					relativePath: "outside-link",
				}),
			).rejects.toThrow("Workspace symbolic links are read-only");
			await expect(
				manager.mutateEntry({
					action: "create",
					sessionId: SESSION_ID,
					parentRelativePath: "outside-directory-link",
					name: "escape.txt",
					kind: "file",
				}),
			).rejects.toThrow("Workspace symbolic links are read-only");
		}
	});
});
