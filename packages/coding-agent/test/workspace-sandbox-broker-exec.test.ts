import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	initialize: vi.fn(async () => {}),
	wrapWithSandboxArgv: vi.fn(),
	reset: vi.fn(async () => {}),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
	getDefaultWritePaths: () => [],
	SandboxManager: {
		initialize: mocks.initialize,
		wrapWithSandboxArgv: mocks.wrapWithSandboxArgv,
		reset: mocks.reset,
	},
}));

vi.mock("../src/core/workspace-sandbox-health.ts", () => ({
	bundledSandboxHelperPath: (kind: "seccomp" | "srt-win") => `/mocked/sandbox-helper/${kind}`,
}));

import { runWorkspaceSandboxBroker } from "../src/core/workspace-sandbox-broker.ts";

describe("workspace sandbox broker exec failures", () => {
	const roots: string[] = [];
	const previousTemp = process.env.METIS_SANDBOX_TEMP_DIR;
	const previousClaudeTemp = process.env.CLAUDE_CODE_TMPDIR;

	afterEach(() => {
		if (previousTemp === undefined) delete process.env.METIS_SANDBOX_TEMP_DIR;
		else process.env.METIS_SANDBOX_TEMP_DIR = previousTemp;
		if (previousClaudeTemp === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
		else process.env.CLAUDE_CODE_TMPDIR = previousClaudeTemp;
		mocks.initialize.mockReset();
		mocks.wrapWithSandboxArgv.mockReset();
		mocks.reset.mockReset();
		mocks.initialize.mockResolvedValue(undefined);
		mocks.reset.mockResolvedValue(undefined);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	async function withBroker(
		run: (
			workspace: string,
			send: (value: unknown) => void,
			take: () => Promise<Record<string, unknown>>,
		) => Promise<void>,
	): Promise<void> {
		const workspace = realpathSync(mkdtempSync(join(tmpdir(), "metis-broker-exec-")));
		roots.push(workspace);
		const temp = join(workspace, "sandbox-tmp");
		mkdirSync(temp);
		process.env.METIS_SANDBOX_TEMP_DIR = temp;

		const input = new PassThrough();
		const output = new PassThrough();
		const pending: string[] = [];
		let buffer = "";
		let waiter: ((line: string) => void) | undefined;
		output.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (waiter) {
					const resolve = waiter;
					waiter = undefined;
					resolve(line);
				} else pending.push(line);
				newline = buffer.indexOf("\n");
			}
		});
		const take = () => {
			const existing = pending.shift();
			if (existing !== undefined) return Promise.resolve(JSON.parse(existing) as Record<string, unknown>);
			return new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiter = undefined;
					reject(new Error(`timed out waiting for broker output: ${JSON.stringify(buffer)}`));
				}, 5_000);
				waiter = (line) => {
					clearTimeout(timer);
					resolve(JSON.parse(line) as Record<string, unknown>);
				};
			});
		};
		const send = (value: unknown) => {
			input.write(`${JSON.stringify(value)}\n`);
		};
		const broker = runWorkspaceSandboxBroker({ input, output });
		try {
			await run(workspace, send, take);
		} finally {
			input.end();
			await broker;
		}
	}

	function init(root: string) {
		return {
			type: "init",
			cwd: root,
			workspaceRoots: [root],
			readOnlyRoots: [],
			writeRoots: [],
			protectedRoots: [],
			writeProtectedRoots: [],
			networkEndpoints: [],
		};
	}

	it("includes the exec failure reason without closing the broker", async () => {
		const reason = `${"x".repeat(600)}\nsecret second line`;
		mocks.wrapWithSandboxArgv.mockRejectedValueOnce(new Error(reason));
		mocks.wrapWithSandboxArgv.mockRejectedValueOnce("bubblewrap unavailable\nnext");

		await withBroker(async (workspace, send, take) => {
			send(init(workspace));
			await expect(take()).resolves.toEqual({ type: "ready" });

			send({ type: "exec", id: "cmd-1", command: "printf hi", cwd: workspace, env: {} });
			const first = await take();
			expect(first).toMatchObject({ type: "error", id: "cmd-1", code: "SANDBOX_CLOSED" });
			expect(first.message).toBe(`Sandbox command failed: ${"x".repeat(512 - "Sandbox command failed: ".length)}`);
			expect(String(first.message)).not.toContain("secret");
			expect(String(first.message).length).toBeLessThanOrEqual(512);

			send({ type: "exec", id: "cmd-2", command: "printf hi", cwd: workspace, env: {} });
			await expect(take()).resolves.toEqual({
				type: "error",
				id: "cmd-2",
				code: "SANDBOX_CLOSED",
				message: "Sandbox command failed: bubblewrap unavailable",
			});

			send({ type: "close" });
			await expect(take()).resolves.toEqual({ type: "closed" });
		});
		expect(mocks.reset).toHaveBeenCalledOnce();
	});

	it("still closes the broker on a protocol error that has no command id", async () => {
		await withBroker(async (_workspace, send, take) => {
			send("not-json");
			await expect(take()).resolves.toEqual({
				type: "error",
				code: "SANDBOX_PROTOCOL",
				message: "Invalid sandbox protocol message",
			});
		});
		expect(mocks.reset).toHaveBeenCalledOnce();
		expect(mocks.initialize).not.toHaveBeenCalled();
	});
});
