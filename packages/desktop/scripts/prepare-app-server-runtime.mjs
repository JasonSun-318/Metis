import { access, cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const runtimeRoot = join(repoRoot, "node_modules", ".cache", "metis-desktop", "app-server");
const workspacePackages = new Map([
	["@metis/app-protocol", join(repoRoot, "packages", "app-protocol")],
	["@metis/ai", join(repoRoot, "packages", "ai")],
	["@metis/agent-core", join(repoRoot, "packages", "agent")],
	["@metis/tui", join(repoRoot, "packages", "tui")],
	["@metis/coding-agent", join(repoRoot, "packages", "coding-agent")],
	["@metis/app-server", join(repoRoot, "packages", "app-server")],
]);
const installLockPath = join(repoRoot, "packages", "coding-agent", "install-lock", "package-lock.json");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packagedNativeTarget = process.env.METIS_NATIVE_TOOLS_TARGET;

async function run(command, args, failure, env = process.env) {
	await new Promise((resolveRun, rejectRun) => {
		// Node 24 on Windows throws EINVAL when spawning .cmd/.bat files directly
		// (https://github.com/nodejs/node/issues/59210); route them through cmd.exe.
		const child = spawn(command, args, {
			cwd: repoRoot,
			env,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.once("error", rejectRun);
		child.once("exit", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`${failure} with exit code ${code}`));
		});
	});
}

async function runNpm(args, failure) {
	await run(npm, args, failure);
}

function currentNativeTarget() {
	if (!["darwin", "linux", "win32"].includes(process.platform)) return undefined;
	if (process.arch !== "arm64" && process.arch !== "x64") return undefined;
	return `${process.platform}-${process.arch}`;
}

async function copyWorkspacePackage(packageRoot, destination) {
	const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	const includedRoots = new Set(
		(packageJson.files ?? []).map((pattern) => pattern.split("/")[0].replace(/[?*[{].*$/u, "")),
	);
	for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
		if (
			entry.name !== "package.json" &&
			!includedRoots.has(entry.name) &&
			!/^(?:README|LICENSE|LICENCE|NOTICE|CHANGELOG)/iu.test(entry.name)
		) {
			continue;
		}
		await cp(join(packageRoot, entry.name), join(destination, entry.name), { recursive: true });
	}
}

const buildSteps = [
	["run", "build", "--workspace", "@metis/tui"],
	["exec", "--workspace", "@metis/ai", "--", "tsgo", "-p", "tsconfig.build.json"],
	["run", "build", "--workspace", "@metis/agent-core"],
	["run", "build", "--workspace", "@metis/app-protocol"],
	["run", "build", "--workspace", "@metis/coding-agent"],
	["run", "build", "--workspace", "@metis/app-server"],
];
for (const args of buildSteps) await runNpm(args, `Building ${args.at(-1)} failed`);
for (const packageRoot of workspacePackages.values()) await access(join(packageRoot, "dist"));
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const installLock = JSON.parse(await readFile(installLockPath, "utf8"));
for (const [lockPath, expected] of Object.entries(installLock.packages)) {
	if (!lockPath || lockPath.startsWith("node_modules/@metis/")) continue;
	const source = join(repoRoot, lockPath);
	const sourcePackage = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	if (sourcePackage.version !== expected.version) {
		throw new Error(`${sourcePackage.name} is ${sourcePackage.version}, expected ${expected.version}; run npm install`);
	}
	const destination = join(runtimeRoot, lockPath);
	await mkdir(dirname(destination), { recursive: true });
	await cp(source, destination, { recursive: true, dereference: true });
}

for (const [packageName, packageRoot] of workspacePackages) {
	const destination = join(runtimeRoot, "node_modules", ...packageName.split("/"));
	await mkdir(destination, { recursive: true });
	await copyWorkspacePackage(packageRoot, destination);
}

if (packagedNativeTarget) {
	const [rawTargetPlatform, targetArch] = packagedNativeTarget.split("-");
	const targetPlatform = rawTargetPlatform === "mas" ? "darwin" : rawTargetPlatform;
	const tuiNativeRoot = join(runtimeRoot, "node_modules", "@metis", "tui", "native");
	for (const platform of ["darwin", "win32"]) {
		const platformRoot = join(tuiNativeRoot, platform);
		if (platform !== targetPlatform) {
			await rm(platformRoot, { recursive: true, force: true });
			continue;
		}
		await rm(join(platformRoot, "src"), { recursive: true, force: true });
		const prebuilds = join(platformRoot, "prebuilds");
		for (const entry of await readdir(prebuilds, { withFileTypes: true }).catch(() => [])) {
			if (entry.name !== `${targetPlatform}-${targetArch}`) {
				await rm(join(prebuilds, entry.name), { recursive: true, force: true });
			}
		}
	}
}

await rm(join(runtimeRoot, "node_modules", ".bin"), { recursive: true, force: true });

const entry = join(runtimeRoot, "node_modules", "@metis", "app-server", "dist", "utility-entry.js");
await access(entry);
if ((await lstat(join(runtimeRoot, "node_modules", "@metis", "app-server"))).isSymbolicLink()) {
	throw new Error("Packaged app-server runtime must not contain workspace symlinks");
}

const developmentNativeTarget = currentNativeTarget();
if (
	packagedNativeTarget &&
	packagedNativeTarget !== "all" &&
	developmentNativeTarget &&
	developmentNativeTarget !== packagedNativeTarget
) {
	await run(
		process.execPath,
		[
			join(repoRoot, "scripts", "stage-coding-agent-native-tools.mjs"),
			"--target",
			developmentNativeTarget,
			"--output",
			join(repoRoot, "packages", "coding-agent", "dist", "vendor", "tools"),
		],
		`Restoring native tools for ${developmentNativeTarget} failed`,
		{ ...process.env, METIS_NATIVE_TOOLS_TARGET: developmentNativeTarget },
	);
}
