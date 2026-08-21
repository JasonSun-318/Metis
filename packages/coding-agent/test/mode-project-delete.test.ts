import { execFileSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAutoMemoryPaths } from "../src/core/auto-memory.ts";
import {
	type ModeProjectDeleteHooks,
	type ModeProjectSessionTarget,
	recoverInterruptedProjectTrash,
	trashModeProjectData,
} from "../src/core/mode-project-delete.ts";
import {
	createSessionWorkDir,
	getOwnedSessionWorkDirs,
	getSessionAttachmentDir,
} from "../src/core/session-attachments.ts";
import { getOwnedSessionJournalArtifacts } from "../src/core/session-journal.ts";
import {
	getDefaultSessionDir,
	getSessionDisplayMetadataPath,
	getSessionImageDir,
	getSessionSubagentDir,
	getSessionToolOutputDir,
	getSessionUnreadStatePath,
	moveSessionFileWithLease,
	SessionManager,
} from "../src/core/session-manager.ts";

const transactionId = "12345678-1234-4234-8234-123456789abc";

interface TestLayout {
	root: string;
	agentDir: string;
	sessionsRoot: string;
	cwd: string;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function write(path: string, content = "owned"): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function createLayout(): TestLayout {
	const root = mkdtempSync(join(tmpdir(), "metis-project-delete-"));
	const agentDir = join(root, "agent");
	const sessionsRoot = join(agentDir, "sessions");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionsRoot, { recursive: true });
	return { root, agentDir, sessionsRoot, cwd };
}

function createSession(
	layout: TestLayout,
	id: string,
	mode: "chat" | "code",
	options: { cwd?: string; archived?: boolean; scheduled?: boolean } = {},
): { path: string; target: ModeProjectSessionTarget } {
	const cwd = options.cwd ?? layout.cwd;
	const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, layout.agentDir), {
		id,
		mode,
		...(options.scheduled ? { scheduled: { taskId: `task-${id}`, runId: `run-${id}` } } : {}),
	});
	const activePath = manager.getSessionFile();
	manager.close();
	if (!activePath) throw new Error("Test session was not persisted");
	const path = options.archived
		? join(layout.sessionsRoot, ".archive", relative(layout.sessionsRoot, activePath))
		: activePath;
	if (options.archived) {
		mkdirSync(dirname(path), { recursive: true });
		moveSessionFileWithLease(activePath, path);
	}
	const catalogRoot = options.archived ? join(layout.sessionsRoot, ".archive") : layout.sessionsRoot;
	return {
		path,
		target: { sessionId: id, path, relativePath: relative(catalogRoot, path), archived: options.archived ?? false },
	};
}

function hooks(overrides: Partial<ModeProjectDeleteHooks> = {}): ModeProjectDeleteHooks {
	return {
		readSessionHeader: (path) => {
			const header = SessionManager.openReadOnly(path).getHeader();
			if (!header) throw new Error("Missing session header");
			return header;
		},
		getSessionDisplayMetadataPath,
		getSessionUnreadStatePath,
		getSessionImageDir,
		getSessionToolOutputDir,
		getSessionSubagentDir,
		trash: (operationDir) => rmSync(operationDir, { recursive: true }),
		...overrides,
	};
}

function input(layout: TestLayout, sessions: readonly ModeProjectSessionTarget[]) {
	return {
		agentDir: layout.agentDir,
		sessionsRoot: layout.sessionsRoot,
		mode: "chat" as const,
		cwd: layout.cwd,
		sessions,
	};
}

function writeHeader(path: string, id: string, cwd: string, mode: "chat" | "code" = "chat"): void {
	write(
		path,
		`${JSON.stringify({
			type: "session",
			version: 11,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			mode,
			cwdOrigin: "user-selected",
			permissionMode: "ask",
		})}\n`,
	);
}

