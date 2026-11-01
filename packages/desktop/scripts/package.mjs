import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function nativeArch() {
	const machine = process.platform === "darwin"
		? spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1"
			? "arm64"
			: spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim()
		: process.platform === "win32"
			? (process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE ?? process.arch)
			: spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
	return /^(arm64|aarch64)$/iu.test(machine) ? "arm64" : /^(x64|x86_64|amd64)$/iu.test(machine) ? "x64" : process.arch;
}

const [command, ...args] = process.argv.slice(2);
if (command !== "package" && command !== "make") throw new TypeError("Expected package or make");
if (!args.some((argument) => argument === "--arch" || argument.startsWith("--arch="))) {
	args.push(`--arch=${nativeArch()}`);
}
const require = createRequire(import.meta.url);
if (command === "make" && process.platform === "win32") {
	// Repository setup skips lifecycle scripts, so electron-winstaller does not
	// create the architecture-selected names that Squirrel invokes. Squirrel runs
	// 7z.exe on the build host while compressing the installer payload, so this
	// copy must follow the host architecture even when --arch packages a
	// different target; Squirrel itself is arch-agnostic about the payload.
	const vendor = join(dirname(require.resolve("electron-winstaller/package.json")), "vendor");
	for (const extension of ["exe", "dll"]) {
		copyFileSync(join(vendor, `7z-${nativeArch()}.${extension}`), join(vendor, `7z.${extension}`));
	}
}
if (command === "make" && process.platform === "darwin") {
	// Repository setup skips lifecycle scripts; Forge's DMG maker still needs
	// these two locked native transitive dependencies before it can run.
	const dmgNativeDependencies = [
		{ name: "fs-xattr", artifact: "fs-xattr/build/Release/xattr.node" },
		{ name: "macos-alias", artifact: "macos-alias/build/Release/volume.node" },
	];
	const missing = dmgNativeDependencies.filter(({ artifact }) => {
		try {
			require.resolve(artifact);
			return false;
		} catch {
			return true;
		}
	});
	if (missing.length > 0) {
		const rebuild = spawnSync("npm", ["rebuild", ...missing.map(({ name }) => name)], {
			cwd: resolve(import.meta.dirname, "../../.."),
			stdio: "inherit",
		});
		if (rebuild.error) throw rebuild.error;
		if (rebuild.status !== 0) throw new Error(`DMG native dependency rebuild failed with exit code ${rebuild.status ?? "unknown"}`);
		for (const { artifact } of dmgNativeDependencies) require.resolve(artifact);
	}
}
const forge = require.resolve("@electron-forge/cli/dist/electron-forge.js");
const packagerTempRoot = mkdtempSync(join(tmpdir(), "metis-electron-packager-"));
try {
	const result = spawnSync(process.execPath, [forge, command, ...args], {
		stdio: "inherit",
		env: { ...process.env, METIS_ELECTRON_PACKAGER_TMPDIR: packagerTempRoot },
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(packagerTempRoot, { recursive: true, force: true });
}
