import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "metis-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("drops a response that arrives after its request timed out", async () => {
		const client = new RpcClient({
			requestTimeoutMs: 10,
			cliPath: writeChildScript(`
let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk;
	const newline = input.indexOf("\\n");
	if (newline === -1) return;
	const command = JSON.parse(input.slice(0, newline));
	setTimeout(() => {
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: [] }) + "\\n");
	}, 40);
});
`),
		});
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));

		await client.start();
		try {
			await expect(client.getCommands()).rejects.toThrow(/Timeout waiting for response to get_commands/);
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(events).toEqual([]);
		} finally {
			await client.stop();
		}
	});

	test("uses the configurable long-running timeout for bash", async () => {
		const client = new RpcClient({
			requestTimeoutMs: 10,
			longRunningRequestTimeoutMs: 100,
			cliPath: writeChildScript(`
let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk;
	const newline = input.indexOf("\\n");
	if (newline === -1) return;
	const command = JSON.parse(input.slice(0, newline));
	setTimeout(() => {
		process.stdout.write(JSON.stringify({
			type: "response",
			id: command.id,
			success: true,
			data: { output: "done", exitCode: 0, cancelled: false, truncated: false }
		}) + "\\n");
	}, 40);
});
`),
		});

		await client.start();
		try {
			await expect(client.bash("sleep 1")).resolves.toMatchObject({ output: "done", exitCode: 0 });
		} finally {
			await client.stop();
		}
	});
});
