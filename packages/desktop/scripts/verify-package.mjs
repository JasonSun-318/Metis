import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listPackage } from "@electron/asar";

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

const packageRoot = path.join(desktopRoot, "out", `ArcMind-${process.platform}-${nativeArch()}`);
const resourcesRoot =
	process.platform === "darwin"
		? path.join(packageRoot, "ArcMind.app", "Contents", "Resources")
		: path.join(packageRoot, "resources");
const appAsar = path.join(resourcesRoot, "app.asar");
await access(appAsar);

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
