import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const desktopRoot = path.resolve(import.meta.dirname, "..");

function nativeArch() {
	if (
		process.platform === "darwin" &&
		spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1"
	) {
		return "arm64";
	}
	const machine =
		process.platform === "win32"
			? (process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE ?? process.arch)
			: spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
	if (/^(arm64|aarch64)$/i.test(machine)) return "arm64";
	if (/^(x64|x86_64|amd64)$/i.test(machine)) return "x64";
	return process.arch;
}

const expectedArch = nativeArch();
const packageRoot = path.join(desktopRoot, "out", `ArcMind-${process.platform}-${expectedArch}`);
const resourcesRoot =
	process.platform === "darwin"
		? path.join(packageRoot, "ArcMind.app", "Contents", "Resources")
		: path.join(packageRoot, "resources");
const appAsar = path.join(resourcesRoot, "app.asar");
const executable =
	process.platform === "darwin"
		? path.join(packageRoot, "ArcMind.app", "Contents", "MacOS", "arcmind")
		: path.join(packageRoot, process.platform === "win32" ? "arcmind.exe" : "arcmind");
await access(appAsar);

if (process.platform === "darwin") {
	const appBundle = path.join(packageRoot, "ArcMind.app");
	const infoPlist = path.join(appBundle, "Contents", "Info.plist");
	const architecture = spawnSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" });
	if (architecture.status !== 0 || !architecture.stdout.trim().split(/\s+/u).includes(expectedArch)) {
		throw new Error(`Packaged macOS executable does not include the native ${expectedArch} architecture`);
	}
	for (const [key, expected] of [
		["CFBundleIdentifier", "ai.arcmind.desktop"],
		["NSDesktopFolderUsageDescription"],
		["NSDocumentsFolderUsageDescription"],
		["NSDownloadsFolderUsageDescription"],
	]) {
		const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", infoPlist], { encoding: "utf8" });
		const value = result.status === 0 ? result.stdout.trim() : "";
		if (!value || (expected && value !== expected)) throw new Error(`Invalid packaged Info.plist value for ${key}`);
	}
	const signature = spawnSync("/usr/bin/codesign", ["-dvv", appBundle], { encoding: "utf8" });
	if (signature.status !== 0 || !/^Identifier=ai\.arcmind\.desktop$/mu.test(signature.stderr)) {
		throw new Error("Packaged macOS application is not signed with the ArcMind bundle identity");
	}
	const verification = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle], {
		encoding: "utf8",
	});
	if (verification.status !== 0) {
		throw new Error(`Packaged macOS signature is invalid: ${verification.stderr.trim()}`);
	}
}

const fuses = await getCurrentFuseWire(executable);
for (const [fuse, expected] of [
	[FuseV1Options.RunAsNode, FuseState.DISABLE],
	[FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
	[FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
	[FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
	[FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
	[FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
	[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
	[FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
	[FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]) {
	if (fuses[fuse] !== expected) throw new Error(`Packaged Electron fuse ${FuseV1Options[fuse]} is misconfigured`);
}

const packagedPaths = new Set(listPackage(appAsar));
for (const required of [
	"/.webpack/app-server/node_modules/@arcmind/app-server/dist/utility-entry.js",
	"/.webpack/app-server/node_modules/@arcmind/coding-agent/dist/utils/image-resize-worker.js",
	"/.webpack/app-server/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
	"/.webpack/app-server/node_modules/jiti/lib/jiti.mjs",
]) {
	if (!packagedPaths.has(required)) throw new Error(`Packaged App Server asset is missing: ${required}`);
}

try {
	await lstat(path.join(resourcesRoot, "app-server"));
	throw new Error("App Server runtime must be protected inside app.asar, not copied as a loose resource");
} catch (error) {
	if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

for (const asset of ["image-resize-worker.js", "photon_rs_bg.wasm"]) {
	if (packagedPaths.has(`/.webpack/app-server/${asset}`)) {
		throw new Error(`Unexpected duplicate packaged asset: ${asset}`);
	}
}

console.log(`Verified packaged App Server assets in ${appAsar}`);
