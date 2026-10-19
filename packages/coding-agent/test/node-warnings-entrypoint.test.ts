import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const rpcEntryPath = resolve(__dirname, "../src/rpc-entry.ts");
const bunCliPath = resolve(__dirname, "../src/bun/cli.ts");
const forwardedWarning = "entrypoint should forward this warning";
const sqliteWarning = "SQLite is an experimental feature and might change at any time";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "metis-node-warnings-"));
	tempDirs.push(dir);
	return dir;
}

function createWarningPreload(dir: string): string {
	const preloadPath = join(dir, "forward-warning.mjs");
	writeFileSync(
		preloadPath,
		[
			"const originalExit = process.exit.bind(process);",
			"process.exit = (code) => {",
			`\tprocess.emitWarning(${JSON.stringify(forwardedWarning)}, "CustomWarning");`,
			"\tprocess.nextTick(() => originalExit(code));",
			"};",
			"",
		].join("\n"),
		"utf-8",
	);
	return preloadPath;
}

async function runEntrypoint(
	entryPath: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", createWarningPreload(tempRoot), entryPath, ...args], {
			cwd: tempRoot,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				METIS_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("entrypoint warning passthrough", () => {
	it.each([
		["CLI", cliPath],
		["RPC entrypoint", rpcEntryPath],
		["Bun entrypoint", bunCliPath],
	])("forwards unrelated warnings from the %s while keeping SQLite startup noise quiet", async (_label, entryPath) => {
		const result = await runEntrypoint(entryPath, ["--version"]);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.stderr).toContain(forwardedWarning);
		expect(result.stderr).not.toContain(sqliteWarning);
	});
});
