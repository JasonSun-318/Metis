import { access, cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const runtimeRoot = join(repoRoot, "node_modules", ".cache", "arcmind-desktop", "app-server");
const workspacePackages = new Map([
	["@arcmind/app-protocol", join(repoRoot, "packages", "app-protocol")],
	["@arcmind/ai", join(repoRoot, "packages", "ai")],
	["@arcmind/agent-core", join(repoRoot, "packages", "agent")],
	["@arcmind/tui", join(repoRoot, "packages", "tui")],
	["@arcmind/coding-agent", join(repoRoot, "packages", "coding-agent")],
	["@arcmind/app-server", join(repoRoot, "packages", "app-server")],
]);
const installLockPath = join(repoRoot, "packages", "coding-agent", "install-lock", "package-lock.json");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

async function runNpm(args, failure) {
	await new Promise((resolveRun, rejectRun) => {
		const child = spawn(npm, args, { cwd: repoRoot, stdio: "inherit" });
		child.once("error", rejectRun);
		child.once("exit", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`${failure} with exit code ${code}`));
		});
	});
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
	["run", "build", "--workspace", "@arcmind/tui"],
	["exec", "--workspace", "@arcmind/ai", "--", "tsgo", "-p", "tsconfig.build.json"],
	["run", "build", "--workspace", "@arcmind/agent-core"],
	["run", "build", "--workspace", "@arcmind/coding-agent"],
	["run", "build", "--workspace", "@arcmind/app-protocol"],
	["run", "build", "--workspace", "@arcmind/app-server"],
];
for (const args of buildSteps) await runNpm(args, `Building ${args.at(-1)} failed`);
for (const packageRoot of workspacePackages.values()) await access(join(packageRoot, "dist"));
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const installLock = JSON.parse(await readFile(installLockPath, "utf8"));
for (const [lockPath, expected] of Object.entries(installLock.packages)) {
	if (!lockPath || lockPath.startsWith("node_modules/@arcmind/")) continue;
	const source = join(repoRoot, lockPath);
	const sourcePackage = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	if (sourcePackage.version !== expected.version) {
		throw new Error(`${sourcePackage.name} is ${sourcePackage.version}, expected ${expected.version}; run npm install`);
	}
	const destination = join(runtimeRoot, lockPath);
	await mkdir(dirname(destination), { recursive: true });
	await cp(source, destination, { recursive: true });
}

for (const [packageName, packageRoot] of workspacePackages) {
	const destination = join(runtimeRoot, "node_modules", ...packageName.split("/"));
	await mkdir(destination, { recursive: true });
	await copyWorkspacePackage(packageRoot, destination);
}

await rm(join(runtimeRoot, "node_modules", ".bin"), { recursive: true, force: true });

const entry = join(runtimeRoot, "node_modules", "@arcmind", "app-server", "dist", "utility-entry.js");
await access(entry);
if ((await lstat(join(runtimeRoot, "node_modules", "@arcmind", "app-server"))).isSymbolicLink()) {
	throw new Error("Packaged app-server runtime must not contain workspace symlinks");
}
