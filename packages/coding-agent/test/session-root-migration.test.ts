import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { syncDirectorySync } from "../src/core/durable-file.ts";
import { getSessionImageDir, SessionManager } from "../src/core/session-manager.ts";
import { migrateSessionsFromAgentRoot } from "../src/migrations.ts";
import { encodePathForStorage } from "../src/utils/paths.ts";

describe("legacy agent-root session migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function fixture(): { agentDir: string; cwd: string; sourcePath: string; targetPath: string } {
		const root = mkdtempSync(join(tmpdir(), "metis-session-root-migration-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const sourcePath = join(agentDir, "legacy-session.jsonl");
		const targetPath = join(agentDir, "sessions", encodePathForStorage(cwd), "legacy-session.jsonl");
		return { agentDir, cwd, sourcePath, targetPath };
	}

	function withAgentDir<T>(agentDir: string, operation: () => T): T {
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			return operation();
		} finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
		}
	}

	function createLegacySession(sourcePath: string, agentDir: string, cwd: string): SessionManager {
		return SessionManager.open(sourcePath, agentDir, cwd);
	}

	function migrationBackups(agentDir: string): string[] {
		return readdirSync(agentDir)
			.filter((name) => name.endsWith(".migrated"))
			.map((name) => join(agentDir, name));
	}

	function migrationCheckpoints(agentDir: string): string[] {
		return readdirSync(agentDir)
			.filter((name) => /^\.session-migration-reconcile\.[0-9a-f]{64}\.checkpoint\.json$/.test(name))
			.map((name) => join(agentDir, name));
	}

	function retireForCrash(
		sourcePath: string,
		agentDir: string,
		suffix = "00000000-0000-4000-8000-000000000001",
	): string {
		const retiredPath = join(agentDir, `.legacy-session.jsonl.${suffix}.migrated`);
		renameSync(sourcePath, retiredPath);
		syncDirectorySync(agentDir);
		return retiredPath;
	}

	function createRetiredPair(
		sourcePath: string,
		targetPath: string,
		agentDir: string,
		cwd: string,
	): { parentId: string; retiredPath: string } {
		const source = createLegacySession(sourcePath, agentDir, cwd);
		const parentId = source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
		source.close();
		SessionManager.importFrom(sourcePath, targetPath).close();
		return { parentId, retiredPath: retireForCrash(sourcePath, agentDir) };
	}

	it("skips a live writer, then copy-publishes and retires the source after release", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const writer = createLegacySession(sourcePath, agentDir, cwd);
			writer.appendMessage({ role: "user", content: "before migration", timestamp: Date.now() });

			migrateSessionsFromAgentRoot();
			expect(existsSync(sourcePath)).toBe(true);
			expect(existsSync(targetPath)).toBe(false);
			writer.appendMessage({ role: "user", content: "still owned", timestamp: Date.now() });
			writer.close();

			migrateSessionsFromAgentRoot();
			expect(existsSync(sourcePath)).toBe(false);
			expect(existsSync(targetPath)).toBe(true);
			expect(existsSync(`${sourcePath}.lease`)).toBe(false);
			expect(existsSync(`${targetPath}.lease`)).toBe(false);
			const snapshot = SessionManager.openReadOnly(targetPath);
			expect(snapshot.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
		});
	});

	it("re-homes image references before deleting the legacy journal", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const imageData = Buffer.from("durable-image-bytes").toString("base64");
			const writer = createLegacySession(sourcePath, agentDir, cwd);
			writer.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: imageData, mimeType: "image/png" },
				],
				timestamp: Date.now(),
			});
			writer.close();

			expect(readFileSync(sourcePath, "utf8")).toContain('"type":"image_ref"');
			migrateSessionsFromAgentRoot();

			expect(existsSync(sourcePath)).toBe(false);
			expect(existsSync(getSessionImageDir(targetPath))).toBe(true);
			expect(readFileSync(targetPath, "utf8")).toContain('"type":"image_ref"');
			const message = SessionManager.openReadOnly(targetPath)
				.getEntries()
				.find((entry) => entry.type === "message");
			expect(message?.type).toBe("message");
			const content =
				message?.type === "message" && "content" in message.message ? message.message.content : undefined;
			if (!Array.isArray(content)) {
				throw new Error("Expected hydrated image message");
			}
			expect(content).toContainEqual({
				type: "image",
				data: imageData,
				mimeType: "image/png",
			});
		});
	});

	it("preserves the source when a previously published target image no longer verifies", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({
				role: "user",
				content: [
					{
						type: "image",
						data: Buffer.from("published-target-image").toString("base64"),
						mimeType: "image/png",
					},
				],
				timestamp: Date.now(),
			});
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const targetImageDir = getSessionImageDir(targetPath);
			rmSync(join(targetImageDir, readdirSync(targetImageDir)[0]!));

			migrateSessionsFromAgentRoot();

			expect(existsSync(sourcePath)).toBe(true);
			expect(existsSync(targetPath)).toBe(true);
		});
	});

	it("preserves a divergent source when a colliding target is not a superset", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();

			const changedSource = SessionManager.open(sourcePath);
			changedSource.appendMessage({ role: "user", content: "source-only", timestamp: Date.now() });
			changedSource.close();

			migrateSessionsFromAgentRoot();
			expect(existsSync(sourcePath)).toBe(true);
			expect(existsSync(targetPath)).toBe(true);
		});
	});

	it("compares colliding journals before lossy image hydration", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({
				role: "user",
				content: [
					{
						type: "image",
						data: Buffer.from("raw-comparison-image").toString("base64"),
						mimeType: "image/png",
					},
				],
				timestamp: Date.now(),
			});
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();

			const hash = /"hash":"([a-f0-9]{64})"/.exec(readFileSync(sourcePath, "utf8"))?.[1];
			if (!hash) throw new Error("Expected durable image reference");
			writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace(hash, "invalid-source"));
			writeFileSync(targetPath, readFileSync(targetPath, "utf8").replace(hash, "invalid-target"));

			migrateSessionsFromAgentRoot();

			expect(existsSync(sourcePath)).toBe(true);
			expect(existsSync(targetPath)).toBe(true);
		});
	});

	it("preserves the source while a colliding target has an active writer", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
			source.close();

			const targetWriter = SessionManager.importFrom(sourcePath, targetPath);
			targetWriter.appendMessage({ role: "user", content: "target-owned", timestamp: Date.now() });
			migrateSessionsFromAgentRoot();

			expect(existsSync(sourcePath)).toBe(true);
			expect(() =>
				targetWriter.appendMessage({ role: "user", content: "still-owned", timestamp: Date.now() }),
			).not.toThrow();
			targetWriter.close();
		});
	});

	it.each(["missing", "corrupt", "symlink"] as const)("preserves the source when an image asset is %s", (failure) => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const imageBytes = Buffer.from("strict-migration-image");
			const writer = createLegacySession(sourcePath, agentDir, cwd);
			writer.appendMessage({
				role: "user",
				content: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }],
				timestamp: Date.now(),
			});
			writer.close();

			const imageDir = getSessionImageDir(sourcePath);
			const imagePath = join(imageDir, readdirSync(imageDir)[0]!);
			if (failure === "missing") {
				rmSync(imagePath);
			} else if (failure === "corrupt") {
				writeFileSync(imagePath, "corrupt");
			} else {
				const outsidePath = join(agentDir, "outside-image.png");
				writeFileSync(outsidePath, imageBytes);
				rmSync(imagePath);
				symlinkSync(outsidePath, imagePath);
			}

			migrateSessionsFromAgentRoot();
			expect(existsSync(sourcePath)).toBe(true);
			expect(existsSync(targetPath)).toBe(false);
		});
	});

	it("retires a source on rerun after the target was published but source retirement crashed", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
			source.close();
			const target = SessionManager.importFrom(sourcePath, targetPath);
			target.appendMessage({ role: "user", content: "target-only", timestamp: Date.now() });
			target.close();

			migrateSessionsFromAgentRoot();
			expect(existsSync(sourcePath)).toBe(false);
			expect(existsSync(targetPath)).toBe(true);
		});
	});

	it("reconciles a retired source left by a crash after the rename was durable", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			const parentId = source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			appendFileSync(
				retiredPath,
				`${JSON.stringify({
					type: "custom",
					customType: "retired-crash-tail",
					data: { marker: "tail-after-durable-rename" },
					id: "late1001",
					parentId,
					timestamp: new Date().toISOString(),
				})}\n`,
			);

			migrateSessionsFromAgentRoot();

			expect(existsSync(sourcePath)).toBe(false);
			expect(readFileSync(targetPath, "utf8")).toContain("tail-after-durable-rename");
			expect(readFileSync(retiredPath, "utf8")).toContain("tail-after-durable-rename");
		});
	});

	it("checkpoints the first strict reconciliation and skips unchanged journals on later startups", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			createRetiredPair(sourcePath, targetPath, agentDir, cwd);
			const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
			try {
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
				const checkpoints = migrationCheckpoints(agentDir);
				expect(checkpoints).toHaveLength(1);
				expect(lstatSync(checkpoints[0]!).nlink).toBe(1);

				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
			} finally {
				headerSpy.mockRestore();
			}
		});
	});

	it("re-scans a checkpointed backup after a late append, then checkpoints the new tail", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const { parentId, retiredPath } = createRetiredPair(sourcePath, targetPath, agentDir, cwd);
			migrateSessionsFromAgentRoot();
			appendFileSync(
				retiredPath,
				`${JSON.stringify({
					type: "custom",
					customType: "checkpoint-late-tail",
					data: { marker: "late-after-checkpoint" },
					id: "late3001",
					parentId,
					timestamp: new Date().toISOString(),
				})}\n`,
			);

			const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
			try {
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
				expect(readFileSync(targetPath, "utf8")).toContain("late-after-checkpoint");

				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
			} finally {
				headerSpy.mockRestore();
			}
		});
	});

	it.each(["replaced", "missing"] as const)("falls back to strict reconciliation when the target is %s", (change) => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const { parentId } = createRetiredPair(sourcePath, targetPath, agentDir, cwd);
			migrateSessionsFromAgentRoot();
			if (change === "missing") {
				rmSync(targetPath);
			} else {
				const replacement = `${targetPath}.replacement`;
				writeFileSync(
					replacement,
					`${readFileSync(targetPath, "utf8")}${JSON.stringify({
						type: "custom",
						customType: "checkpoint-target-replacement",
						data: { marker: "replacement-target" },
						id: "target3001",
						parentId,
						timestamp: new Date().toISOString(),
					})}\n`,
				);
				renameSync(replacement, targetPath);
			}

			const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
			try {
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
				expect(readFileSync(targetPath, "utf8")).toContain("shared");
				if (change === "replaced") {
					expect(readFileSync(targetPath, "utf8")).toContain("replacement-target");
					migrateSessionsFromAgentRoot();
					expect(headerSpy).toHaveBeenCalledTimes(1);
				}
			} finally {
				headerSpy.mockRestore();
			}
		});
	});

	it.each(["missing", "corrupt", "oversized"] as const)("ignores a %s reconciliation checkpoint", (failure) => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			createRetiredPair(sourcePath, targetPath, agentDir, cwd);
			migrateSessionsFromAgentRoot();
			const checkpoint = migrationCheckpoints(agentDir)[0]!;
			if (failure === "missing") rmSync(checkpoint);
			else writeFileSync(checkpoint, failure === "oversized" ? "x".repeat(4097) : "not-json\n");

			const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
			try {
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
				expect(lstatSync(checkpoint).isFile()).toBe(true);
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
			} finally {
				headerSpy.mockRestore();
			}
		});
	});

	it.each(["symlink", "hardlink"] as const)("ignores and safely replaces a checkpoint %s", (alias) => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			createRetiredPair(sourcePath, targetPath, agentDir, cwd);
			migrateSessionsFromAgentRoot();
			const checkpoint = migrationCheckpoints(agentDir)[0]!;
			const outside = join(agentDir, `outside-checkpoint-${alias}.json`);
			writeFileSync(outside, `outside-${alias}`);
			rmSync(checkpoint);
			if (alias === "symlink") symlinkSync(outside, checkpoint);
			else linkSync(outside, checkpoint);

			const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
			try {
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
				expect(readFileSync(outside, "utf8")).toBe(`outside-${alias}`);
				const stats = lstatSync(checkpoint);
				expect(stats.isFile()).toBe(true);
				expect(stats.nlink).toBe(1);
			} finally {
				headerSpy.mockRestore();
			}
		});
	});

	it.skipIf(process.platform === "win32")(
		"rejects a checkpoint FIFO without blocking and repairs it after strict reconciliation",
		({ skip }) => {
			const { agentDir, cwd, sourcePath, targetPath } = fixture();
			withAgentDir(agentDir, () => {
				createRetiredPair(sourcePath, targetPath, agentDir, cwd);
				migrateSessionsFromAgentRoot();
				const checkpoint = migrationCheckpoints(agentDir)[0]!;
				rmSync(checkpoint);
				const mkfifo = spawnSync("mkfifo", [checkpoint], { encoding: "utf8" });
				if (mkfifo.error && "code" in mkfifo.error && mkfifo.error.code === "ENOENT") {
					skip();
					return;
				}
				expect(mkfifo.status, mkfifo.stderr).toBe(0);

				const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
				try {
					migrateSessionsFromAgentRoot();
					expect(headerSpy).toHaveBeenCalledTimes(1);
					expect(lstatSync(checkpoint).isFile()).toBe(true);
				} finally {
					headerSpy.mockRestore();
				}
			});
		},
	);

	it("recovers idempotently when checkpoint publication crashes before rename", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			createRetiredPair(sourcePath, targetPath, agentDir, cwd);
			migrateSessionsFromAgentRoot();
			const checkpoint = migrationCheckpoints(agentDir)[0]!;
			const intendedBytes = readFileSync(checkpoint, "utf8");
			rmSync(checkpoint);
			const abandonedTemporary = join(agentDir, ".00000000-0000-4000-8000-000000000099.tmp");
			writeFileSync(abandonedTemporary, intendedBytes);

			const headerSpy = vi.spyOn(SessionManager, "readRetiredSessionHeader");
			try {
				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
				expect(readFileSync(checkpoint, "utf8")).toBe(intendedBytes);
				expect(readFileSync(abandonedTemporary, "utf8")).toBe(intendedBytes);

				migrateSessionsFromAgentRoot();
				expect(headerSpy).toHaveBeenCalledTimes(1);
			} finally {
				headerSpy.mockRestore();
			}
		});
	});

	it("reconciles only the complete prefix of a retired partial tail and is restart-idempotent", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			const parentId = source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			appendFileSync(
				retiredPath,
				`${JSON.stringify({
					type: "custom",
					customType: "retired-complete-prefix",
					data: { marker: "committed-before-partial" },
					id: "late2001",
					parentId,
					timestamp: new Date().toISOString(),
				})}\n{"type":"custom"`,
			);
			const retiredBefore = readFileSync(retiredPath, "utf8");

			migrateSessionsFromAgentRoot();

			const targetAfterFirst = readFileSync(targetPath, "utf8");
			expect(targetAfterFirst).toContain("committed-before-partial");
			expect(targetAfterFirst.endsWith('{"type":"custom"')).toBe(false);
			expect(readFileSync(retiredPath, "utf8")).toBe(retiredBefore);
			expect(existsSync(sourcePath)).toBe(false);

			migrateSessionsFromAgentRoot();
			expect(readFileSync(targetPath, "utf8")).toBe(targetAfterFirst);
			expect(readFileSync(retiredPath, "utf8")).toBe(retiredBefore);
			expect(existsSync(sourcePath)).toBe(false);
		});
	});

	it("recreates a missing target from a retired complete prefix without copying its partial tail", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({ role: "user", content: "recover-complete-prefix", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			appendFileSync(retiredPath, '{"partial":');
			const retiredBefore = readFileSync(retiredPath, "utf8");
			rmSync(targetPath);

			migrateSessionsFromAgentRoot();

			const targetAfterFirst = readFileSync(targetPath, "utf8");
			expect(targetAfterFirst).toContain("recover-complete-prefix");
			expect(targetAfterFirst).not.toContain('{"partial":');
			expect(readFileSync(retiredPath, "utf8")).toBe(retiredBefore);
			expect(existsSync(sourcePath)).toBe(false);

			migrateSessionsFromAgentRoot();
			expect(readFileSync(targetPath, "utf8")).toBe(targetAfterFirst);
			expect(readFileSync(retiredPath, "utf8")).toBe(retiredBefore);
		});
	});

	it("restores a divergent retired complete prefix without copying its partial tail", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			const parentId = source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const target = SessionManager.open(targetPath);
			target.appendCustomEntry("target-divergence", { marker: "target-only-partial-case" });
			target.close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			appendFileSync(
				retiredPath,
				`${JSON.stringify({
					type: "custom",
					customType: "source-divergence",
					data: { marker: "source-only-partial-case" },
					id: "late2002",
					parentId,
					timestamp: new Date().toISOString(),
				})}\n{"partial":`,
			);
			const retiredBefore = readFileSync(retiredPath, "utf8");

			migrateSessionsFromAgentRoot();

			const sourceAfterFirst = readFileSync(sourcePath, "utf8");
			expect(sourceAfterFirst).toContain("source-only-partial-case");
			expect(sourceAfterFirst).not.toContain('{"partial":');
			expect(readFileSync(targetPath, "utf8")).toContain("target-only-partial-case");
			expect(readFileSync(targetPath, "utf8")).not.toContain("source-only-partial-case");
			expect(readFileSync(retiredPath, "utf8")).toBe(retiredBefore);

			migrateSessionsFromAgentRoot();
			expect(readFileSync(sourcePath, "utf8")).toBe(sourceAfterFirst);
			expect(readFileSync(retiredPath, "utf8")).toBe(retiredBefore);
		});
	});

	it("reconciles retired images from the original legacy asset store", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const imageData = Buffer.from("retired-reconcile-image").toString("base64");
			const source = createLegacySession(sourcePath, agentDir, cwd);
			const parentId = source.appendMessage({
				role: "user",
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
				timestamp: Date.now(),
			});
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			rmSync(getSessionImageDir(targetPath), { recursive: true, force: true });
			const retiredPath = retireForCrash(sourcePath, agentDir);
			appendFileSync(
				retiredPath,
				`${JSON.stringify({
					type: "custom",
					customType: "retired-image-tail",
					data: { marker: "image-tail" },
					id: "late1002",
					parentId,
					timestamp: new Date().toISOString(),
				})}\n`,
			);

			migrateSessionsFromAgentRoot();

			const message = SessionManager.openReadOnly(targetPath)
				.getEntries()
				.find((entry) => entry.type === "message");
			if (message?.type !== "message" || !("content" in message.message)) {
				throw new Error("Expected reconciled image message");
			}
			expect(message.message.content).toContainEqual({ type: "image", data: imageData, mimeType: "image/png" });
			expect(readFileSync(targetPath, "utf8")).toContain("image-tail");
		});
	});

	it.each(["before", "after"] as const)(
		"keeps a recoverable copy when retired reconciliation fails %s target publication",
		(failure) => {
			const { agentDir, cwd, sourcePath, targetPath } = fixture();
			withAgentDir(agentDir, () => {
				const source = createLegacySession(sourcePath, agentDir, cwd);
				const parentId = source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
				source.close();
				SessionManager.importFrom(sourcePath, targetPath).close();
				const retiredPath = retireForCrash(sourcePath, agentDir);
				appendFileSync(
					retiredPath,
					`${JSON.stringify({
						type: "custom",
						customType: "reconcile-failure-tail",
						data: { marker: "survives-reconcile-failure" },
						id: "late1003",
						parentId,
						timestamp: new Date().toISOString(),
					})}\n`,
				);

				const original = SessionManager.prototype.reconcileRetiredDurableSource;
				const reconcileSpy = vi
					.spyOn(SessionManager.prototype, "reconcileRetiredDurableSource")
					.mockImplementation(function (this: SessionManager, retired, assets) {
						if (failure === "after") original.call(this, retired, assets);
						throw new Error("simulated reconcile crash");
					});
				try {
					migrateSessionsFromAgentRoot();
				} finally {
					reconcileSpy.mockRestore();
				}

				if (failure === "before") {
					expect(readFileSync(sourcePath, "utf8")).toContain("survives-reconcile-failure");
					expect(readFileSync(targetPath, "utf8")).not.toContain("survives-reconcile-failure");
				} else {
					expect(readFileSync(targetPath, "utf8")).toContain("survives-reconcile-failure");
				}
				expect(readFileSync(retiredPath, "utf8")).toContain("survives-reconcile-failure");
			});
		},
	);

	it("restores a divergent retired source without replacing the target", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			const parentId = source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			const target = SessionManager.open(targetPath);
			target.appendCustomEntry("target-divergence", { marker: "target-only" });
			target.close();
			appendFileSync(
				retiredPath,
				`${JSON.stringify({
					type: "custom",
					customType: "source-divergence",
					data: { marker: "source-only" },
					id: "late1004",
					parentId,
					timestamp: new Date().toISOString(),
				})}\n`,
			);

			migrateSessionsFromAgentRoot();

			expect(readFileSync(targetPath, "utf8")).toContain("target-only");
			expect(readFileSync(targetPath, "utf8")).not.toContain("source-only");
			expect(readFileSync(sourcePath, "utf8")).toContain("source-only");
			expect(existsSync(retiredPath)).toBe(true);
		});
	});

	it.each(["corrupt", "symlink", "hardlink"] as const)(
		"fails closed for a %s retired migration artifact",
		(failure) => {
			const { agentDir, cwd, sourcePath, targetPath } = fixture();
			withAgentDir(agentDir, () => {
				const source = createLegacySession(sourcePath, agentDir, cwd);
				source.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
				source.close();
				SessionManager.importFrom(sourcePath, targetPath).close();
				const retiredPath = retireForCrash(sourcePath, agentDir);
				if (failure === "corrupt") {
					writeFileSync(retiredPath, "not-json\n");
				} else {
					const outside = join(agentDir, `outside-${failure}.jsonl`);
					writeFileSync(outside, readFileSync(retiredPath));
					rmSync(retiredPath);
					try {
						if (failure === "symlink") symlinkSync(outside, retiredPath);
						else linkSync(outside, retiredPath);
					} catch (error) {
						if (process.platform === "win32" && failure === "symlink") {
							return;
						}
						throw error;
					}
				}

				migrateSessionsFromAgentRoot();

				expect(existsSync(sourcePath)).toBe(false);
				expect(readFileSync(targetPath, "utf8")).toContain("shared");
			});
		},
	);

	it("recreates a missing target from a validated retired source", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({ role: "user", content: "recover-missing-target", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			rmSync(targetPath);

			migrateSessionsFromAgentRoot();

			expect(readFileSync(targetPath, "utf8")).toContain("recover-missing-target");
			expect(existsSync(retiredPath)).toBe(true);
		});
	});

	it("restores a validated retired source beside a corrupt target", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			source.appendMessage({ role: "user", content: "recover-beside-corrupt-target", timestamp: Date.now() });
			source.close();
			SessionManager.importFrom(sourcePath, targetPath).close();
			const retiredPath = retireForCrash(sourcePath, agentDir);
			writeFileSync(targetPath, "corrupt-target\n");

			migrateSessionsFromAgentRoot();

			expect(readFileSync(targetPath, "utf8")).toBe("corrupt-target\n");
			expect(readFileSync(sourcePath, "utf8")).toContain("recover-beside-corrupt-target");
			expect(existsSync(retiredPath)).toBe(true);
		});
	});

	it("keeps an absolute tool output reference usable after migration", () => {
		const { agentDir, cwd, sourcePath, targetPath } = fixture();
		withAgentDir(agentDir, () => {
			const source = createLegacySession(sourcePath, agentDir, cwd);
			const outputDir = source.getToolOutputDir();
			if (!outputDir) throw new Error("Expected persisted tool output directory");
			mkdirSync(outputDir, { recursive: true });
			const fullOutputPath = join(outputDir, "full-output.txt");
			writeFileSync(fullOutputPath, "complete tool output");
			source.appendMessage(
				{ role: "user", content: [{ type: "text", text: "preview" }], timestamp: Date.now() },
				{ truncated: true, originalBytes: 20, previewBytes: 7, fullOutputPath },
			);
			source.close();

			migrateSessionsFromAgentRoot();

			const message = SessionManager.openReadOnly(targetPath)
				.getEntries()
				.find((entry) => entry.type === "message");
			if (message?.type !== "message") throw new Error("Expected migrated message");
			expect(message.toolOutput?.fullOutputPath).toBe(fullOutputPath);
			expect(existsSync(message.toolOutput!.fullOutputPath)).toBe(true);
			expect(readFileSync(message.toolOutput!.fullOutputPath, "utf8")).toBe("complete tool output");
		});
	});

	it.each(["append", "replace"] as const)(
		"restores a source that an external writer %ss at the retirement boundary",
		(mutation) => {
			const { agentDir, cwd, sourcePath, targetPath } = fixture();
			withAgentDir(agentDir, () => {
				const writer = createLegacySession(sourcePath, agentDir, cwd);
				const parentId = writer.appendMessage({
					role: "user",
					content: "before migration",
					timestamp: Date.now(),
				});
				writer.close();

				const originalCompare = SessionManager.prototype.containsDurablePrefixOf;
				let injected = false;
				const compareSpy = vi
					.spyOn(SessionManager.prototype, "containsDurablePrefixOf")
					.mockImplementation(function (this: SessionManager, source: SessionManager) {
						const result = originalCompare.call(this, source);
						if (!injected && source.getSessionFile() === sourcePath) {
							injected = true;
							if (mutation === "append") {
								appendFileSync(
									sourcePath,
									`${JSON.stringify({
										type: "custom",
										customType: "external-boundary",
										data: { marker: "appended-at-boundary" },
										id: "late0001",
										parentId,
										timestamp: new Date().toISOString(),
									})}\n`,
								);
							} else {
								writeFileSync(
									sourcePath,
									readFileSync(sourcePath, "utf8").replace("before migration", "replaced-at-boundary"),
								);
							}
						}
						return result;
					});

				try {
					migrateSessionsFromAgentRoot();
				} finally {
					compareSpy.mockRestore();
				}

				expect(injected).toBe(true);
				expect(existsSync(sourcePath)).toBe(true);
				expect(existsSync(targetPath)).toBe(true);
				const marker = mutation === "append" ? "appended-at-boundary" : "replaced-at-boundary";
				expect(readFileSync(sourcePath, "utf8")).toContain(marker);
				expect(readFileSync(targetPath, "utf8")).not.toContain(marker);
				expect(migrationBackups(agentDir)).toHaveLength(1);
				expect(readFileSync(migrationBackups(agentDir)[0]!, "utf8")).toContain(marker);
			});
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps data appended through an old fd after validation in the migrated backup",
		() => {
			const { agentDir, cwd, sourcePath, targetPath } = fixture();
			withAgentDir(agentDir, () => {
				const writer = createLegacySession(sourcePath, agentDir, cwd);
				const parentId = writer.appendMessage({ role: "user", content: "shared", timestamp: Date.now() });
				writer.close();
				const oldFd = openSync(sourcePath, "a");
				try {
					migrateSessionsFromAgentRoot();
					const lateRecord = `${JSON.stringify({
						type: "custom",
						customType: "external-old-fd",
						data: { marker: "late-after-validation" },
						id: "late0002",
						parentId,
						timestamp: new Date().toISOString(),
					})}\n`;
					writeSync(oldFd, lateRecord);
					fsyncSync(oldFd);
				} finally {
					closeSync(oldFd);
				}

				const backups = migrationBackups(agentDir);
				expect(existsSync(sourcePath)).toBe(false);
				expect(existsSync(targetPath)).toBe(true);
				expect(backups).toHaveLength(1);
				expect(readFileSync(backups[0]!, "utf8")).toContain("late-after-validation");
				expect(readFileSync(targetPath, "utf8")).not.toContain("late-after-validation");

				migrateSessionsFromAgentRoot();
				expect(migrationBackups(agentDir)).toEqual(backups);
				expect(readFileSync(targetPath, "utf8")).toContain("late-after-validation");
				expect(existsSync(sourcePath)).toBe(false);
			});
		},
	);
});
