#!/usr/bin/env node
/**
 * Native Windows acceptance probes (W19).
 *
 * These probes exercise the real product modules that behave differently on
 * Windows: path canonicalization, durable file replace/fsync, the session
 * journal's rename-based atomic replacement, the native shell-analysis addon,
 * external-editor command parsing and child-process exit propagation.
 *
 * Run on a native Windows host with `npm run verify:windows`. Mocked,
 * cross-platform or macOS/Linux results do not substitute for this run; the
 * script refuses to run elsewhere so a passing run always means native results.
 *
 * Environment notes are captured in the report (OS build, Node version, arch)
 * so an acceptance record can distinguish simulated from native evidence.
 */

import childProcess, { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Windows absolute paths (D:\...) are not valid ESM specifiers; always import
// through file URLs so the probes load identically on every platform.
function sourceModule(relativePath) {
	return import(pathToFileURL(join(repoRoot, relativePath)).href);
}

if (process.platform !== "win32") {
	console.error(
		`verify:windows must run on native Windows (current platform: ${process.platform}); ` +
			"cross-platform or mocked runs are not acceptance evidence.",
	);
	process.exit(2);
}

const PROBE_DIR_NAME = "metis windows acceptance 检查"; // spaces + non-ASCII by design
const results = [];

async function probe(name, run) {
	const startedAt = Date.now();
	try {
		const detail = await run();
		results.push({ name, status: "pass", ms: Date.now() - startedAt, detail });
	} catch (error) {
		results.push({
			name,
			status: "fail",
			ms: Date.now() - startedAt,
			detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function withTempDir(run) {
	const root = mkdtempSync(join(tmpdir(), "metis-win-accept-"));
	const dir = join(root, PROBE_DIR_NAME);
	try {
		return await run(dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const paths = await sourceModule("packages/coding-agent/src/utils/paths.ts");
const durable = await sourceModule("packages/coding-agent/src/core/durable-file.ts");
const journal = await sourceModule("packages/coding-agent/src/core/session-journal.ts");
const shellParser = await sourceModule("packages/coding-agent/src/core/permissions/shell-parser.ts");
const promptTemplates = await sourceModule("packages/coding-agent/src/core/prompt-templates.ts");

await probe("paths: spaces and non-ASCII survive canonicalization", () =>
	withTempDir((dir) => {
		const input = join(dir, "nested folder", "文件.txt");
		const resolved = paths.resolvePath(input, dir, { homeDir: process.env.USERPROFILE ?? dir, trim: true });
		assert(resolved.toLowerCase().includes("文件.txt"), `resolvePath lost the file name: ${resolved}`);
		const canonical = paths.canonicalizeActionPath(input);
		assert(typeof canonical === "string" && canonical.length > 0, "canonicalizeActionPath returned nothing");
		return { resolved, canonical };
	}),
);

await probe("durable-file: create, fsync and read back under a spaced non-ASCII path", () =>
	withTempDir((dir) => {
		durable.ensureDirectoryDurablySync(dir);
		const file = join(dir, "记录 文件.txt");
		durable.writeFileDurablySync(file, "content with 中文 and spaces", { mode: 0o600 });
		const text = durable.readSingleLinkTextFileSync(file, { maxBytes: 4096 });
		assert(text === "content with 中文 and spaces", `unexpected read back: ${JSON.stringify(text)}`);
		return { file };
	}),
);

await probe("session-journal: append, strict read and atomic replace", () =>
	withTempDir((dir) => {
		const file = join(dir, "journal 会话.jsonl");
		const handle = journal.openSessionJournal(file, { create: true });
		try {
			handle.append({ id: 1, text: "first" });
			handle.append({ id: 2, text: "second" });
			const strict = handle.readStrict();
			assert(strict.records.length === 2, `expected 2 records, got ${strict.records.length}`);
			handle.replaceAtomically([{ id: 3, text: "replaced" }]);
			const replaced = handle.readStrict();
			assert(replaced.records.length === 1, `expected 1 record after replace, got ${replaced.records.length}`);
			return { recovery: strict.recovery, replaced: replaced.records.length };
		} finally {
			handle.close();
		}
	}),
);

await probe("shell-analysis: native addon loads and parses a trusted command", async () => {
	await shellParser.initializeShellAnalysis();
	const status = shellParser.getShellParserStatus();
	assert(
		status.ready === true,
		`shell analysis unavailable: ${status.reason ?? "unknown reason"}; ` +
			"run `npm run build` first so the grammar assets are staged in dist/vendor",
	);
	// The product analyses commands with the Bash grammar regardless of host, so
	// this probe validates the native addon rather than cmd.exe syntax.
	const parsed = shellParser.parseShellSyntax("echo hello", "bash");
	try {
		assert(parsed.complete === true, `parse rejected a simple command: ${parsed.reason ?? "no reason"}`);
		assert(parsed.root !== null, "parse returned no syntax root");
	} finally {
		parsed.dispose();
	}
	return status;
});

await probe("external-editor: quoted command with spaces parses into argv", () => {
	const command = '"C:\\Program Files\\Editor\\edit.exe" --wait --new-window';
	const argv = promptTemplates.parseCommandArgs(command);
	assert(argv.length === 3, `expected 3 argv entries, got ${argv.length}: ${JSON.stringify(argv)}`);
	assert(argv[0] === "C:\\Program Files\\Editor\\edit.exe", `unexpected editor path: ${argv[0]}`);
	assert(argv[1] === "--wait", `unexpected first flag: ${argv[1]}`);
	return { argv };
});

await probe(
	"child-process: aborting a running child settles with a non-zero status",
	() =>
		new Promise((resolve, reject) => {
			// Mirrors Esc-cancelling a running bash tool: the child must terminate
			// and the close handler must observe a failure status rather than hang.
			const child = childProcess.spawn("cmd.exe", ["/d", "/s", "/c", "ping -n 30 127.0.0.1"], {
				stdio: "ignore",
				windowsHide: true,
			});
			const timer = setTimeout(() => {
				child.kill();
			}, 250);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				if (code === 0) reject(new Error("aborted child reported a clean exit"));
				else resolve({ code, signal });
			});
		}),
);

await probe(
	"child-process: exit code propagates through a spawned shell",
	() =>
		new Promise((resolve, reject) => {
			// This is the Windows-specific child-process path: the command goes
			// through cmd.exe, so quoting and exit-code propagation are real.
			const child = childProcess.spawn("cmd.exe", ["/d", "/s", "/c", "exit 3"], {
				stdio: "ignore",
				windowsHide: true,
			});
			child.once("error", reject);
			child.once("close", (code) => {
				if (code === 3) resolve({ exitCode: code });
				else reject(new Error(`expected exit code 3, got ${String(code)}`));
			});
		}),
);

function readWindowsBuild() {
	try {
		return spawnSync("cmd.exe", ["/d", "/s", "/c", "ver"], { encoding: "utf8" }).stdout?.trim() ?? "unknown";
	} catch {
		return "unknown";
	}
}

const failed = results.filter((entry) => entry.status === "fail");
const report = {
	generatedAt: new Date().toISOString(),
	platform: process.platform,
	release: process.release.name,
	arch: process.arch,
	node: process.version,
	osBuild: readWindowsBuild(),
	passed: results.length - failed.length,
	failed: failed.length,
	results,
};
console.log(JSON.stringify(report, null, 2));
console.log(
	`\nWindows native acceptance: ${report.passed}/${results.length} probes passed` +
		(report.failed === 0 ? " (record this output as native evidence)" : " (failures must be fixed or recorded)"),
);
process.exit(failed.length === 0 ? 0 : 1);
