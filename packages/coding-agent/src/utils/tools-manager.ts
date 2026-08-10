import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getPackageDir, isBunBinary } from "../config.ts";

export type NativeToolName = "fd" | "rg";

const TOOL_NAMES: Record<NativeToolName, { display: string; binary: string; systemNames: string[] }> = {
	fd: { display: "fd", binary: "fd", systemNames: ["fd", "fdfind"] },
	rg: { display: "ripgrep", binary: "rg", systemNames: ["rg"] },
};

interface BundledToolManifest {
	schemaVersion: 1;
	pair: string;
	tools: Record<NativeToolName, { binary: string; binarySha256: string; version: string }>;
}

export interface BundledToolLookupOptions {
	packageDir?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	requireBundle?: boolean;
}

function commandExists(command: string): boolean {
	try {
		return spawnSync(command, ["--version"], { stdio: "pipe" }).error == null;
	} catch {
		return false;
	}
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function incompleteInstallation(message: string): Error {
	return new Error(
		`Incomplete Metis installation: ${message}. Reinstall Metis; no runtime download will be attempted.`,
	);
}

function bundledRoots(packageDir: string): string[] {
	return [join(packageDir, "vendor", "tools"), join(packageDir, "dist", "vendor", "tools")];
}

function isCompiledRuntime(): boolean {
	return isBunBinary || /\/dist\//.test(import.meta.url);
}

export function getBundledToolPath(tool: NativeToolName, options: BundledToolLookupOptions = {}): string | null {
	const runtimePlatform = options.platform ?? platform();
	const runtimeArch = options.arch ?? arch();
	if (runtimePlatform !== "darwin" && runtimePlatform !== "win32") return null;
	if (runtimeArch !== "arm64" && runtimeArch !== "x64") return null;

	const packageDir = options.packageDir ?? getPackageDir();
	const roots = bundledRoots(packageDir);
	const pair = `${runtimePlatform}-${runtimeArch}`;
	const pairDirectory = roots.map((root) => join(root, pair)).find(existsSync);
	const requireBundle = options.requireBundle ?? (isCompiledRuntime() || roots.some(existsSync));
	if (!pairDirectory) {
		if (requireBundle) throw incompleteInstallation(`bundled native tools are missing for ${pair}`);
		return null;
	}

	const manifestPath = join(pairDirectory, "manifest.json");
	let manifest: BundledToolManifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundledToolManifest;
	} catch {
		throw incompleteInstallation(`the native-tool manifest is missing or invalid for ${pair}`);
	}
	if (manifest.schemaVersion !== 1 || manifest.pair !== pair) {
		throw incompleteInstallation(`the native-tool manifest does not match ${pair}`);
	}
	const entry = manifest.tools?.[tool];
	const expectedBinary = `${TOOL_NAMES[tool].binary}${runtimePlatform === "win32" ? ".exe" : ""}`;
	if (!entry || entry.binary !== expectedBinary || !/^[a-f0-9]{64}$/.test(entry.binarySha256)) {
		throw incompleteInstallation(`the ${tool} manifest entry is invalid for ${pair}`);
	}

	const binaryPath = join(pairDirectory, expectedBinary);
	try {
		const metadata = lstatSync(binaryPath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("not a regular file");
		}
		if (runtimePlatform !== "win32") accessSync(binaryPath, constants.X_OK);
	} catch {
		throw incompleteInstallation(`bundled ${tool} is missing or not executable for ${pair}`);
	}
	if (sha256(binaryPath) !== entry.binarySha256) {
		throw incompleteInstallation(`bundled ${tool} failed its integrity check for ${pair}`);
	}
	return binaryPath;
}

/** Resolve a verified bundled tool, or a user-installed PATH dependency on unsupported/development platforms. */
export function getToolPath(tool: NativeToolName): string | null {
	const bundled = getBundledToolPath(tool);
	if (bundled) return bundled;
	for (const command of TOOL_NAMES[tool].systemNames) {
		if (commandExists(command)) return command;
	}
	return null;
}

/** Resolve a native search helper without downloading or modifying the host. */
export async function ensureTool(tool: NativeToolName, silent = false): Promise<string | undefined> {
	const existing = getToolPath(tool);
	if (existing) return existing;

	if (!silent) {
		if (platform() === "android") {
			console.log(
				chalk.yellow(
					`${TOOL_NAMES[tool].display} not found. Install with: pkg install ${tool === "rg" ? "ripgrep" : "fd"}`,
				),
			);
		} else if (platform() === "linux") {
			console.log(
				chalk.yellow(`${TOOL_NAMES[tool].display} not found in PATH. Install it with your system package manager.`),
			);
		} else {
			console.log(chalk.yellow(`${TOOL_NAMES[tool].display} not found in this development environment.`));
		}
	}
	return undefined;
}
