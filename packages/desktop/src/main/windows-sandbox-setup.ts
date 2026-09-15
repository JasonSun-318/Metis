import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export type WindowsSandboxSetupResult = "installed" | "cancelled" | "unsupported";

interface WindowsSandboxSetupOptions {
	readonly appPath: string;
	readonly architecture: string;
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly runInstaller?: (helperPath: string) => Promise<number>;
	readonly grantHelperRead?: (helperPath: string) => Promise<void>;
	readonly verifyRuntime?: (helperPath: string) => Promise<void>;
	readonly runCommand?: typeof runCaptured;
}

interface SandboxRuntimeManifest {
	readonly schemaVersion: 1;
	readonly package: "@anthropic-ai/sandbox-runtime";
	readonly helpers: readonly {
		readonly kind: string;
		readonly architecture: string;
		readonly file: string;
		readonly sha256: string;
		readonly executable: boolean;
	}[];
}

function runtimeRoot(options: Pick<WindowsSandboxSetupOptions, "appPath" | "isPackaged">): string {
	if (!options.isPackaged) {
		return join(options.appPath, "..", "coding-agent", "dist", "vendor", "sandbox-runtime");
	}
	const unpackedApp = options.appPath.replace(/\.asar$/u, ".asar.unpacked");
	return join(
		unpackedApp,
		".webpack",
		"app-server",
		"node_modules",
		"@metis",
		"coding-agent",
		"dist",
		"vendor",
		"sandbox-runtime",
	);
}

function isManifest(value: unknown): value is SandboxRuntimeManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const manifest = value as Record<string, unknown>;
	return (
		manifest.schemaVersion === 1 &&
		manifest.package === "@anthropic-ai/sandbox-runtime" &&
		Array.isArray(manifest.helpers) &&
		manifest.helpers.every(
			(candidate) =>
				typeof candidate === "object" &&
				candidate !== null &&
				!Array.isArray(candidate) &&
				typeof candidate.kind === "string" &&
				typeof candidate.architecture === "string" &&
				typeof candidate.file === "string" &&
				typeof candidate.sha256 === "string" &&
				typeof candidate.executable === "boolean",
		)
	);
}

async function verifiedHelper(options: WindowsSandboxSetupOptions): Promise<string> {
	const root = runtimeRoot(options);
	const relativePath = `srt-win/${options.architecture}/srt-win.exe`;
	const manifestPath = join(root, "manifest.json");
	const manifestMetadata = await lstat(manifestPath);
	if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 64 * 1024) {
		throw new Error("Windows sandbox helper failed verification");
	}
	const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
	if (!isManifest(parsed)) throw new Error("Windows sandbox helper failed verification");
	const entry = parsed.helpers.find(
		(candidate) =>
			candidate.kind === "srt-win" &&
			candidate.architecture === options.architecture &&
			candidate.file === relativePath &&
			candidate.executable === false &&
			/^[a-f0-9]{64}$/u.test(candidate.sha256),
	);
	if (!entry) throw new Error("Windows sandbox helper failed verification");
	const helperPath = join(root, ...relativePath.split("/"));
	const helperMetadata = await lstat(helperPath);
	if (!helperMetadata.isFile() || helperMetadata.isSymbolicLink()) {
		throw new Error("Windows sandbox helper failed verification");
	}
	const digest = createHash("sha256")
		.update(await readFile(helperPath))
		.digest("hex");
	if (digest !== entry.sha256) throw new Error("Windows sandbox helper failed verification");
	return helperPath;
}

function runInstaller(helperPath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(helperPath, ["install"], { stdio: "ignore", windowsHide: true });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === null) reject(new Error("Windows sandbox setup ended unexpectedly"));
			else resolve(code);
		});
	});
}

