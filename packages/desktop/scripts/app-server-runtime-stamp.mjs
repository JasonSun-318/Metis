/**
 * Freshness fingerprint for the desktop development app-server runtime.
 *
 * `prepare-app-server-runtime.mjs` rebuilds six packages before every
 * `electron-forge start/package`. Hashing the build inputs lets a repeated dev
 * start skip those rebuilds while staying conservative: any source, manifest,
 * tsconfig, lockfile, native-tools or prepare-script change produces a new
 * fingerprint and therefore a rebuild.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export const RUNTIME_STAMP_VERSION = 1;

function isTsconfig(name) {
	return /^tsconfig.*\.json$/u.test(name);
}

async function collectFiles(directory, files) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(path, files);
		} else if (entry.isFile()) {
			files.push(path);
		}
	}
}

export async function runtimeInputFiles({ packageDirectories, extraFiles }) {
	const files = [];
	for (const directory of packageDirectories) {
		files.push(join(directory, "package.json"));
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && isTsconfig(entry.name)) files.push(join(directory, entry.name));
		}
		await collectFiles(join(directory, "src"), files);
	}
	files.push(...extraFiles);
	files.sort();
	return files;
}

export async function runtimeInputFingerprint({ repoRoot, packageDirectories, extraFiles }) {
	const files = await runtimeInputFiles({ packageDirectories, extraFiles });
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(repoRoot, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return { fingerprint: hash.digest("hex"), fileCount: files.length };
}

export function runtimeStampPath(repoRoot) {
	return join(repoRoot, "node_modules", ".cache", "metis-desktop", "app-server-build.json");
}

export async function readRuntimeStamp(file) {
	try {
		const value = JSON.parse(await readFile(file, "utf8"));
		return value && value.version === RUNTIME_STAMP_VERSION ? value : undefined;
	} catch {
		return undefined;
	}
}

export function stampMatches(stamp, fingerprint, environment) {
	if (!stamp) return false;
	return (
		stamp.version === RUNTIME_STAMP_VERSION &&
		stamp.fingerprint === fingerprint &&
		stamp.platform === environment.platform &&
		stamp.arch === environment.arch &&
		stamp.nativeTarget === environment.nativeTarget
	);
}

export async function writeRuntimeStamp(file, stamp) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ version: RUNTIME_STAMP_VERSION, ...stamp }, null, "\t")}\n`);
}
