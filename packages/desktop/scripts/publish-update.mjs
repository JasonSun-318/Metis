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
const MAX_UPDATE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RELEASE_NOTES_CHARACTERS = 64 * 1024;
const MAX_CHANGELOG_RELEASES = 100;

function releaseTarget(platform) {
	if (platform === "darwin") {
		return {
			manifestKey: "dmg",
			extension: ".dmg",
			assetRelative: (arch, version) => `darwin/${arch}/releases/${version}/Metis-${version}-darwin-${arch}.dmg`,
		};
	}
	if (platform === "win32") {
		return {
			manifestKey: "exe",
			extension: ".exe",
			assetRelative: (arch, version) => `win32/${arch}/releases/${version}/Metis-${version}-win32-${arch}-Setup.exe`,
		};
	}
	throw new Error(`Unsupported platform: ${platform}`);
}

export function normalizeReleaseNotes(value) {
	if (typeof value !== "string") throw new Error("Invalid update release notes");
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_RELEASE_NOTES_CHARACTERS) {
		throw new Error("Invalid update release notes");
	}
	return normalized;
}

function compareStableVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = leftParts[index] - rightParts[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export function normalizeChangelog(value) {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 2 ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.releases) ||
		value.releases.length === 0 ||
		value.releases.length > MAX_CHANGELOG_RELEASES
	) {
		throw new Error("Invalid desktop changelog");
	}
	const releases = value.releases.map((release, index) => {
		if (
			typeof release !== "object" ||
			release === null ||
			Array.isArray(release) ||
			Object.keys(release).length !== 2 ||
			typeof release.version !== "string" ||
			!STABLE_VERSION.test(release.version)
		) {
			throw new Error("Invalid desktop changelog");
		}
		const notes = normalizeReleaseNotes(release.notes);
		const previous = index > 0 ? value.releases[index - 1] : undefined;
		if (
			previous &&
			(typeof previous.version !== "string" ||
				!STABLE_VERSION.test(previous.version) ||
				compareStableVersions(previous.version, release.version) <= 0)
		) {
			throw new Error("Invalid desktop changelog order");
		}
		return { version: release.version, notes };
	});
	return { schemaVersion: 1, releases };
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

export function releaseKeys(baseUrl, platform, arch, version) {
	const prefix = objectPrefix(baseUrl);
	const target = releaseTarget(platform);
	const assetRelative = target.assetRelative(arch, version);
	const manifestRelative = `${platform}/${arch}/latest.json`;
	const changelogRelative = `${platform}/changelog.json`;
	return {
		changelogKey: `${prefix}${changelogRelative}`,
		changelogUrl: new URL(changelogRelative, baseUrl).href,
		assetObjectKey: `${prefix}${assetRelative}`,
		manifestKey: `${prefix}${manifestRelative}`,
		assetUrl: new URL(assetRelative, baseUrl).href,
		manifestUrl: new URL(manifestRelative, baseUrl).href,
	};
}

export function buildLatestManifest({ platform, version, assetUrl, size, sha256 }) {
	const key = releaseTarget(platform).manifestKey;
	return {
		schemaVersion: 1,
		version,
		[key]: { url: assetUrl, size, sha256 },
	};
}

