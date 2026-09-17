import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceSandbox, WorkspaceSandboxError } from "../src/core/workspace-sandbox.ts";

describe("workspace sandbox protected roots", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	const root = () => {
		const value = mkdtempSync(join(tmpdir(), "metis-workspace-protected-"));
		roots.push(value);
		return value;
	};

	it("rejects workspace, write, and broad read roots that expose protected memory", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		const memory = join(base, "agent", "memory");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(memory, { recursive: true });
		await expect(
			createWorkspaceSandbox({ cwd: base, workspaceRoots: [base], protectedRoots: [memory] }),
		).rejects.toThrow(/protected root/i);
		await expect(
			createWorkspaceSandbox({
				cwd: workspace,
				workspaceRoots: [workspace],
				writeRoots: [join(base, "agent")],
				protectedRoots: [memory],
			}),
		).rejects.toThrow(/protected root/i);
		await expect(
			createWorkspaceSandbox({
				cwd: workspace,
				workspaceRoots: [workspace],
				readOnlyRoots: [join(base, "agent")],
				protectedRoots: [memory],
			}),
		).rejects.toThrow(/protected root/i);
	});
});

describe.runIf(process.env.METIS_TEST_OS_SANDBOX === "1")("workspace sandbox", () => {
	const roots: string[] = [];
	const temporaryDirectory = () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-workspace-sandbox-test-"));
		roots.push(directory);
		return directory;
	};

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("streams output while confining writes and shell network", async () => {
		const cwd = temporaryDirectory();
		const outside = temporaryDirectory();
		const attachments = temporaryDirectory();
		const workdir = temporaryDirectory();
		writeFileSync(join(attachments, "input.txt"), "attachment-ok");
		let sandbox: Awaited<ReturnType<typeof createWorkspaceSandbox>>;
		try {
			sandbox = await createWorkspaceSandbox({
				cwd,
				workspaceRoots: [cwd],
				readOnlyRoots: [attachments],
				writeRoots: [workdir],
			});
		} catch (error) {
			if (error instanceof WorkspaceSandboxError && error.code === "SANDBOX_UNAVAILABLE") return;
			throw error;
		}
		try {
			const chunks: Buffer[] = [];
			await expect(
				sandbox.operations.exec("printf sandbox-ok", cwd, { onData: (data) => chunks.push(data) }),
			).resolves.toEqual({ exitCode: 0 });
			expect(Buffer.concat(chunks).toString()).toContain("sandbox-ok");
			await expect(
				sandbox.operations.exec("printf workspace > workspace.txt", cwd, { onData: () => {} }),
			).resolves.toEqual({ exitCode: 0 });
			expect(existsSync(join(cwd, "workspace.txt"))).toBe(true);
			await expect(
				sandbox.operations.exec(
					`printf workdir > ${JSON.stringify(join(realpathSync(workdir), "output.txt"))}`,
					cwd,
					{
						onData: () => {},
					},
				),
			).resolves.toEqual({ exitCode: 0 });
			expect(existsSync(join(workdir, "output.txt"))).toBe(true);

			const attachmentChunks: Buffer[] = [];
			await expect(
				sandbox.operations.exec(`cat ${JSON.stringify(join(realpathSync(attachments), "input.txt"))}`, cwd, {
					onData: (data) => attachmentChunks.push(data),
				}),
			).resolves.toEqual({ exitCode: 0 });
			expect(Buffer.concat(attachmentChunks).toString()).toContain("attachment-ok");
			await expect(
				sandbox.operations.exec(
					`printf blocked > ${JSON.stringify(join(realpathSync(attachments), "blocked.txt"))}`,
					cwd,
					{
						onData: () => {},
					},
				),
			).resolves.not.toEqual({ exitCode: 0 });
			expect(existsSync(join(attachments, "blocked.txt"))).toBe(false);

			const blocked = join(outside, "blocked.txt");
			await expect(
				sandbox.operations.exec(`printf blocked > ${JSON.stringify(blocked)}`, cwd, { onData: () => {} }),
			).resolves.not.toEqual({ exitCode: 0 });
			expect(existsSync(blocked)).toBe(false);

			const unreadable = join(outside, "outside-secret.txt");
			writeFileSync(unreadable, "outside-secret");
			await expect(
				sandbox.operations.exec(`cat ${JSON.stringify(unreadable)}`, cwd, { onData: () => {} }),
			).resolves.not.toEqual({ exitCode: 0 });

			const packageManagerConfig = [
				"/usr/local/etc/redis.conf",
				"/usr/local/etc/openssl@3/openssl.cnf",
				"/opt/homebrew/etc/openssl@3/openssl.cnf",
			].find((path) => existsSync(path));
			if (packageManagerConfig) {
				await expect(
					sandbox.operations.exec(`wc -c < ${JSON.stringify(packageManagerConfig)}`, cwd, { onData: () => {} }),
				).resolves.not.toEqual({ exitCode: 0 });
			}

			await expect(
				sandbox.operations.exec("/usr/bin/curl --max-time 2 https://example.com", cwd, {
					onData: () => {},
					timeout: 5,
				}),
			).resolves.not.toEqual({ exitCode: 0 });
			const bindScript =
				"const s=require('node:net').createServer();s.on('error',()=>process.exit(7));s.listen(0,'127.0.0.1',()=>s.close(()=>process.exit(0)))";
			await expect(
				sandbox.operations.exec(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(bindScript)}`, cwd, {
					onData: () => {},
					timeout: 5,
				}),
			).resolves.not.toEqual({ exitCode: 0 });

			mkdirSync(join(cwd, "build"));
			writeFileSync(join(cwd, "build", "artifact"), "x");
			await expect(sandbox.operations.exec("rm -rf ./build", cwd, { onData: () => {} })).resolves.toEqual({
				exitCode: 0,
			});
			expect(existsSync(join(cwd, "build"))).toBe(false);
		} finally {
			await sandbox.dispose();
			await expect(sandbox.dispose()).resolves.toBeUndefined();
		}
	});

	it("mounts Plan workspaces read-only while preserving Metis temp writes", async () => {
		const workspace = temporaryDirectory();
		const sessionWorkDir = realpathSync(temporaryDirectory());
		writeFileSync(join(workspace, "tracked.txt"), "original");
		let sandbox: Awaited<ReturnType<typeof createWorkspaceSandbox>>;
		try {
			sandbox = await createWorkspaceSandbox({
				cwd: workspace,
				workspaceRoots: [workspace],
				writeRoots: [sessionWorkDir],
				workspaceReadOnly: true,
			});
		} catch (error) {
			if (error instanceof WorkspaceSandboxError && error.code === "SANDBOX_UNAVAILABLE") return;
			throw error;
		}
		let output = "";
		const exec = (command: string) =>
			sandbox.operations.exec(command, workspace, {
				onData: (data) => {
					output += data.toString();
				},
				env: { METIS_WORK_DIR: sessionWorkDir },
			});
		try {
			const writeResult = await exec("printf changed > tracked.txt");
			expect(writeResult.exitCode).not.toBe(0);
			expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("original");
			await expect(exec("cat tracked.txt")).resolves.toMatchObject({ exitCode: 0 });
			output = "";
			const result = await exec(
				'printf "METIS=%s\\nTMPDIR=%s\\nTMP=%s\\nTEMP=%s\\n" "$METIS_WORK_DIR" "$TMPDIR" "$TMP" "$TEMP" && test "$TMPDIR" = "$METIS_WORK_DIR" && test "$TMP" = "$METIS_WORK_DIR" && test "$TEMP" = "$METIS_WORK_DIR" && printf ok > "$METIS_WORK_DIR/result.txt"',
			);
			expect(result, output).toMatchObject({ exitCode: 0 });
			expect(output).toBe(
				`METIS=${sessionWorkDir}\nTMPDIR=${sessionWorkDir}\nTMP=${sessionWorkDir}\nTEMP=${sessionWorkDir}\n`,
			);
			output = "";
			const temporaryFileResult = await exec('printf second > "$TMPDIR/second.txt"');
			expect(temporaryFileResult, output).toMatchObject({ exitCode: 0 });
			expect(readFileSync(join(sessionWorkDir, "second.txt"), "utf8")).toBe("second");
		} finally {
			await sandbox.dispose();
		}
	});

	it("keeps repository metadata read-only while ordinary workspace files remain writable", async () => {
		const workspace = temporaryDirectory();
		const protectedRoots = [".git", ".metis", ".codex", ".agents"].map((name) => join(workspace, name));
		for (const protectedRoot of protectedRoots) {
			mkdirSync(protectedRoot);
			writeFileSync(join(protectedRoot, "sentinel"), "original");
		}
		const sandbox = await createWorkspaceSandbox({
			cwd: workspace,
			workspaceRoots: [workspace],
			writeProtectedRoots: protectedRoots,
		});
		try {
			for (const protectedRoot of protectedRoots) {
				await expect(
					sandbox.operations.exec(
						`printf changed > ${JSON.stringify(join(protectedRoot, "sentinel"))}`,
						workspace,
						{
							onData: () => {},
						},
					),
				).resolves.not.toMatchObject({ exitCode: 0 });
				expect(readFileSync(join(protectedRoot, "sentinel"), "utf8")).toBe("original");
			}
			await expect(
				sandbox.operations.exec("printf ok > ordinary.txt", workspace, { onData: () => {} }),
			).resolves.toMatchObject({ exitCode: 0 });
		} finally {
			await sandbox.dispose();
		}
	});

	it.skipIf(process.platform === "win32")("carves out only global and exact-project memory as read-only", async () => {
		const base = temporaryDirectory();
		const cwd = join(base, "workspace");
		const memory = join(base, "agent", "memory");
		const global = join(memory, "global");
		const current = join(memory, "projects", "current");
		const sibling = join(memory, "projects", "sibling");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(global, { recursive: true });
		mkdirSync(current, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		const memoryPath = realpathSync(memory);
		const globalPath = realpathSync(global);
		const currentPath = realpathSync(current);
		const siblingPath = realpathSync(sibling);
		writeFileSync(join(globalPath, "global.md"), "global-marker");
		writeFileSync(join(currentPath, "current.md"), "current-marker");
		writeFileSync(join(siblingPath, "sibling.md"), "sibling-marker");
		writeFileSync(join(memoryPath, ".meta", "usage.json"), "database-marker");
		symlinkSync(siblingPath, join(currentPath, "sibling-alias"));
		symlinkSync(join(memoryPath, ".meta", "usage.json"), join(currentPath, "meta-alias"));
		const sandbox = await createWorkspaceSandbox({
			cwd,
			workspaceRoots: [cwd],
			readOnlyRoots: [globalPath, currentPath],
			protectedRoots: [memoryPath],
		});
		try {
			const output = async (command: string) => {
				const chunks: Buffer[] = [];
				const result = await sandbox.operations.exec(command, cwd, { onData: (data) => chunks.push(data) });
				return { ...result, text: Buffer.concat(chunks).toString() };
			};
			await expect(output(`cat ${JSON.stringify(join(globalPath, "global.md"))}`)).resolves.toMatchObject({
				exitCode: 0,
				text: expect.stringContaining("global-marker"),
			});
			await expect(output(`cat ${JSON.stringify(join(currentPath, "current.md"))}`)).resolves.toMatchObject({
				exitCode: 0,
				text: expect.stringContaining("current-marker"),
			});
			for (const denied of [
				join(siblingPath, "sibling.md"),
				join(memoryPath, ".meta", "usage.json"),
				join(currentPath, "sibling-alias", "sibling.md"),
				join(currentPath, "meta-alias"),
			]) {
				await expect(output(`cat ${JSON.stringify(denied)}`)).resolves.not.toMatchObject({ exitCode: 0 });
			}
			for (const denied of [join(globalPath, "new.md"), join(currentPath, "new.md")]) {
				await expect(output(`printf blocked > ${JSON.stringify(denied)}`)).resolves.not.toMatchObject({
					exitCode: 0,
				});
				expect(existsSync(denied)).toBe(false);
			}
		} finally {
			await sandbox.dispose();
		}
	});

	it("aborts a process tree and rejects overlapping commands", async () => {
		const cwd = temporaryDirectory();
		const sandbox = await createWorkspaceSandbox({ cwd, workspaceRoots: [cwd] });
		try {
			const controller = new AbortController();
			const running = sandbox.operations.exec("sleep 30", cwd, {
				onData: () => {},
				signal: controller.signal,
			});
			await expect(sandbox.operations.exec("pwd", cwd, { onData: () => {} })).rejects.toMatchObject({
				code: "SANDBOX_PROTOCOL",
			});
			controller.abort();
			await expect(running).rejects.toThrow("aborted");
			await expect(sandbox.operations.exec("pwd", cwd, { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		} finally {
			await sandbox.dispose();
		}
	});

	it("enforces command timeouts", async () => {
		const cwd = temporaryDirectory();
		const sandbox = await createWorkspaceSandbox({ cwd, workspaceRoots: [cwd] });
		try {
			await expect(sandbox.operations.exec("sleep 30", cwd, { onData: () => {}, timeout: 0.05 })).rejects.toThrow(
				"timeout:0.05",
			);
			await expect(sandbox.operations.exec("pwd", cwd, { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		} finally {
			await sandbox.dispose();
		}
	});

	it("isolates concurrent sandboxes in separate brokers", async () => {
		const firstCwd = temporaryDirectory();
		const secondCwd = temporaryDirectory();
		const [first, second] = await Promise.all([
			createWorkspaceSandbox({ cwd: firstCwd, workspaceRoots: [firstCwd] }),
			createWorkspaceSandbox({ cwd: secondCwd, workspaceRoots: [secondCwd] }),
		]);
		try {
			await expect(
				Promise.all([
					first.operations.exec("sleep 0.05; printf first", firstCwd, { onData: () => {} }),
					second.operations.exec("sleep 0.05; printf second", secondCwd, { onData: () => {} }),
				]),
			).resolves.toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});

	it("force-disposes the broker and private temporary directory", async () => {
		const cwd = temporaryDirectory();
		const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("metis-sandbox-")));
		const sandbox = await createWorkspaceSandbox({ cwd, workspaceRoots: [cwd] });
		const created = readdirSync(tmpdir()).filter((name) => name.startsWith("metis-sandbox-") && !before.has(name));
		expect(created).toHaveLength(1);
		sandbox.forceDispose();
		await expect(sandbox.operations.exec("pwd", cwd, { onData: () => {} })).rejects.toMatchObject({
			code: "SANDBOX_CLOSED",
		});
		expect(created.some((name) => existsSync(join(tmpdir(), name)))).toBe(false);
		await expect(sandbox.dispose()).resolves.toBeUndefined();
	});
});
