import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agent = join(root, "packages/coding-agent");
const enabled = process.env.METIS_TEST_PARSER_ARTIFACTS === "1";

function probeSource(modulePath) {
	return `import {initializeShellAnalysis,getShellParserStatus,parseShellSyntax,parseInlineScriptSyntax} from ${JSON.stringify(modulePath)};
await initializeShellAnalysis();
const results=[];
for(const [language,source] of [["bash","printf '权限\\\\n' | head -1 && pwd"],["python","x = {'ok': True}"],["javascript","const x = {ok:true};"]]) {
 const parsed=language==="bash"?parseShellSyntax(source,"/bin/bash"):parseInlineScriptSyntax(source,language);
 results.push({language,complete:parsed.complete,exactSource:parsed.root?.text===source});
 parsed.dispose();
}
console.log(JSON.stringify({status:getShellParserStatus(),results,platform:process.platform,arch:process.arch}));`;
}

function assertReady(output) {
	const value = JSON.parse(output);
	assert.equal(value.status.ready, true);
	assert.equal(value.results.length, 3);
	assert.ok(value.results.every((result) => result.complete && result.exactSource));
}

test(
	"built Node runtime loads all trusted grammars independently of package environment overrides",
	{
		skip: !enabled,
	},
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "metis-node-parser-artifact-"));
		try {
			const output = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					probeSource(pathToFileURL(join(agent, "dist/core/permissions/shell-parser.js")).href),
				],
				{
					cwd: root,
					encoding: "utf8",
					timeout: 15_000,
					env: { ...process.env, METIS_PACKAGE_DIR: join(temporary, "untrusted-package") },
				},
			);
			assertReady(output);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test(
	"compiled Bun runtime loads adjacent assets and fails closed when those assets are absent",
	{
		skip: !enabled,
	},
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "metis-bun-parser-artifact-"));
		try {
			const entry = join(temporary, "entry.ts");
			const binary = join(temporary, process.platform === "win32" ? "parser-probe.exe" : "parser-probe");
			writeFileSync(entry, probeSource(join(agent, "src/core/permissions/shell-parser.ts")));
			execFileSync(process.env.METIS_TEST_BUN_BINARY || "bun", ["build", "--compile", entry, "--outfile", binary], {
				cwd: root,
				encoding: "utf8",
				timeout: 60_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			cpSync(join(agent, "dist/vendor/shell-analysis"), join(temporary, "vendor/shell-analysis"), {
				recursive: true,
			});
			const options = {
				encoding: "utf8",
				timeout: 15_000,
				env: { ...process.env, METIS_PACKAGE_DIR: join(temporary, "untrusted-package") },
			};
			assertReady(execFileSync(binary, [], options));
			renameSync(join(temporary, "vendor"), join(temporary, "missing-vendor"));
			const missing = JSON.parse(execFileSync(binary, [], options));
			assert.equal(missing.status.ready, false);
			assert.ok(missing.results.every((result) => !result.complete));
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);
