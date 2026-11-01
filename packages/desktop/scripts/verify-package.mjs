import { createHash } from "node:crypto";
import { access, lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractFile, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

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

// ARM64 Windows executes x64 and x86 binaries under emulation, so the runtime
// smoke tests below pass even for a wrong-architecture package; check the PE
// header instead.
const peMachineByArch = { arm64: 0xaa64, x64: 0x8664 };
async function assertPeMachine(file, arch) {
	const handle = await open(file, "r");
	try {
		const header = Buffer.alloc(64);
		await handle.read(header, 0, 4, 0x3c);
		const peHeaderOffset = header.readUInt32LE(0);
		await handle.read(header, 0, 2, peHeaderOffset + 4);
		if (header.readUInt16LE(0) !== peMachineByArch[arch]) {
			throw new Error(`Packaged binary is not a ${arch} PE image: ${file}`);
		}
	} finally {
		await handle.close();
	}
}

// --arch=<arm64|x64> verifies a package built for a different architecture than
// the host (for example an arm64 package built from an x64 Node in Parallels);
// without it the host architecture is detected as before.
const archFlag = process.argv.slice(2).find((argument) => argument.startsWith("--arch="));
const explicitArch = archFlag?.slice("--arch=".length).toLowerCase();
if (explicitArch !== undefined && explicitArch !== "arm64" && explicitArch !== "x64") {
	throw new Error(`Unsupported package architecture: ${explicitArch}`);
}
const expectedArch = explicitArch ?? nativeArch();
// An explicit package root also supports verifying an isolated local build.
const positionalArgs = process.argv.slice(2).filter((argument) => !argument.startsWith("--arch="));
const packageRoot = positionalArgs[0]
	? path.resolve(positionalArgs[0])
	: path.join(desktopRoot, "out", `Metis-${process.platform}-${expectedArch}`);
const resourcesRoot =
	process.platform === "darwin"
		? path.join(packageRoot, "Metis.app", "Contents", "Resources")
		: path.join(packageRoot, "resources");
if (process.platform === "darwin" || process.platform === "win32") {
	const nativeRoot = path.join(resourcesRoot, "app.asar.unpacked", ".webpack", "app-server", "node_modules", "@metis", "coding-agent", "dist", "vendor", "tools", `${process.platform}-${expectedArch}`);
	const manifest = JSON.parse(await readFile(path.join(nativeRoot, "manifest.json"), "utf8"));
	for (const name of ["rg", "fd", "officecli"]) {
		const entry = manifest.tools?.[name];
		const binary = `${name}${process.platform === "win32" ? ".exe" : ""}`;
		if (entry?.binary !== binary) throw new Error(`Invalid packaged native-tool entry: ${name}`);
		if (manifest.schemaVersion !== 1 || manifest.pair !== `${process.platform}-${expectedArch}`) throw new Error("Invalid packaged native-tool manifest");
		const digest = createHash("sha256").update(await readFile(path.join(nativeRoot, binary))).digest("hex");
		if (digest !== entry.binarySha256) throw new Error(`Packaged native-tool integrity mismatch after signing: ${name}`);
		if (process.platform === "darwin") {
			const signed = spawnSync("/usr/bin/codesign", ["-dv", path.join(nativeRoot, binary)], { encoding: "utf8" });
			if (signed.status !== 0 || !signed.stderr.split("\n").includes(`Identifier=ai.metis.tool.${name}`))
				throw new Error(`Packaged native tool was not signed before its manifest was sealed: ${name}`);
		}
		// OfficeCLI is exercised by checkSkillRuntime's actual document create/read below.
		if (name !== "officecli") {
			const smoke = spawnSync(path.join(nativeRoot, binary), ["--version"], { encoding: "utf8", timeout: 5_000 });
			if (smoke.status !== 0) throw new Error(`Packaged native-tool execution failed: ${name}`);
		}
	}
	console.log("Verified signed native-tool manifest hashes (rg, fd, officecli)");
}

const appAsar = path.join(resourcesRoot, "app.asar");
// Imported lazily: check-skill-runtime resolves modules inside the built
// coding-agent workspace, which may not exist while only arg validation runs.
const { checkSkillRuntime } = await import("../../../scripts/check-skill-runtime.mjs");
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
if (process.platform === "win32") await assertPeMachine(executable, expectedArch);

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
const rendererScripts = [...packagedPaths].filter((entry) => entry.startsWith("/.webpack/renderer/") && entry.endsWith(".js"));
for (const entry of rendererScripts) {
	const source = extractFile(appAsar, entry.slice(1).replaceAll("/", path.sep)).toString("utf8");
	if (source.trim().length === 0) throw new Error(`Packaged renderer script was removed by production optimization: ${entry}`);
}
console.log(`Verified ${rendererScripts.length} nonempty renderer scripts, including worker entries`);
for (const packagedPath of packagedPaths) {
	if (packagedPath.includes("/@metis/coding-agent/dist/vendor/python/") || packagedPath.includes("/@metis/coding-agent/dist/skills/pdf/")) {
		throw new Error(`Removed PDF skill/runtime remains in package: ${packagedPath}`);
	}
}
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

const shellAnalysisRoot = path.join(
	resourcesRoot,
	"app.asar.unpacked",
	".webpack",
	"app-server",
	"node_modules",
	"@metis",
	"coding-agent",
	"dist",
	"vendor",
	"shell-analysis",
);
const shellAnalysisManifest = JSON.parse(await readFile(path.join(shellAnalysisRoot, "manifest.json"), "utf8"));
if (
	shellAnalysisManifest.schemaVersion !== 1 ||
	shellAnalysisManifest.package !== "@vscode/tree-sitter-wasm" ||
	shellAnalysisManifest.version !== "0.3.1"
) {
	throw new Error("Invalid packaged shell analysis manifest");
}
const shellAnalysisAssets = [
	"tree-sitter.js",
	"tree-sitter.wasm",
	"tree-sitter-bash.wasm",
	"tree-sitter-python.wasm",
	"tree-sitter-javascript.wasm",
];
if (!Array.isArray(shellAnalysisManifest.files) || shellAnalysisManifest.files.length !== shellAnalysisAssets.length) {
	throw new Error("Packaged shell analysis manifest does not list exactly five assets");
}
for (const name of shellAnalysisAssets) {
	const entry = shellAnalysisManifest.files.find((candidate) => candidate?.name === name);
	if (!entry || typeof entry.sha256 !== "string") {
		throw new Error(`Invalid packaged shell analysis entry: ${name}`);
	}
	const bytes = await readFile(path.join(shellAnalysisRoot, name));
	if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || entry.bytes !== bytes.byteLength) {
		throw new Error(`Packaged shell analysis integrity mismatch: ${name}`);
	}
	const packagedPath = `/.webpack/app-server/node_modules/@metis/coding-agent/dist/vendor/shell-analysis/${name}`;
	if (!packagedPaths.has(packagedPath)) {
		throw new Error(`Packaged shell analysis asset is missing from app.asar: ${name}`);
	}
}
await access(path.join(shellAnalysisRoot, "LICENSE"));
console.log("Verified trusted shell analysis assets (tree-sitter, Bash, Python, JavaScript)");

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
if (process.platform === "win32") {
	await assertPeMachine(path.join(resourcesRoot, "app.asar.unpacked", nodePtyNative), expectedArch);
}
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
	if (process.platform === "win32") await assertPeMachine(unpackedRipgrep, expectedArch);
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
