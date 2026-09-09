import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "../packages/coding-agent/dist/core/tools/bash.js";
import { getShellEnv } from "../packages/coding-agent/dist/utils/shell.js";
import { createWorkspaceSandbox } from "../packages/coding-agent/dist/core/workspace-sandbox.js";

export async function checkSkillRuntime({ packageDir, sandbox: useSandbox = false } = {}) {
	const originalPackage = process.env.METIS_PACKAGE_DIR;
	const originalPath = process.env.PATH;
	const directory = mkdtempSync(join(tmpdir(), "metis skill runtime "));
	let sandbox;
	try {
		if (packageDir) process.env.METIS_PACKAGE_DIR = packageDir;
		// Simulate launching the app without Homebrew, uv, conda or a user-installed OfficeCLI.
		if (process.platform !== "win32") process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
		const env = { ...getShellEnv(), METIS_WORK_DIR: directory, METIS_ATTACHMENTS_DIR: directory };
		if (useSandbox) sandbox = await createWorkspaceSandbox({ cwd: directory, workspaceRoots: [directory], writeRoots: [directory] });
		const operations = sandbox?.operations ?? createLocalBashOperations();
		let output = "";
		const { exitCode } = await operations.exec(
			[
				'test "$OFFICECLI_SKIP_UPDATE" = 1 && test "$OFFICECLI_NO_AUTO_INSTALL" = 1 && test "$OFFICECLI_NO_AUTO_RESIDENT" = 1',
				"officecli --version",
				"officecli create source.docx",
				"officecli add source.docx /body --type paragraph --prop text=MetisOfficeRuntime",
				"officecli view source.docx text",
			].join(" && "),
			directory,
			{
				env,
				timeout: 60,
				onData: (data) => {
					output += data.toString();
				},
			},
		);
		assert.equal(exitCode, 0, output);
		assert(output.includes("MetisOfficeRuntime"), output);
		console.log(
			`PASS skill runtime (${useSandbox ? "OS sandbox" : "local shell"}): OfficeCLI create/read`,
		);
	} finally {
		await sandbox?.dispose();
		if (originalPackage === undefined) delete process.env.METIS_PACKAGE_DIR;
		else process.env.METIS_PACKAGE_DIR = originalPackage;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await checkSkillRuntime({ sandbox: process.argv.includes("--sandbox") });
