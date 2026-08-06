#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, fetch } from "undici";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const versions = packageJson.arcmindNativeTools;

if (versions?.rg !== "15.2.0" || versions?.fd !== "10.4.2" || versions?.officecli !== "1.0.140") {
	throw new Error("Update the pinned native-tool archive table before changing arcmindNativeTools");
}

const pairs = {
	"darwin-arm64": {
		rg: [
			`ripgrep-${versions.rg}-aarch64-apple-darwin.tar.gz`,
			"3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
		],
		fd: [
			`fd-v${versions.fd}-aarch64-apple-darwin.tar.gz`,
			"623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
		],
	},
	"darwin-x64": {
		rg: [
			`ripgrep-${versions.rg}-x86_64-apple-darwin.tar.gz`,
			"af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
		],
		fd: [
			"fd-v10.3.0-x86_64-apple-darwin.tar.gz",
			"50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
		],
	},
	"win32-arm64": {
		rg: [
			`ripgrep-${versions.rg}-aarch64-pc-windows-msvc.zip`,
			"e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
		],
		fd: [
			`fd-v${versions.fd}-aarch64-pc-windows-msvc.zip`,
			"4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
		],
	},
	"win32-x64": {
		rg: [
			`ripgrep-${versions.rg}-x86_64-pc-windows-msvc.zip`,
			"71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
		],
		fd: [
			`fd-v${versions.fd}-x86_64-pc-windows-msvc.zip`,
			"b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
		],
	},
};

const officeCliPairs = {
	"darwin-arm64": [
		"officecli-mac-arm64",
		"d83d68a6138c9a8456707db86f9ff62813a2d752d08ea725b3c8f077950086ba",
	],
	"darwin-x64": [
		"officecli-mac-x64",
		"61b864e628d0cf4e203b2b8e679bccdaf657e0328d54f17d08173181a2adba13",
	],
	"linux-arm64": [
		"officecli-linux-arm64",
		"924dd58f57891d1b3fe8cf77f06990f58f8f0c0ddf6fe22e1d91c7f10d3e7576",
	],
	"linux-x64": [
		"officecli-linux-x64",
		"cee68cc2108074e5ae5ad114e1cd5cab4514da8ead4983d5d94aa0acba4f41e8",
	],
	"win32-arm64": [
		"officecli-win-arm64.exe",
		"a83bcfbab9a092dd060d6016168c42a639865d198ef6aa3772dd196109433551",
	],
	"win32-x64": [
		"officecli-win-x64.exe",
		"43ad45527bf2c486da1dd7c8d9257b90ac17a6b83028d7064ea38235cd43ec3e",
	],
};

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const target = process.env.ARCMIND_NATIVE_TOOLS_TARGET ?? option("--target", "all");
const outputDir = resolve(packageDir, option("--output", "dist/vendor/tools"));
const dispatcher = new EnvHttpProxyAgent();

function currentPair() {
	if (!["darwin", "linux", "win32"].includes(process.platform)) return undefined;
	if (process.arch !== "arm64" && process.arch !== "x64") return undefined;
	return `${process.platform}-${process.arch}`;
}

const supportedPairs = [...new Set([...Object.keys(pairs), ...Object.keys(officeCliPairs)])];
const selectedPairs = target === "all" ? supportedPairs : target === "current" ? [currentPair()].filter(Boolean) : [target];
for (const pair of selectedPairs) {
	if (!supportedPairs.includes(pair)) throw new Error(`Unsupported native-tool target: ${pair}`);
}

function stageSandboxRuntime() {
	const source = join(repoRoot, "node_modules", "@anthropic-ai", "sandbox-runtime");
	const destination = join(dirname(outputDir), "sandbox-runtime");
	const staged = `${destination}.tmp-${process.pid}`;
	const architectures =
		target === "all"
			? ["x64", "arm64"]
			: [...new Set(selectedPairs.map((pair) => pair.split("-").at(-1)).filter(Boolean))];
	rmSync(staged, { recursive: true, force: true });
	try {
		for (const architecture of architectures) {
			for (const [kind, executable] of [
				["seccomp", "apply-seccomp"],
				["srt-win", "srt-win.exe"],
			]) {
				const input = join(source, "vendor", kind, architecture, executable);
				if (!statSync(input).isFile()) throw new Error(`Sandbox runtime helper is missing: ${input}`);
				const output = join(staged, kind, architecture, executable);
				mkdirSync(dirname(output), { recursive: true });
				cpSync(input, output);
				if (kind === "seccomp") chmodSync(output, 0o755);
			}
		}
		const license = join(source, "LICENSE");
		if (!statSync(license).isFile()) throw new Error(`Sandbox runtime license is missing: ${license}`);
		mkdirSync(join(staged, "licenses"), { recursive: true });
		cpSync(license, join(staged, "licenses", "LICENSE"));
		rmSync(destination, { recursive: true, force: true });
		renameSync(staged, destination);
	} catch (error) {
		rmSync(staged, { recursive: true, force: true });
		throw error;
	}
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

async function download(url) {
	let failure;
	const chunks = [];
	let received = 0;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				dispatcher,
				headers: {
					"accept-encoding": "identity",
					...(received > 0 ? { range: `bytes=${received}-` } : {}),
				},
				redirect: "follow",
				signal: AbortSignal.timeout(120_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			if (received > 0 && response.status !== 206) {
				chunks.length = 0;
				received = 0;
			}
			if (!response.body) throw new Error("Response body is missing");
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) return Buffer.concat(chunks, received);
				chunks.push(Buffer.from(value));
				received += value.byteLength;
			}
		} catch (error) {
			failure = error;
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
		}
	}
	throw new Error(`Download failed after 3 attempts: ${url}: ${failure instanceof Error ? failure.message : String(failure)}`, {
		cause: failure,
	});
}

