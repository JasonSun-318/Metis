import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractFile, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { checkSkillRuntime } from "../../../scripts/check-skill-runtime.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");

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
const packageRoot = path.join(desktopRoot, "out", `Metis-${process.platform}-${expectedArch}`);
const resourcesRoot =
	process.platform === "darwin"
		? path.join(packageRoot, "Metis.app", "Contents", "Resources")
		: path.join(packageRoot, "resources");
const appAsar = path.join(resourcesRoot, "app.asar");
await checkSkillRuntime({ packageDir: path.join(appAsar, ".webpack/app-server/node_modules/@metis/coding-agent") });
const executable =
	process.platform === "darwin"
		? path.join(packageRoot, "Metis.app", "Contents", "MacOS", "Metis")
		: path.join(packageRoot, process.platform === "win32" ? "Metis.exe" : "Metis");
await access(appAsar);

if (process.platform === "darwin") {
	const appBundle = path.join(packageRoot, "Metis.app");
	const infoPlist = path.join(appBundle, "Contents", "Info.plist");
	const architecture = spawnSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" });
	if (architecture.status !== 0 || !architecture.stdout.trim().split(/\s+/u).includes(expectedArch)) {
		throw new Error(`Packaged macOS executable does not include the native ${expectedArch} architecture`);
	}
	for (const [key, expected] of [
		["CFBundleIdentifier", "ai.metis.desktop"],
		["CFBundleName", "Metis"],
		["CFBundleExecutable", "Metis"],
		["CFBundleIconFile", "metis.icns"],
		["NSDesktopFolderUsageDescription"],
		["NSDocumentsFolderUsageDescription"],
		["NSDownloadsFolderUsageDescription"],
	]) {
		const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", infoPlist], { encoding: "utf8" });
		const value = result.status === 0 ? result.stdout.trim() : "";
		if (!value || (expected && value !== expected)) throw new Error(`Invalid packaged Info.plist value for ${key}`);
	}
	await access(path.join(resourcesRoot, "metis.icns"));
	const signature = spawnSync("/usr/bin/codesign", ["-dvv", appBundle], { encoding: "utf8" });
	if (signature.status !== 0 || !/^Identifier=ai\.metis\.desktop$/mu.test(signature.stderr)) {
		throw new Error("Packaged macOS application is not signed with the Metis bundle identity");
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

// listPackage returns OS-native separators on Windows; the expected paths below
// always use forward slashes, so normalize the listing before matching.
const packagedPaths = new Set(listPackage(appAsar).map((path) => path.replaceAll("\\", "/")));
const tuiNativeRoot = "/.webpack/app-server/node_modules/@metis/tui/native/";
const expectedTuiNativePrefix =
	process.platform === "darwin" || process.platform === "win32"
		? `${tuiNativeRoot}${process.platform}/prebuilds/${process.platform}-${expectedArch}/`
		: undefined;
for (const packagedPath of packagedPaths) {
	const isTuiPrebuild = packagedPath.startsWith(tuiNativeRoot) && packagedPath.includes("/prebuilds/");
	const isExpectedTuiPrebuild =
		expectedTuiNativePrefix &&
		(packagedPath === expectedTuiNativePrefix.slice(0, -1) || packagedPath.startsWith(expectedTuiNativePrefix));
	if (isTuiPrebuild && !isExpectedTuiPrebuild) {
		throw new Error(`Packaged TUI runtime contains a foreign native architecture: ${packagedPath}`);
	}
}
const installLock = JSON.parse(
	await readFile(path.join(repoRoot, "packages", "coding-agent", "install-lock", "package-lock.json"), "utf8"),
);
const appServerPackage = JSON.parse(
	await readFile(path.join(repoRoot, "packages", "app-server", "package.json"), "utf8"),
);
if (installLock.packages[""]?.dependencies?.[appServerPackage.name] !== appServerPackage.version) {
	throw new Error("Packaged runtime lock does not include the App Server root");
}
let lockedPackageCount = 0;
for (const [lockPath, expected] of Object.entries(installLock.packages)) {
	if (!lockPath || lockPath.startsWith("node_modules/@metis/")) continue;
	const packagedPackagePath = `/.webpack/app-server/${lockPath}/package.json`;
	if (!packagedPaths.has(packagedPackagePath)) {
		throw new Error(`Locked App Server dependency is missing: ${lockPath}`);
	}
	const packagedPackage = JSON.parse(extractFile(appAsar, packagedPackagePath.slice(1).replaceAll("/", path.sep)).toString("utf8"));
	if (packagedPackage.version !== expected.version) {
		throw new Error(`${packagedPackage.name} is ${packagedPackage.version}, expected ${expected.version}`);
	}
	lockedPackageCount += 1;
}

for (const required of [
	"/.webpack/app-server/node_modules/@metis/app-server/dist/utility-entry.js",
	"/.webpack/app-server/node_modules/@metis/coding-agent/dist/core/workspace-sandbox-worker.js",
	"/.webpack/app-server/node_modules/@metis/coding-agent/dist/utils/image-resize-worker.js",
	"/.webpack/app-server/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
	"/.webpack/app-server/node_modules/jiti/lib/jiti.mjs",
]) {
	if (!packagedPaths.has(required)) throw new Error(`Packaged App Server asset is missing: ${required}`);
}

const nodePtyPlatform = process.platform === "darwin" || process.platform === "win32";
const nodePtyNative = nodePtyPlatform
	? `/.webpack/main/node_modules/node-pty/prebuilds/${process.platform}-${expectedArch}/pty.node`
	: "/.webpack/main/node_modules/node-pty/build/Release/pty.node";
for (const required of [
	"/.webpack/main/node_modules/node-pty/package.json",
	"/.webpack/main/node_modules/node-pty/lib/index.js",
	nodePtyNative,
]) {
	if (!packagedPaths.has(required)) throw new Error(`Packaged terminal runtime is missing: ${required}`);
}
await access(path.join(resourcesRoot, "app.asar.unpacked", nodePtyNative));
if (process.platform === "darwin") {
	const helper = path.join(
			resourcesRoot,
			"app.asar.unpacked",
			`.webpack/main/node_modules/node-pty/prebuilds/darwin-${expectedArch}/spawn-helper`,
		);
	await access(helper);
	if (((await lstat(helper)).mode & 0o111) === 0) throw new Error("Packaged terminal spawn-helper is not executable");
}

if (process.platform === "darwin" || process.platform === "win32") {
	const ripgrepName = process.platform === "win32" ? "rg.exe" : "rg";
	const ripgrepPath = `/.webpack/main/native-tools/${ripgrepName}`;
	if (!packagedPaths.has(ripgrepPath)) throw new Error(`Packaged ripgrep is missing: ${ripgrepPath}`);
	const unpackedRipgrep = path.join(resourcesRoot, "app.asar.unpacked", ripgrepPath);
	await access(unpackedRipgrep);
	if (process.platform !== "win32" && ((await lstat(unpackedRipgrep)).mode & 0o111) === 0) {
		throw new Error("Packaged ripgrep is not executable");
	}
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

console.log(
	`Verified ${lockedPackageCount} locked App Server dependencies, terminal, and workspace search assets in ${appAsar}`,
);
