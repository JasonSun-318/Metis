import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

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
const forge = createRequire(import.meta.url).resolve("@electron-forge/cli/dist/electron-forge.js");
const result = spawnSync(process.execPath, [forge, command, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