/** Keep aligned with packages/desktop/src/main/updater.ts parseManifest. */
export function assertClientAccepts(manifest, baseUrl, platform) {
	if (manifest.schemaVersion !== 1 || typeof manifest.version !== "string" || !STABLE_VERSION.test(manifest.version)) {
		throw new Error("Invalid update manifest");
	}
	const { extension, manifestKey: key } = releaseTarget(platform);
	const artifact = manifest[key];
	if (
		typeof artifact?.url !== "string" ||
		!Number.isSafeInteger(artifact.size) ||
		artifact.size < 1 ||
		artifact.size > MAX_UPDATE_BYTES ||
		typeof artifact.sha256 !== "string" ||
		!SHA256.test(artifact.sha256)
	) {
		throw new Error("Invalid update manifest");
	}
	const url = new URL(artifact.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.origin !== baseUrl.origin ||
		!url.pathname.startsWith(baseUrl.pathname) ||
		!url.pathname.endsWith(extension) ||
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
	if (process.platform === "win32") {
		const machine = process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE ?? process.arch;
		return /^(arm64|aarch64)$/iu.test(machine) ? "arm64" : /^(x64|amd64)$/iu.test(machine) ? "x64" : process.arch;
	}
	if (
		process.platform === "darwin" &&
		spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1"
	) {
		return "arm64";
	}
	const machine = (spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout ?? "").trim();
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

async function findWindowsInstaller(version, arch) {
	const installer = path.join(
		desktopRoot,
		"out",
		"make",
		"squirrel.windows",
		arch,
		`Metis-${version} Setup.exe`,
	);
	try {
		await access(installer);
		return installer;
	} catch {
		throw new Error(
			`No packaged Windows installer. Run in PowerShell: $env:METIS_UPDATE_BASE_URL="https://..."; npm run make --workspace @metis/desktop -- --arch=${arch}`,
		);
	}
}

export function ossutilBin(environment = process.env) {
	return environment.OSSUTIL || "ossutil";
}

function runOssutil(args) {
	const bin = ossutilBin();
	const extra = [];
	if (!args.includes("-e") && !args.includes("--endpoint")) extra.push("-e", "oss-cn-shenzhen.aliyuncs.com");
	if (!args.includes("--region")) extra.push("--region", "cn-shenzhen");
	const result = spawnSync(bin, [...extra, ...args], { stdio: "inherit" });
	if (result.error) throw new Error(`ossutil is unavailable: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`ossutil ${args[0]} failed`);
}

function parseArgs(argv) {
	const rest = [...argv];
	const command = rest.shift() ?? "help";
	const options = {
		platform: process.env.METIS_UPDATE_PLATFORM || (process.platform === "win32" ? "win32" : "darwin"),
		arch: process.env.METIS_UPDATE_ARCH || nativeArch(),
		baseUrl: process.env.METIS_UPDATE_BASE_URL || DEFAULT_BASE_URL,
		bucket: process.env.METIS_OSS_BUCKET || DEFAULT_BUCKET,
		dmg: undefined,
		installer: undefined,
		dryRun: false,
		changelogFile: undefined,
		version: undefined,
	};
	while (rest.length > 0) {
		const flag = rest.shift();
		if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--platform") options.platform = rest.shift();
		else if (flag === "--arch") options.arch = rest.shift();
		else if (flag === "--base-url") options.baseUrl = rest.shift();
		else if (flag === "--bucket") options.bucket = rest.shift();
		else if (flag === "--dmg") options.dmg = rest.shift();
		else if (flag === "--installer") options.installer = rest.shift();
		else if (flag === "--changelog-file") options.changelogFile = rest.shift();
		else if (flag === "--version") options.version = rest.shift();
		else throw new Error(`Unknown argument: ${flag}`);
	}
	if (!options.arch) throw new Error("Missing --arch");
	options.changelogFile ??= path.join(desktopRoot, `changelog.${options.platform}.json`);
	return { command, options };
}

function usage() {
	return `Usage:
  node scripts/publish-update.mjs ls
  node scripts/publish-update.mjs publish --platform darwin [--arch arm64|x64] [--dmg path] [--changelog-file path] [--version x.y.z] [--dry-run]
  node scripts/publish-update.mjs publish --platform win32 --arch x64 [--installer path] [--changelog-file path] [--version x.y.z] [--dry-run]

Uploads <platform>/changelog.json, <platform>/<arch>/latest.json, and the release artifact to oss://metis-release with public-read.
The changelog defaults to packages/desktop/changelog.<platform>.json and must contain that platform's complete
newest-first history. Its first version must match the version being published. latest.json contains updater/download metadata only.
Requires ossutil on PATH or in OSSUTIL (credentials via \`ossutil config\`, never committed).
Packaged builds must set METIS_UPDATE_BASE_URL at make time (same HTTPS origin as --base-url).
`;
}

async function listBucket(options) {
	runOssutil(["ls", `oss://${options.bucket}/`]);
}

function uploadJsonNoCache(file, destination) {
	try {
		runOssutil(["cp", file, destination, "--acl", "public-read", "--cache-control", "no-cache", "-f"]);
	} catch {
		runOssutil(["cp", file, destination, "--acl", "public-read", "-f"]);
	}
}

async function publish(options) {
	const version = options.version ?? packageVersion();
	if (!STABLE_VERSION.test(version)) throw new Error(`Invalid desktop version: ${version}`);
	if (!["darwin", "win32"].includes(options.platform)) throw new Error(`Unsupported platform: ${options.platform}`);
	if (options.platform === "darwin" && !["arm64", "x64"].includes(options.arch)) {
		throw new Error(`Unsupported macOS arch: ${options.arch}`);
	}
	if (options.platform === "win32" && options.arch !== "x64") {
		throw new Error(`Unsupported Windows arch: ${options.arch}`);
	}
	if (options.dmg && options.installer) throw new Error("Choose either --dmg or --installer");
	if (options.platform === "darwin" && options.installer) throw new Error("--installer requires --platform win32");
	if (options.platform === "win32" && options.dmg) throw new Error("--dmg requires --platform darwin");
	const baseUrl = trustedBaseUrl(options.baseUrl);
	if (!baseUrl) {
		throw new Error("METIS_UPDATE_BASE_URL must be a credential-free https URL with no query or hash");
	}
	let changelog;
	try {
		changelog = normalizeChangelog(JSON.parse(readFileSync(path.resolve(options.changelogFile), "utf8")));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error("Invalid desktop changelog JSON");
		throw error;
	}
	if (changelog.releases[0].version !== version) {
		throw new Error(`Changelog latest version ${changelog.releases[0].version} does not match ${version}`);
	}
	const assetPath = options.platform === "darwin"
		? options.dmg ?? (await findDmg(version, options.arch))
		: options.installer ?? (await findWindowsInstaller(version, options.arch));
	const metadata = await stat(assetPath);
	if (!metadata.isFile()) throw new Error(`Not a file: ${assetPath}`);
	const sha256 = await fileSha256(assetPath);
	const { changelogKey, changelogUrl, assetObjectKey, manifestKey, assetUrl, manifestUrl } = releaseKeys(
		baseUrl,
		options.platform,
		options.arch,
		version,
	);
	const manifest = buildLatestManifest({ platform: options.platform, version, assetUrl, size: metadata.size, sha256 });
	assertClientAccepts(manifest, baseUrl, options.platform);
	const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
	const changelogText = `${JSON.stringify(changelog, null, "\t")}\n`;
	console.log(JSON.stringify({ asset: assetPath, size: metadata.size, sha256, changelogKey, assetObjectKey, manifestKey, changelogUrl, assetUrl }, null, 2));
	if (options.dryRun) {
		process.stdout.write(`${JSON.stringify({ latest: manifest, changelog }, null, "\t")}\n`);
		return;
	}
	const manifestFile = path.join(tmpdir(), `metis-latest-${version}.json`);
	const changelogFile = path.join(tmpdir(), `metis-changelog-${options.platform}-${version}.json`);
	await Promise.all([writeFile(manifestFile, manifestText), writeFile(changelogFile, changelogText)]);
	runOssutil(["cp", assetPath, `oss://${options.bucket}/${assetObjectKey}`, "--acl", "public-read", "-f"]);
	uploadJsonNoCache(changelogFile, `oss://${options.bucket}/${changelogKey}`);
	uploadJsonNoCache(manifestFile, `oss://${options.bucket}/${manifestKey}`);
	console.log(`Uploaded. Check: ${manifestUrl} and ${changelogUrl}`);
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
