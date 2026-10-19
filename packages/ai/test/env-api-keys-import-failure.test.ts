import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envApiKeysUrl = new URL("../src/env-api-keys.ts", import.meta.url).href;

interface EnvProbeResult {
	unhandled: string[];
	key?: string | null;
	found?: string[] | null;
	vertex?: string | null;
}

function runProbe(source: string): EnvProbeResult {
	const script = `
		const envUrl = ${JSON.stringify(envApiKeysUrl)};
		${source}
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: packageRoot,
		encoding: "utf8",
		env: { ...process.env, ANTHROPIC_API_KEY: "test-env-key" },
	});

	if (result.status !== 0) {
		throw new Error(`Env probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const lastLine = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
	if (!lastLine) {
		throw new Error(`Env probe produced no output\nSTDERR:\n${result.stderr}`);
	}
	return JSON.parse(lastLine) as EnvProbeResult;
}

describe("optional Node builtin imports in env-api-keys", () => {
	it("isolates rejected fs/os/path loads without unhandled rejections", () => {
		const result = runProbe(`
			import { registerHooks } from "node:module";
			const blocked = new Set(["node:fs", "node:os", "node:path"]);
			registerHooks({
				resolve(specifier, context, nextResolve) {
					if (blocked.has(specifier)) {
						throw new Error(\`blocked optional builtin: \${specifier}\`);
					}
					return nextResolve(specifier, context);
				},
			});
			const unhandled = [];
			process.on("unhandledRejection", (reason) => {
				unhandled.push(reason instanceof Error ? reason.message : String(reason));
			});
			const mod = await import(envUrl);
			await new Promise((resolve) => setTimeout(resolve, 50));
			console.log(JSON.stringify({
				unhandled,
				key: mod.getEnvApiKey("anthropic") ?? null,
				found: mod.findEnvKeys("anthropic") ?? null,
				vertex: mod.getEnvApiKey("google-vertex") ?? null,
			}));
		`);

		expect(result.unhandled).toEqual([]);
		expect(result.key).toBe("test-env-key");
		expect(result.found).toEqual(["ANTHROPIC_API_KEY"]);
		expect(result.vertex).toBeNull();
	});

	it("keeps browser-like runtimes without a process global importable", () => {
		const result = runProbe(`
			const proc = globalThis.process;
			const unhandled = [];
			proc.on("unhandledRejection", (reason) => {
				unhandled.push(reason instanceof Error ? reason.message : String(reason));
			});
			delete globalThis.process;
			const mod = await import(envUrl);
			await new Promise((resolve) => setTimeout(resolve, 50));
			console.log(JSON.stringify({
				unhandled,
				key: mod.getEnvApiKey("anthropic", { ANTHROPIC_API_KEY: "scoped-key" }) ?? null,
				found: mod.findEnvKeys("anthropic", { ANTHROPIC_API_KEY: "scoped-key" }) ?? null,
				vertex: mod.getEnvApiKey("google-vertex", {}) ?? null,
			}));
		`);

		expect(result.unhandled).toEqual([]);
		expect(result.key).toBe("scoped-key");
		expect(result.found).toEqual(["ANTHROPIC_API_KEY"]);
		expect(result.vertex).toBeNull();
	});
});
