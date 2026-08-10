import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceSandbox, WorkspaceSandboxError } from "../src/core/workspace-sandbox.ts";

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
		let sandbox: Awaited<ReturnType<typeof createWorkspaceSandbox>>;
		try {
			sandbox = await createWorkspaceSandbox({ cwd, workspaceRoots: [cwd] });
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

			await expect(
				sandbox.operations.exec("/usr/bin/curl --max-time 2 https://example.com", cwd, {
					onData: () => {},
					timeout: 5,
				}),
			).resolves.not.toEqual({ exitCode: 0 });
		} finally {
			await sandbox.dispose();
			await expect(sandbox.dispose()).resolves.toBeUndefined();
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
});
