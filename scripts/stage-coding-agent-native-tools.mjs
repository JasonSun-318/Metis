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

if (versions?.rg !== "15.2.0" || versions?.fd !== "10.4.2") {
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

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const target = option("--target", "all");
const outputDir = resolve(packageDir, option("--output", "dist/vendor/tools"));
const dispatcher = new EnvHttpProxyAgent();

function currentPair() {
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	if (process.arch !== "arm64" && process.arch !== "x64") return undefined;
	return `${process.platform}-${process.arch}`;
}

const selectedPairs = target === "all" ? Object.keys(pairs) : target === "current" ? [currentPair()].filter(Boolean) : [target];
for (const pair of selectedPairs) {
	if (!pairs[pair]) throw new Error(`Unsupported native-tool target: ${pair}`);
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

async function download(url) {
	const response = await fetch(url, {
		dispatcher,
		redirect: "follow",
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
	return Buffer.from(await response.arrayBuffer());
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

async function stageTools() {
	mkdirSync(dirname(outputDir), { recursive: true });
	const staged = `${outputDir}.tmp-${process.pid}`;
	rmSync(staged, { recursive: true, force: true });
	mkdirSync(staged, { recursive: true });
	try {
		for (const pair of selectedPairs) {
			const destination = join(staged, pair);
			mkdirSync(destination, { recursive: true });
			const manifest = { schemaVersion: 1, pair, tools: {} };
			for (const tool of ["rg", "fd"]) manifest.tools[tool] = await stageTool(pair, tool, destination);
			writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		}
		rmSync(outputDir, { recursive: true, force: true });
		renameSync(staged, outputDir);
	} catch (error) {
		rmSync(staged, { recursive: true, force: true });
		throw error;
	}
}

try {
	await stageTools();
} finally {
	await dispatcher.close();
}
