import { access, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const runtimeRoot = join(repoRoot, "node_modules", ".cache", "arcmind-desktop", "app-server");
const workspacePackages = ["app-protocol", "ai", "agent", "tui", "coding-agent", "app-server"].map((name) =>
	join(repoRoot, "packages", name),
);
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

const buildSteps = [
	["run", "build", "--workspace", "@arcmind/tui"],
	["exec", "--workspace", "@arcmind/ai", "--", "tsgo", "-p", "tsconfig.build.json"],
	["run", "build", "--workspace", "@arcmind/agent-core"],
	["run", "build", "--workspace", "@arcmind/coding-agent"],
	["run", "build", "--workspace", "@arcmind/app-protocol"],
	["run", "build", "--workspace", "@arcmind/app-server"],
];
for (const args of buildSteps) await runNpm(args, `Building ${args.at(-1)} failed`);
for (const packageRoot of workspacePackages) await access(join(packageRoot, "dist"));
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const args = [
	"install",
	"--prefix",
	runtimeRoot,
	"--omit=dev",
	"--install-links=true",
	"--ignore-scripts",
	"--offline",
	"--package-lock=false",
	"--no-save",
	...workspacePackages,
];

await runNpm(args, "Preparing the packaged app-server runtime failed");

await rm(join(runtimeRoot, "node_modules", ".bin"), { recursive: true, force: true });

const entry = join(runtimeRoot, "node_modules", "@arcmind", "app-server", "dist", "utility-entry.js");
await access(entry);
if ((await lstat(join(runtimeRoot, "node_modules", "@arcmind", "app-server"))).isSymbolicLink()) {
	throw new Error("Packaged app-server runtime must not contain workspace symlinks");
}
