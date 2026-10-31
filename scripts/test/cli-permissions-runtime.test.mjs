import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.env.METIS_TEST_CLI_BINARY;

function run(executable, args, env, cwd) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(executable, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("CLI artifact timed out"));
		}, 30_000);
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolveRun({ code, output });
		});
	});
}

test(
	"actual Node and compiled CLI enforce parser availability while Full remains usable",
	{ skip: !binary, timeout: 120_000 },
	async () => {
		const temporary = await mkdtemp(join(tmpdir(), "metis-cli-permission-artifact-"));
		const agentDir = join(temporary, "agent");
		const home = join(temporary, "home");
		const project = join(temporary, "project");
		await Promise.all([mkdir(agentDir), mkdir(home), mkdir(project)]);
		let toolResults = [];
		let reviewCalls = 0;
		const server = createServer(async (request, response) => {
			let source = "";
			for await (const chunk of request) source += chunk;
			const body = JSON.parse(source);
			if (JSON.stringify(body.tools).includes("submit_permission_review")) reviewCalls++;
			const result = body.messages?.findLast((message) => message.role === "tool");
			if (result) toolResults.push(JSON.stringify(result.content));
			const delta = result
				? { role: "assistant", content: "artifact-done" }
				: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "artifact-call",
								type: "function",
								function: {
									name: "bash",
									arguments: JSON.stringify({ command: "printf '%s\\n' 'artifact-ok' && pwd" }),
								},
							},
						],
					};
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({ id: "artifact-response", object: "chat.completion.chunk", created: 1, model: "artifact-model", choices: [{ index: 0, delta, finish_reason: result ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address();
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					artifact: {
						api: "openai-completions",
						apiKey: "artifact-fixture-key",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						models: [{ id: "artifact-model", name: "Artifact model", contextWindow: 32000, maxTokens: 1024 }],
					},
				},
			}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "artifact",
				defaultModel: "artifact-model",
				autoReviewerEnabled: false,
				retry: { enabled: false },
			}),
		);
		const environment = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			METIS_CODING_AGENT_DIR: agentDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			ALL_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
		};
		const flags = [
			"--offline",
			"--approve",
			"--mode",
			"json",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--tools",
			"bash",
		];
		const copyBinary = join(temporary, "metis");
		try {
			await cp(binary, copyBinary);
			await cp(join(dirname(binary), "package.json"), join(temporary, "package.json"));
			await cp(join(dirname(binary), "vendor"), join(temporary, "vendor"), { recursive: true });
			for (const [executable, prefix] of [
				[process.execPath, [join(root, "packages/coding-agent/dist/cli.js")]],
				[copyBinary, []],
			]) {
				toolResults = [];
				const result = await run(
					executable,
					[...prefix, ...flags, "--permission-preset", "auto", "--print", "artifact-check"],
					environment,
					project,
				);
				assert.equal(result.code, 0, result.output.slice(-1800));
				assert.ok(
					toolResults.some((value) => value.includes("artifact-ok") && value.includes("project")),
					result.output.slice(-1800),
				);
			}
			await rename(join(temporary, "vendor/shell-analysis"), join(temporary, "missing-shell-analysis"));
			toolResults = [];
			const missing = await run(
				copyBinary,
				[...flags, "--permission-preset", "auto", "--print", "artifact-check"],
				environment,
				project,
			);
			assert.equal(missing.code, 0, missing.output.slice(-1800));
			assert.ok(
				toolResults.length > 0 && toolResults.every((value) => !value.includes("artifact-ok")),
				"Auto executed without trusted parser assets",
			);
			toolResults = [];
			const full = await run(
				copyBinary,
				[...flags, "--permission-preset", "full", "--print", "artifact-check"],
				environment,
				project,
			);
			assert.equal(full.code, 0, full.output.slice(-1800));
			assert.ok(
				toolResults.some((value) => value.includes("artifact-ok")),
				full.output.slice(-1800),
			);
			assert.equal(reviewCalls, 0);
		} finally {
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
			await rm(temporary, { recursive: true, force: true });
		}
	},
);
