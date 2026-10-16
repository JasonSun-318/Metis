import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../../test.sh", import.meta.url));

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "metis-test-launcher-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const agentDir = join(home, ".metis", "agent");
	const bin = join(root, "bin");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(agentDir, "auth.json"), "existing auth");
	writeFileSync(join(agentDir, "auth.json.bak"), "existing backup");
	const npm = join(bin, "npm");
	writeFileSync(
		npm,
		`#!/usr/bin/env node
const fs = require("node:fs");
const env = process.env;
console.log("METIS_TEST_ENV=" + JSON.stringify({
  agentDir: env.METIS_CODING_AGENT_DIR,
  sessionDir: env.METIS_CODING_AGENT_SESSION_DIR,
  exists: fs.existsSync(env.METIS_CODING_AGENT_DIR || ""),
  localLlm: env.METIS_NO_LOCAL_LLM,
  keys: ["OPENAI_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "BASETEN_API_KEY"].filter(key => env[key])
}));
process.exit(Number(env.METIS_TEST_EXIT_CODE || 0));
`,
	);
	chmodSync(npm, 0o755);
	return { root, home, agentDir, bin };
}

function run(fixture, exitCode = 0) {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", [launcher], {
			env: {
				...process.env,
				HOME: fixture.home,
				PATH: `${fixture.bin}${delimiter}${process.env.PATH}`,
				TMPDIR: fixture.root,
				METIS_CODING_AGENT_DIR: fixture.agentDir,
				METIS_CODING_AGENT_SESSION_DIR: join(fixture.root, "user-sessions"),
				METIS_TEST_EXIT_CODE: String(exitCode),
				OPENAI_API_KEY: "test-key",
				QWEN_TOKEN_PLAN_API_KEY: "test-key",
				QWEN_TOKEN_PLAN_CN_API_KEY: "test-key",
				BASETEN_API_KEY: "test-key",
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data;
		});
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const line = stdout.split("\n").find((line) => line.startsWith("METIS_TEST_ENV="));
			if (!line) return reject(new Error(`Launcher did not run npm: ${stderr}`));
			resolve({ code, env: JSON.parse(line.slice("METIS_TEST_ENV=".length)) });
		});
	});
}

for (const exitCode of [0, 17]) {
	test(
		`offline launcher isolates configuration and preserves auth on exit ${exitCode}`,
		{ skip: process.platform === "win32" },
		async (t) => {
			const workspace = fixture(t);
			const result = await run(workspace, exitCode);
			assert.equal(result.code, exitCode);
			assert.equal(readFileSync(join(workspace.agentDir, "auth.json"), "utf8"), "existing auth");
			assert.equal(readFileSync(join(workspace.agentDir, "auth.json.bak"), "utf8"), "existing backup");
			assert.notEqual(result.env.agentDir, workspace.agentDir);
			assert.equal(result.env.exists, true);
			assert.equal(existsSync(result.env.agentDir), false);
			assert.equal(result.env.sessionDir, undefined);
			assert.equal(result.env.localLlm, "1");
			assert.deepEqual(result.env.keys, []);
		},
	);
}

test(
	"concurrent offline launchers use separate temporary directories",
	{ skip: process.platform === "win32" },
	async (t) => {
		const workspace = fixture(t);
		const [first, second] = await Promise.all([run(workspace), run(workspace)]);
		assert.equal(first.code, 0);
		assert.equal(second.code, 0);
		assert.notEqual(first.env.agentDir, second.env.agentDir);
		assert.equal(existsSync(first.env.agentDir), false);
		assert.equal(existsSync(second.env.agentDir), false);
	},
);
