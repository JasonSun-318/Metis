#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const defaultOutputDir = join(codingAgentDir, "dist", "vendor", "shell-analysis");

export const SHELL_ANALYSIS_PACKAGE = "@vscode/tree-sitter-wasm";
export const SHELL_ANALYSIS_VERSION = "0.3.1";
// These are the only runtime assets the application may load. The grammar wasm
// files are copied from the exact installed package, never from a workspace.
export const SHELL_ANALYSIS_FILES = [
	"wasm/tree-sitter.js",
	"wasm/tree-sitter.wasm",
	"wasm/tree-sitter-bash.wasm",
	"wasm/tree-sitter-python.wasm",
	"wasm/tree-sitter-javascript.wasm",
];
export const SHELL_ANALYSIS_NOTICES = ["LICENSE", "README.md", "SECURITY.md", "cgmanifest.json"];

const requireFromCodingAgent = createRequire(join(codingAgentDir, "package.json"));
export const installedPackageRoot = dirname(dirname(requireFromCodingAgent.resolve(SHELL_ANALYSIS_PACKAGE)));

function isInside(root, path) {
	return path === root || path.startsWith(`${root}${sep}`);
}

function requiredAsset(root, relativePath) {
	let entry;
	try {
		entry = lstatSync(join(root, relativePath));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			throw new Error(`required shell analysis asset is missing: ${relativePath}`);
		}
		throw error;
	}
	if (entry.isSymbolicLink()) {
		const target = realpathSync(join(root, relativePath));
		if (!isInside(root, target)) {
			throw new Error(`shell analysis symlink escape is not allowed: ${relativePath}`);
		}
		if (!statSync(target).isFile()) {
			throw new Error(`required shell analysis asset is not a file: ${relativePath}`);
		}
		return target;
	}
	if (!entry.isFile()) {
		throw new Error(`required shell analysis asset is not a file: ${relativePath}`);
	}
	return join(root, relativePath);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copy the pinned parser runtime and its notices out of the installed package.
 * The destination is replaced atomically after every source file has been
 * validated, so an interrupted build never leaves a partial trusted runtime.
 */
export function stageShellAnalysis({ packageRoot = installedPackageRoot, outputDir = defaultOutputDir } = {}) {
	const sourceRoot = realpathSync(resolve(packageRoot));
	const sourcePackage = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
	if (sourcePackage.name !== SHELL_ANALYSIS_PACKAGE || sourcePackage.version !== SHELL_ANALYSIS_VERSION) {
		throw new Error(
			`unexpected shell analysis package version: ${sourcePackage.name}@${sourcePackage.version}; ` +
				`expected ${SHELL_ANALYSIS_PACKAGE}@${SHELL_ANALYSIS_VERSION}`,
		);
	}
	const codingAgentPackage = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	if (codingAgentPackage.dependencies?.[SHELL_ANALYSIS_PACKAGE] !== SHELL_ANALYSIS_VERSION) {
		throw new Error(
			`@metis/coding-agent must depend on exactly ${SHELL_ANALYSIS_PACKAGE}@${SHELL_ANALYSIS_VERSION}`,
		);
	}

	const destination = resolve(outputDir);
	const staged = `${destination}.tmp-${process.pid}`;
	rmSync(staged, { recursive: true, force: true });
	try {
		mkdirSync(staged, { recursive: true });
		const files = [];
		for (const relativePath of SHELL_ANALYSIS_FILES) {
			const name = basename(relativePath);
			const output = join(staged, name);
			copyFileSync(requiredAsset(sourceRoot, relativePath), output);
			const bytes = readFileSync(output);
			files.push({ name, sha256: sha256(bytes), bytes: bytes.byteLength });
		}
		for (const notice of SHELL_ANALYSIS_NOTICES) {
			copyFileSync(requiredAsset(sourceRoot, notice), join(staged, notice));
		}
		// The copied UMD runtime must stay CommonJS even though the owning
		// coding-agent package is ESM.
		writeFileSync(join(staged, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, "\t")}\n`);
		writeFileSync(
			join(staged, "manifest.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					package: SHELL_ANALYSIS_PACKAGE,
					version: SHELL_ANALYSIS_VERSION,
					files,
					notices: SHELL_ANALYSIS_NOTICES,
				},
				null,
				2,
			)}\n`,
		);
		rmSync(destination, { recursive: true, force: true });
		renameSync(staged, destination);
		return { outputDir: destination, version: SHELL_ANALYSIS_VERSION, files: files.map((file) => file.name) };
	} catch (error) {
		rmSync(staged, { recursive: true, force: true });
		throw error;
	}
}

function main() {
	const outputIndex = process.argv.indexOf("--output");
	const outputDir = outputIndex === -1 ? defaultOutputDir : resolve(process.argv[outputIndex + 1] ?? "");
	const result = stageShellAnalysis({ outputDir });
	console.log(`Staged ${result.version} shell analysis assets in ${result.outputDir}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main();
}
