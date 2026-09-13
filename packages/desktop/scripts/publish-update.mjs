#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { access, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE_URL = "https://metis-release.oss-cn-shenzhen.aliyuncs.com/metis";
const DEFAULT_BUCKET = "metis-release";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_DMG_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RELEASE_NOTES_CHARACTERS = 64 * 1024;

export function normalizeReleaseNotes(value) {
	if (typeof value !== "string") throw new Error("Invalid update release notes");
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_RELEASE_NOTES_CHARACTERS) {
		throw new Error("Invalid update release notes");
	}
	return normalized;
}

export function trustedBaseUrl(value) {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
		url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
		return url;
	} catch {
		return undefined;
	}
}

export function objectPrefix(baseUrl) {
	return baseUrl.pathname.replace(/^\/+/u, "");
}

export function releaseKeys(baseUrl, arch, version) {
	const prefix = objectPrefix(baseUrl);
	const dmgRelative = `darwin/${arch}/releases/${version}/Metis-${version}-darwin-${arch}.dmg`;
	const manifestRelative = `darwin/${arch}/latest.json`;
	return {
		dmgKey: `${prefix}${dmgRelative}`,
		manifestKey: `${prefix}${manifestRelative}`,
		dmgUrl: new URL(dmgRelative, baseUrl).href,
		manifestUrl: new URL(manifestRelative, baseUrl).href,
	};
}

export function buildLatestManifest({ version, releaseNotes, dmgUrl, size, sha256 }) {
	return {
		schemaVersion: 1,
		version,
		releaseNotes,
		dmg: { url: dmgUrl, size, sha256 },
	};
}

/** Keep aligned with packages/desktop/src/main/updater.ts parseManifest. */
export function assertClientAccepts(manifest, baseUrl) {
	if (manifest.schemaVersion !== 1 || typeof manifest.version !== "string" || !STABLE_VERSION.test(manifest.version)) {
		throw new Error("Invalid update manifest");
	}
	normalizeReleaseNotes(manifest.releaseNotes);
	const dmg = manifest.dmg;
	if (
		typeof dmg?.url !== "string" ||
		!Number.isSafeInteger(dmg.size) ||
		dmg.size < 1 ||
		dmg.size > MAX_DMG_BYTES ||
		typeof dmg.sha256 !== "string" ||
		!SHA256.test(dmg.sha256)
	) {
		throw new Error("Invalid update manifest");
	}
	const url = new URL(dmg.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.origin !== baseUrl.origin ||
		!url.pathname.startsWith(baseUrl.pathname) ||
		!url.pathname.endsWith(".dmg") ||
		url.search ||
		url.hash
	) {
		throw new Error("Invalid update manifest");
	}
}

async function fileSha256(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

function packageVersion() {
	return JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;
}

function nativeArch() {
	if (
		process.platform === "darwin" &&
		spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1"
	) {
		return "arm64";
	}
	const machine = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
	return /^(arm64|aarch64)$/iu.test(machine) ? "arm64" : /^(x64|x86_64|amd64)$/iu.test(machine) ? "x64" : process.arch;
}

async function findDmg(version, arch) {
	const makeDir = path.join(desktopRoot, "out", "make");
	const candidates = [
		path.join(makeDir, `Metis-${version}-darwin-${arch}.dmg`),
		path.join(makeDir, `Metis-${version}-${arch}.dmg`),
		path.join(makeDir, `Metis-${version}.dmg`),
	];
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {}
	}
	let entries = [];
	try {
		entries = await readdir(makeDir);
	} catch {
		throw new Error(`No packaged DMG. Run: METIS_UPDATE_BASE_URL=... npm run make --workspace @metis/desktop`);
	}
	const matches = entries.filter((name) => name.endsWith(".dmg") && name.includes(version));
	if (matches.length === 1) return path.join(makeDir, matches[0]);
	throw new Error(`Could not find DMG for ${version} in ${makeDir}. Found: ${entries.filter((name) => name.endsWith(".dmg")).join(", ") || "(none)"}`);
}

function ossutilBin() {
	const fromEnv = process.env.OSSUTIL;
	if (fromEnv) return fromEnv;
	const found = spawnSync("which", ["ossutil"], { encoding: "utf8" });
	if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
	throw new Error(
		"ossutil is not installed. Install with:\n  curl -o ossutil.zip https://gosspublic.alicdn.com/ossutil/v2/2.3.0/ossutil-2.3.0-mac-arm64.zip && unzip ossutil.zip && sudo mv ossutil /usr/local/bin/\nThen run: ossutil config",
	);
}