function runCaptured(
	executable: string,
	args: readonly string[],
): Promise<{
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === null) reject(new Error("Windows sandbox setup ended unexpectedly"));
			else resolve({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

async function tryGrantHelperRead(
	helperPath: string,
	runCommand: typeof runCaptured,
): Promise<"granted" | "status-unavailable" | "invalid-sid" | "grant-failed"> {
	const status = await runCommand(helperPath, ["user", "status"]);
	if (status.exitCode !== 0) return "status-unavailable";
	let parsed: unknown;
	try {
		parsed = JSON.parse(status.stdout);
	} catch {
		return "invalid-sid";
	}
	const sid =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as { user?: { sid?: unknown } }).user?.sid
			: undefined;
	if (typeof sid !== "string" || !/^S-1-5-(?:\d+-)+\d+$/u.test(sid)) return "invalid-sid";
	const granted = await runCommand("icacls.exe", [helperPath, "/grant", `*${sid}:(RX)`]);
	return granted.exitCode === 0 ? "granted" : "grant-failed";
}

async function grantHelperRead(helperPath: string): Promise<void> {
	const result = await tryGrantHelperRead(helperPath, runCaptured);
	if (result === "status-unavailable") throw new Error("Windows sandbox account could not be inspected");
	if (result === "invalid-sid") throw new Error("Windows sandbox account identifier is invalid");
	if (result === "grant-failed") throw new Error("Windows sandbox helper permissions could not be configured");
}

export async function repairWindowsSandboxAccess(options: WindowsSandboxSetupOptions): Promise<boolean> {
	if (options.platform !== "win32" || (options.architecture !== "x64" && options.architecture !== "arm64")) {
		return false;
	}
	const helperPath = await verifiedHelper(options);
	const runCommand = options.runCommand ?? runCaptured;
	const result = await tryGrantHelperRead(helperPath, runCommand);
	if (result === "status-unavailable" || result === "invalid-sid") return false;
	if (result === "grant-failed") throw new Error("Windows sandbox helper permissions could not be repaired");
	await verifiedHelper(options);
	return true;
}

async function createWfpProbeTarget(): Promise<{ readonly target: string; readonly close: () => void }> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address && typeof address === "object" && (address.port < 60080 || address.port > 60089)) {
			return { target: `127.0.0.1:${address.port}`, close: () => server.close() };
		}
		server.close();
	}
	throw new Error("Windows sandbox verification could not create an egress probe");
}

async function verifyRuntime(helperPath: string, runCommand = runCaptured): Promise<void> {
	const probe = await createWfpProbeTarget();
	try {
		const verified = await runCommand(helperPath, ["wfp", "verify", "--target", probe.target]);
		let result: unknown;
		try {
			result = JSON.parse(verified.stdout);
		} catch {
			result = undefined;
		}
		if (
			verified.exitCode === 0 &&
			typeof result === "object" &&
			result !== null &&
			(result as { egress_probe?: unknown }).egress_probe === "blocked"
		) {
			return;
		}
		const detail = (verified.stderr || verified.stdout).split(/\r?\n/u, 1)[0]?.slice(0, 300);
		throw new Error(`Windows sandbox verification failed${detail ? `: ${detail}` : ""}`);
	} finally {
		probe.close();
	}
}

export function createWindowsSandboxSetup(
	options: WindowsSandboxSetupOptions,
): () => Promise<WindowsSandboxSetupResult> {
	return async () => {
		if (options.platform !== "win32" || (options.architecture !== "x64" && options.architecture !== "arm64")) {
			return "unsupported";
		}
		const helperPath = await verifiedHelper(options);
		const exitCode = await (options.runInstaller ?? runInstaller)(helperPath);
		if (exitCode === 0) {
			await (options.grantHelperRead ?? grantHelperRead)(helperPath);
			await verifiedHelper(options);
			await (options.verifyRuntime ?? ((path) => verifyRuntime(path, options.runCommand)))(helperPath);
			return "installed";
		}
		if (exitCode === 10) return "cancelled";
		throw new Error(`Windows sandbox setup failed with exit code ${exitCode}`);
	};
}