describe("mode project Trash", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("deletes only one mode's ordinary sessions and proven-owned data", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const active = createSession(layout, "chat-active", "chat");
		const archived = createSession(layout, "chat-archived", "chat", { archived: true });
		const code = createSession(layout, "code-active", "code");
		const childCwd = join(layout.cwd, "child");
		mkdirSync(childCwd);
		const child = createSession(layout, "chat-child", "chat", { cwd: childCwd });
		const scheduled = createSession(layout, "chat-scheduled", "chat", { scheduled: true });

		const owned = new Set<string>();
		for (const session of [active, archived]) {
			const manager = SessionManager.open(session.path);
			manager.appendSessionInfo(session.target.sessionId);
			manager.setSessionUnread(true);
			manager.close();
			owned.add(getSessionDisplayMetadataPath(session.path));
			owned.add(getSessionUnreadStatePath(session.path));
		}
		const decoys: string[] = [];
		for (const session of [active, archived]) {
			for (const path of [session.path, join(layout.sessionsRoot, session.target.relativePath)]) {
				owned.add(write(join(getSessionImageDir(path), "image.png")));
				owned.add(write(join(getSessionToolOutputDir(path), "tool.txt")));
			}
			owned.add(write(join(getSessionAttachmentDir(layout.agentDir, session.target.sessionId), "attachment.txt")));
			const subagentDir = getSessionSubagentDir(layout.agentDir, session.target.sessionId);
			const subagentId = `sub-${session.target.sessionId}`;
			const subagent = SessionManager.create(layout.cwd, subagentDir, {
				id: subagentId,
				mode: "chat",
				subagent: { agentId: subagentId, name: "owned", parentSessionId: session.target.sessionId },
			});
			const subagentPath = subagent.getSessionFile()!;
			subagent.close();
			owned.add(subagentPath);
			owned.add(write(join(getSessionImageDir(subagentPath), "image.png")));
			owned.add(write(join(getSessionToolOutputDir(subagentPath), "tool.txt")));
			owned.add(write(join(createSessionWorkDir(layout.agentDir, session.target.sessionId), "draft-a.txt")));
			owned.add(write(join(createSessionWorkDir(layout.agentDir, session.target.sessionId), "draft-b.txt")));

			const recoveryDirectory = join(dirname(session.path), ".recovery");
			const artifacts = [
				join(dirname(session.path), `.${basename(session.path)}.${transactionId}.replace.tmp`),
				join(dirname(session.path), `.${basename(session.path)}.recovery-copy-${transactionId}.replace.tmp`),
				join(dirname(session.path), `.${basename(session.path)}.${transactionId}.replace.bak`),
				join(dirname(session.path), `.${basename(session.path)}.keep-v11.${transactionId}.replace.bak`),
				join(recoveryDirectory, `${parse(session.path).name}-42-${transactionId}.partial`),
				join(recoveryDirectory, `${basename(session.path)}.42.nonce.reclaim.json`),
				join(recoveryDirectory, `${basename(session.path)}.42.nonce.force-claim.json`),
			];
			for (const artifact of artifacts) owned.add(write(artifact));
			const recoveredLease = join(recoveryDirectory, `${basename(session.path)}.42.nonce.lease`);
			owned.add(write(join(recoveredLease, "owner.json")));
			expect(getOwnedSessionJournalArtifacts(session.path)).toEqual(
				expect.arrayContaining([...artifacts, recoveredLease]),
			);
			decoys.push(write(join(dirname(session.path), `.${basename(session.path)}.invalid.replace.tmp`)));
			decoys.push(write(join(recoveryDirectory, `${parse(session.path).name}-not-owned.partial`)));
		}

		const sharedMemory = getAutoMemoryPaths(layout.agentDir, layout.cwd).project;
		const preservedPaths = [
			code.path,
			child.path,
			scheduled.path,
			write(sharedMemory.indexPath, "shared memory"),
			write(join(layout.agentDir, "memory", "global", "MEMORY.md"), "global memory"),
			write(join(layout.agentDir, "skills", "sample", "SKILL.md"), "user skill"),
			write(join(layout.cwd, ".agents", "skills", "sample", "SKILL.md"), "project skill"),
			write(join(layout.cwd, "source.txt"), "source"),
			write(join(layout.agentDir, "project-trust.json")),
			write(join(layout.agentDir, "schedules", "tasks.json")),
			write(join(layout.agentDir, "quarantine", "untouched")),
			write(join(layout.agentDir, "tmp", "document-work", "chat-active-notowned", "keep")),
			...decoys,
		];
		const preserved = new Map(preservedPaths.map((path) => [path, readFileSync(path)]));

		const trashCalls: string[] = [];
		const result = await trashModeProjectData(
			input(layout, [active.target, archived.target]),
			hooks({
				trash: (operationDir) => {
					trashCalls.push(operationDir);
					rmSync(operationDir, { recursive: true });
				},
			}),
		);

		expect(result).toEqual({ ok: true, method: "trash", deletedSessionCount: 2 });
		expect(trashCalls).toHaveLength(1);
		for (const path of [active.path, archived.path, ...owned]) expect(existsSync(path), path).toBe(false);
		for (const [path, bytes] of preserved) expect(readFileSync(path), path).toEqual(bytes);
		expect(getOwnedSessionWorkDirs(layout.agentDir, "chat-active")).toEqual([]);
	});

	it("fails closed when the catalog snapshot changed", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "changed", "chat");
		const result = await trashModeProjectData(input(layout, []), hooks());

		expect(result).toMatchObject({ ok: false, code: "PROJECT_CHANGED" });
		expect(existsSync(session.path)).toBe(true);
	});

	it("moves nothing when a trusted target header no longer matches its ownership markers", async () => {
		for (const marker of ["id", "mode", "cwd", "scheduled"] as const) {
			const layout = createLayout();
			roots.push(layout.root);
			const session = createSession(layout, `marker-${marker}`, "chat");
			const lines = readFileSync(session.path, "utf8").trimEnd().split("\n");
			const header = JSON.parse(lines[0]) as Record<string, unknown>;
			if (marker === "id") header.id = "different-id";
			if (marker === "mode") header.mode = "code";
			if (marker === "cwd") header.cwd = join(layout.root, "different-cwd");
			if (marker === "scheduled") header.scheduled = { taskId: "task", runId: "run" };
			lines[0] = JSON.stringify(header);
			writeFileSync(session.path, `${lines.join("\n")}\n`);

			const result = await trashModeProjectData(input(layout, [session.target]), hooks());
			expect(result.ok, marker).toBe(false);
			expect(readFileSync(session.path, "utf8"), marker).toBe(`${lines.join("\n")}\n`);
			expect(existsSync(join(layout.agentDir, "tmp", "project-delete")), marker).toBe(false);
		}
	});

	it("fails closed while a target session is live", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const live = SessionManager.create(layout.cwd, getDefaultSessionDir(layout.cwd, layout.agentDir), {
			id: "live",
			mode: "chat",
		});
		const path = live.getSessionFile()!;
		const target = {
			sessionId: "live",
			path,
			relativePath: relative(layout.sessionsRoot, path),
			archived: false,
			updatedAt: "2000-01-01T00:00:00.000Z",
		};

		const result = await trashModeProjectData(input(layout, [target]), hooks());
		expect(result).toMatchObject({ ok: false, code: "SESSION_IN_USE" });
		expect(existsSync(path)).toBe(true);
		live.close();
	});

	it("rejects unsafe journal forms and an inode replacement before staging", async () => {
		for (const kind of ["missing", "hardlink", "symlink", "fifo", "replaced"] as const) {
			const layout = createLayout();
			roots.push(layout.root);
			const session = createSession(layout, `unsafe-${kind}`, "chat");
			const bytes = readFileSync(session.path);
			let customHooks = hooks();
			switch (kind) {
				case "missing":
					unlinkSync(session.path);
					break;
				case "hardlink":
					linkSync(session.path, `${session.path}.alias`);
					break;
				case "symlink": {
					const backing = `${session.path}.backing`;
					renameSync(session.path, backing);
					symlinkSync(backing, session.path);
					break;
				}
				case "fifo":
					unlinkSync(session.path);
					execFileSync("mkfifo", [session.path]);
					break;
				case "replaced":
					customHooks = hooks({
						readSessionHeader: (path) => {
							const header = SessionManager.openReadOnly(path).getHeader()!;
							renameSync(path, `${path}.inspected`);
							writeFileSync(path, bytes);
							return header;
						},
					});
					break;
			}

			const result = await trashModeProjectData(input(layout, [session.target]), customHooks);
			expect(result.ok, kind).toBe(false);
			expect(existsSync(join(layout.agentDir, "tmp", "project-delete")), kind).toBe(false);
		}
	});

	it("rejects duplicate catalog identities and unsafe owned-directory links", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "unsafe-owned", "chat");
		const duplicate = await trashModeProjectData(input(layout, [session.target, session.target]), hooks());
		expect(duplicate).toMatchObject({ ok: false, code: "SESSION_CORRUPT" });

		const outside = join(layout.root, "outside-assets");
		mkdirSync(outside);
		const imageDir = getSessionImageDir(session.path);
		mkdirSync(dirname(imageDir), { recursive: true });
		symlinkSync(outside, imageDir);
		const linked = await trashModeProjectData(input(layout, [session.target]), hooks());
		expect(linked).toMatchObject({ ok: false, code: "SESSION_CORRUPT" });
		unlinkSync(imageDir);
		write(imageDir, "not a directory");
		const wrongType = await trashModeProjectData(input(layout, [session.target]), hooks());
		expect(wrongType).toMatchObject({ ok: false, code: "SESSION_CORRUPT" });
		expect(existsSync(session.path)).toBe(true);
	});

	it("deletes a project whose source cwd no longer exists", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "missing-source", "chat");
		rmSync(layout.cwd, { recursive: true });

		const result = await trashModeProjectData(input(layout, [session.target]), hooks());
		expect(result).toEqual({ ok: true, method: "trash", deletedSessionCount: 1 });
		expect(existsSync(session.path)).toBe(false);
	});

	it("uses catalog storage refs when canonical cwd spelling differs", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "canonical-alias", "chat");

		const result = await trashModeProjectData(
			{ ...input(layout, [session.target]), cwd: realpathSync(layout.cwd) },
			hooks(),
		);
		expect(result).toEqual({ ok: true, method: "trash", deletedSessionCount: 1 });
		expect(existsSync(session.path)).toBe(false);
	});

	it("keeps other-mode and other-project creation responsive while Trash is pending", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "concurrent-delete", "chat");
		const enteredTrash = deferred<void>();
		const releaseTrash = deferred<void>();
		const pending = trashModeProjectData(
			input(layout, [session.target]),
			hooks({
				trash: async (operationDir) => {
					enteredTrash.resolve();
					await releaseTrash.promise;
					rmSync(operationDir, { recursive: true });
				},
			}),
		);
		await enteredTrash.promise;

		expect(() =>
			SessionManager.create(layout.cwd, getDefaultSessionDir(layout.cwd, layout.agentDir), {
				id: "blocked-chat",
				mode: "chat",
			}),
		).toThrow();
		const code = SessionManager.create(layout.cwd, getDefaultSessionDir(layout.cwd, layout.agentDir), {
			id: "allowed-code",
			mode: "code",
		});
		const otherCwd = join(layout.root, "other-project");
		mkdirSync(otherCwd);
		const other = SessionManager.create(otherCwd, getDefaultSessionDir(otherCwd, layout.agentDir), {
			id: "allowed-chat",
			mode: "chat",
		});
		const codePath = code.getSessionFile()!;
		const otherPath = other.getSessionFile()!;
		code.close();
		other.close();
		releaseTrash.resolve();

		expect(await pending).toEqual({ ok: true, method: "trash", deletedSessionCount: 1 });
		expect(existsSync(codePath)).toBe(true);
		expect(existsSync(otherPath)).toBe(true);
	});

	it("rolls every staged target back when Trash fails", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const first = createSession(layout, "rollback-a", "chat");
		const second = createSession(layout, "rollback-b", "chat");

		const result = await trashModeProjectData(
			input(layout, [first.target, second.target]),
			hooks({
				trash: () => {
					throw new Error("Trash unavailable");
				},
			}),
		);

		expect(result).toMatchObject({ ok: false, code: "OPERATION_FAILED" });
		expect(existsSync(first.path)).toBe(true);
		expect(existsSync(second.path)).toBe(true);
		expect(readdirSync(join(layout.agentDir, "tmp", "project-delete"))).toEqual([]);
	});

	it("restores targets 1-249 when staging rename 250 fails", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const directory = getDefaultSessionDir(layout.cwd, layout.agentDir);
		const sessions = Array.from({ length: 251 }, (_, index) => {
			const id = `rename-${String(index).padStart(3, "0")}`;
			const path = join(directory, `${id}.jsonl`);
			writeHeader(path, id, layout.cwd);
			return {
				sessionId: id,
				path,
				relativePath: relative(layout.sessionsRoot, path),
				archived: false,
			};
		});
		let stagingRenames = 0;
		let trashCalls = 0;

		const result = await trashModeProjectData(
			input(layout, sessions),
			hooks({
				rename: (source, destination) => {
					if (!source.includes(`${sep}project-delete${sep}`) && ++stagingRenames === 250) {
						throw new Error("rename 250 failed");
					}
					renameSync(source, destination);
				},
				trash: () => {
					trashCalls++;
				},
			}),
		);

		expect(result).toMatchObject({ ok: false, code: "OPERATION_FAILED" });
		expect(stagingRenames).toBe(250);
		expect(trashCalls).toBe(0);
		for (const session of sessions) expect(existsSync(session.path), session.path).toBe(true);
	});

	it("treats disappearance from a late Trash diagnostic as committed", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "late-diagnostic", "chat");
		const result = await trashModeProjectData(
			input(layout, [session.target]),
			hooks({
				trash: (operationDir) => {
					rmSync(operationDir, { recursive: true });
					throw new Error("late diagnostic");
				},
			}),
		);

		expect(result).toEqual({ ok: true, method: "trash", deletedSessionCount: 1 });
		expect(existsSync(session.path)).toBe(false);
	});

	it("recovers an interrupted rollback on startup", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const first = createSession(layout, "recover-a", "chat");
		const second = createSession(layout, "recover-b", "chat");
		let calls = 0;

		const result = await trashModeProjectData(
			input(layout, [first.target, second.target]),
			hooks({
				operationId: () => transactionId,
				rename: (source, destination) => {
					calls++;
					if (calls === 2 || calls === 3) throw new Error("simulated interruption");
					renameSync(source, destination);
				},
			}),
		);

		expect(result).toMatchObject({ ok: false, code: "OPERATION_FAILED" });
		expect(existsSync(join(layout.agentDir, "tmp", "project-delete", transactionId))).toBe(true);
		recoverInterruptedProjectTrash(layout.agentDir);
		expect(existsSync(first.path)).toBe(true);
		expect(existsSync(second.path)).toBe(true);
		expect(existsSync(join(layout.agentDir, "tmp", "project-delete", transactionId))).toBe(false);
	});

	it("preserves an interrupted operation when its recovery payload was replaced by a symlink", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const first = createSession(layout, "unsafe-recovery-a", "chat");
		const second = createSession(layout, "unsafe-recovery-b", "chat");
		let calls = 0;
		await trashModeProjectData(
			input(layout, [first.target, second.target]),
			hooks({
				operationId: () => transactionId,
				rename: (source, destination) => {
					calls++;
					if (calls === 2 || calls === 3) throw new Error("simulated interruption");
					renameSync(source, destination);
				},
			}),
		);

		const operationDir = join(layout.agentDir, "tmp", "project-delete", transactionId);
		const manifest = JSON.parse(readFileSync(join(operationDir, "manifest.json"), "utf8")) as {
			targets: { stagedRelativePath: string }[];
		};
		const staged = manifest.targets.map((target) => join(operationDir, target.stagedRelativePath)).find(existsSync)!;
		rmSync(staged, { recursive: true });
		const outside = write(join(layout.root, "outside-recovery"));
		symlinkSync(outside, staged);

		let recoveryError: unknown;
		try {
			recoverInterruptedProjectTrash(layout.agentDir);
		} catch (error) {
			recoveryError = error;
		}
		expect(String(recoveryError)).toContain("symbolic link");
		expect(existsSync(operationDir)).toBe(true);
	});

	it("does not create recovery leases through a replaced original ancestor", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const session = createSession(layout, "unsafe-original", "chat");
		let calls = 0;
		await trashModeProjectData(
			input(layout, [session.target]),
			hooks({
				operationId: () => transactionId,
				rename: (source, destination) => {
					calls++;
					if (calls === 1) {
						renameSync(source, destination);
						throw new Error("failed after rename");
					}
					if (calls === 2) throw new Error("rollback interrupted");
					renameSync(source, destination);
				},
			}),
		);

		const projectDirectory = dirname(session.path);
		const outside = join(layout.root, "outside-original");
		mkdirSync(outside);
		rmSync(projectDirectory, { recursive: true });
		symlinkSync(outside, projectDirectory);

		expect(() => recoverInterruptedProjectTrash(layout.agentDir)).toThrow(/symbolic link/);
		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(layout.agentDir, "tmp", "project-delete", transactionId))).toBe(true);
	});

	it("handles 500 sessions with one Trash call", async () => {
		const layout = createLayout();
		roots.push(layout.root);
		const directory = getDefaultSessionDir(layout.cwd, layout.agentDir);
		const sessions = Array.from({ length: 500 }, (_, index) => {
			const id = `bulk-${index}`;
			const path = join(directory, `${id}.jsonl`);
			writeHeader(path, id, layout.cwd);
			return {
				sessionId: id,
				path,
				relativePath: relative(layout.sessionsRoot, path),
				archived: false,
			};
		});
		let calls = 0;

		const result = await trashModeProjectData(
			input(layout, sessions),
			hooks({
				trash: (operationDir) => {
					calls++;
					rmSync(operationDir, { recursive: true });
				},
			}),
		);

		expect(result).toEqual({ ok: true, method: "trash", deletedSessionCount: 500 });
		expect(calls).toBe(1);
	}, 60_000);
});