function walk(root) {
	const files = [];
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile()) files.push(path);
		}
	}
	return files;
}

function extract(archivePath, destination) {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	const tar = process.platform === "win32" && systemRoot ? join(systemRoot, "System32", "tar.exe") : "tar";
	const result = spawnSync(tar, ["-xf", archivePath, "-C", destination], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(`Could not extract ${basename(archivePath)}: ${result.error?.message ?? result.stderr.trim()}`);
	}
}

function releaseUrl(tool, archiveName) {
	return tool === "rg"
		? `https://github.com/BurntSushi/ripgrep/releases/download/${versions.rg}/${archiveName}`
		: `https://github.com/sharkdp/fd/releases/download/v${/^fd-v([^-]+)/.exec(archiveName)?.[1]}/${archiveName}`;
}

async function stageTool(pair, tool, destination) {
	const [archiveName, expectedArchiveSha256] = pairs[pair][tool];
	const version = tool === "rg" ? versions.rg : /^fd-v([^-]+)/.exec(archiveName)?.[1];
	if (!version) throw new Error(`Could not determine the version for ${archiveName}`);
	const archive = await download(releaseUrl(tool, archiveName));
	const actualArchiveSha256 = sha256(archive);
	if (actualArchiveSha256 !== expectedArchiveSha256) {
		throw new Error(`${archiveName} SHA-256 mismatch: expected ${expectedArchiveSha256}, got ${actualArchiveSha256}`);
	}

	const temporary = mkdtempSync(join(tmpdir(), `arcmind-${tool}-`));
	try {
		const archivePath = join(temporary, archiveName);
		writeFileSync(archivePath, archive);
		const extracted = join(temporary, "extracted");
		mkdirSync(extracted);
		extract(archivePath, extracted);
		const executableName = `${tool}${pair.startsWith("win32-") ? ".exe" : ""}`;
		const files = walk(extracted);
		const executable = files.find((path) => basename(path).toLowerCase() === executableName.toLowerCase());
		if (!executable) throw new Error(`${archiveName} does not contain ${executableName}`);
		const destinationExecutable = join(destination, executableName);
		cpSync(executable, destinationExecutable);
		if (!pair.startsWith("win32-")) chmodSync(destinationExecutable, 0o755);

		const licensesDir = join(destination, "licenses");
		mkdirSync(licensesDir, { recursive: true });
		const licenseFiles = files.filter((path) => /^(license|copying|unlicense|notice)/i.test(basename(path)));
		if (licenseFiles.length === 0) throw new Error(`${archiveName} does not contain an upstream license`);
		for (const license of licenseFiles) {
			cpSync(license, join(licensesDir, `${tool}-${basename(license)}`));
		}

		return {
			version,
			archive: archiveName,
			archiveSha256: expectedArchiveSha256,
			binary: executableName,
			binarySha256: sha256(readFileSync(destinationExecutable)),
		};
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

let officeCliLicenses;

async function getOfficeCliLicenses() {
	officeCliLicenses ??= Promise.all(
		["LICENSE", "NOTICE"].map(async (name) => [
			name,
			await download(`https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v${versions.officecli}/${name}`),
		]),
	);
	return officeCliLicenses;
}

async function stageOfficeCli(pair, destination) {
	const [assetName, expectedSha256] = officeCliPairs[pair];
	const binary = await download(
		`https://github.com/iOfficeAI/OfficeCLI/releases/download/v${versions.officecli}/${assetName}`,
	);
	const actualSha256 = sha256(binary);
	if (actualSha256 !== expectedSha256) {
		throw new Error(`${assetName} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
	}
	const executableName = `officecli${pair.startsWith("win32-") ? ".exe" : ""}`;
	const destinationExecutable = join(destination, executableName);
	writeFileSync(destinationExecutable, binary);
	if (!pair.startsWith("win32-")) chmodSync(destinationExecutable, 0o755);

	const licensesDir = join(destination, "licenses");
	mkdirSync(licensesDir, { recursive: true });
	for (const [name, contents] of await getOfficeCliLicenses()) {
		writeFileSync(join(licensesDir, `officecli-${name}`), contents);
	}
	return {
		version: versions.officecli,
		archive: assetName,
		archiveSha256: expectedSha256,
		binary: executableName,
		binarySha256: actualSha256,
	};
}

async function stageTools() {
	mkdirSync(dirname(outputDir), { recursive: true });
	const staged = `${outputDir}.tmp-${process.pid}`;
	rmSync(staged, { recursive: true, force: true });
	mkdirSync(staged, { recursive: true });
	try {
		const queue = [...selectedPairs];
		// ponytail: two workers avoid overloading common developer proxies; raise only after measured CI need.
		await Promise.all(
			Array.from({ length: Math.min(2, queue.length) }, async () => {
				while (queue.length > 0) {
					const pair = queue.shift();
					if (!pair) return;
					const destination = join(staged, pair);
					mkdirSync(destination, { recursive: true });
					const manifest = { schemaVersion: 1, pair, tools: {} };
					if (pairs[pair]) {
						for (const tool of ["rg", "fd"]) manifest.tools[tool] = await stageTool(pair, tool, destination);
					}
					if (officeCliPairs[pair]) manifest.tools.officecli = await stageOfficeCli(pair, destination);
					writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
				}
			}),
		);
		rmSync(outputDir, { recursive: true, force: true });
		renameSync(staged, outputDir);
	} catch (error) {
		rmSync(staged, { recursive: true, force: true });
		throw error;
	}
}

try {
	stageSandboxRuntime();
	await stageTools();
} finally {
	await dispatcher.close();
}