function runOssutil(args) {
	const bin = ossutilBin();
	const extra = [];
	if (!args.includes("-e") && !args.includes("--endpoint")) extra.push("-e", "oss-cn-shenzhen.aliyuncs.com");
	if (!args.includes("--region")) extra.push("--region", "cn-shenzhen");
	const result = spawnSync(bin, [...extra, ...args], { stdio: "inherit" });
	if (result.status !== 0) throw new Error(`ossutil ${args[0]} failed`);
}

function parseArgs(argv) {
	const rest = [...argv];
	const command = rest.shift() ?? "help";
	const options = {
		arch: process.env.METIS_UPDATE_ARCH || nativeArch(),
		baseUrl: process.env.METIS_UPDATE_BASE_URL || DEFAULT_BASE_URL,
		bucket: process.env.METIS_OSS_BUCKET || DEFAULT_BUCKET,
		dmg: undefined,
		dryRun: false,
		notesFile: undefined,
		version: undefined,
	};
	while (rest.length > 0) {
		const flag = rest.shift();
		if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--arch") options.arch = rest.shift();
		else if (flag === "--base-url") options.baseUrl = rest.shift();
		else if (flag === "--bucket") options.bucket = rest.shift();
		else if (flag === "--dmg") options.dmg = rest.shift();
		else if (flag === "--notes-file") options.notesFile = rest.shift();
		else if (flag === "--version") options.version = rest.shift();
		else throw new Error(`Unknown argument: ${flag}`);
	}
	if (!options.arch) throw new Error("Missing --arch");
	if (command === "publish" && !options.notesFile) throw new Error("Missing --notes-file");
	return { command, options };
}

function usage() {
	return `Usage:
  node scripts/publish-update.mjs ls
  node scripts/publish-update.mjs publish --notes-file path [--version x.y.z] [--arch arm64|x64] [--dmg path] [--dry-run]

Uploads darwin/<arch>/latest.json and the DMG to oss://metis-release with public-read.
--notes-file must point to a UTF-8 Markdown file with 1-65536 characters after trimming;
its trimmed content is embedded as the manifest releaseNotes field.
Requires ossutil on PATH (credentials via \`ossutil config\`, never committed).
Packaged builds must set METIS_UPDATE_BASE_URL at make time (same HTTPS origin as --base-url).
`;
}

async function listBucket(options) {
	runOssutil(["ls", `oss://${options.bucket}/`]);
}

async function publish(options) {
	const version = options.version ?? packageVersion();
	if (!STABLE_VERSION.test(version)) throw new Error(`Invalid desktop version: ${version}`);
	if (!["arm64", "x64"].includes(options.arch)) throw new Error(`Unsupported arch: ${options.arch}`);
	const baseUrl = trustedBaseUrl(options.baseUrl);
	if (!baseUrl) {
		throw new Error("METIS_UPDATE_BASE_URL must be a credential-free https URL with no query or hash");
	}
	const releaseNotes = normalizeReleaseNotes(readFileSync(path.resolve(options.notesFile), "utf8"));
	const dmgPath = options.dmg ?? (await findDmg(version, options.arch));
	const metadata = await stat(dmgPath);
	if (!metadata.isFile()) throw new Error(`Not a file: ${dmgPath}`);
	const sha256 = await fileSha256(dmgPath);
	const { dmgKey, manifestKey, dmgUrl, manifestUrl } = releaseKeys(baseUrl, options.arch, version);
	const manifest = buildLatestManifest({ version, releaseNotes, dmgUrl, size: metadata.size, sha256 });
	assertClientAccepts(manifest, baseUrl);
	const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
	console.log(JSON.stringify({ dmg: dmgPath, size: metadata.size, sha256, dmgKey, manifestKey, dmgUrl }, null, 2));
	if (options.dryRun) {
		process.stdout.write(manifestText);
		return;
	}
	const manifestFile = path.join(tmpdir(), `metis-latest-${version}.json`);
	await writeFile(manifestFile, manifestText);
	runOssutil(["cp", dmgPath, `oss://${options.bucket}/${dmgKey}`, "--acl", "public-read", "-f"]);
	try {
		runOssutil([
			"cp",
			manifestFile,
			`oss://${options.bucket}/${manifestKey}`,
			"--acl",
			"public-read",
			"--cache-control",
			"no-cache",
			"-f",
		]);
	} catch {
		runOssutil(["cp", manifestFile, `oss://${options.bucket}/${manifestKey}`, "--acl", "public-read", "-f"]);
	}
	console.log(`Uploaded. Check: ${manifestUrl}`);
}

async function main(argv) {
	const { command, options } = parseArgs(argv);
	if (command === "help" || command === "-h" || command === "--help") {
		process.stdout.write(usage());
		return;
	}
	if (command === "ls") {
		await listBucket(options);
		return;
	}
	if (command === "publish") {
		await publish(options);
		return;
	}
	throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
