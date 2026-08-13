import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { ClientParams, ClientResult, SkillSourceView } from "@metis/app-protocol";
import { CONFIG_DIR_NAME, getSkillsDir, parseFrontmatter, type Skill } from "@metis/coding-agent";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { AppServerError } from "./session-runtime-host.ts";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILL_FILES = 256;
const MAX_VISITED_DIRECTORIES = 1024;
const MAX_IMPORT_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_ENTRIES = 2048;
const MAX_IMPORT_CANDIDATES = 64;
const MAX_GITHUB_JSON_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_ROUTE_PARTS = 16;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MISSING_GITHUB_COMMIT_STATUS = new Set([404, 422]);

export interface SkillFileContext {
	readonly agentDir: string;
	readonly cwd: string | null;
	readonly skills: readonly Skill[];
}

function isInside(root: string, target: string): boolean {
	const path = relative(resolve(root), resolve(target));
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function isImmutableAsarSkill(path: string, source: SkillSourceView): boolean {
	return (
		source === "system" &&
		resolve(path)
			.split(sep)
			.some((segment) => segment.endsWith(".asar"))
	);
}

function sourceOf(skill: Skill): SkillSourceView | undefined {
	if (isInside(getSkillsDir(), skill.filePath)) return "system";
	return skill.sourceInfo.scope === "user" || skill.sourceInfo.scope === "project"
		? skill.sourceInfo.scope
		: undefined;
}

function findSkill(skills: readonly Skill[], source: SkillSourceView, name: string): Skill | undefined {
	return skills.find((skill) => skill.name === name && sourceOf(skill) === source);
}

export function publicSkills(skills: readonly Skill[]): ClientResult<"skill/list"> {
	return {
		skills: skills.slice(0, MAX_SKILL_FILES).map((skill) => {
			const source = sourceOf(skill);
			return { name: skill.name, description: skill.description, ...(source ? { source } : {}) };
		}),
	};
}

function fail(code: "CONFLICT" | "INVALID_REQUEST" | "NOT_FOUND" | "OPERATION_FAILED", requestId?: string): never {
	throw new AppServerError(code, requestId ? { requestId } : {});
}

async function readEntry(
	path: string,
	requestId?: string,
	immutable = false,
	maximum = MAX_SKILL_BYTES,
): Promise<{ bytes: Buffer; updatedAt: string }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const initial = await lstat(path, { bigint: true });
		if (!initial.isFile() || (!immutable && initial.nlink !== 1n) || initial.size > BigInt(maximum))
			fail("OPERATION_FAILED", requestId);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
		handle = await open(path, immutable ? "r" : constants.O_RDONLY | noFollow | nonBlocking);
		const opened = await handle.stat({ bigint: true });
		const current = await lstat(path, { bigint: true });
		assertFileSnapshot(path, immutable, initial, opened, current);
		const bytes = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const finalOpened = await handle.stat({ bigint: true });
		const finalCurrent = await lstat(path, { bigint: true });
		assertFileSnapshot(path, immutable, opened, finalOpened, finalCurrent);
		if (offset !== bytes.length) fail("OPERATION_FAILED", requestId);
		return { bytes, updatedAt: new Date(Number(opened.mtimeMs)).toISOString() };
	} catch (error) {
		if (error instanceof AppServerError) throw error;
		return fail("OPERATION_FAILED", requestId);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function assertFileSnapshot(path: string, immutable: boolean, ...snapshots: BigIntStats[]): void {
	const first = snapshots[0]!;
	if (immutable) {
		if (snapshots.some((snapshot) => !snapshot.isFile() || BigInt(snapshot.size) !== BigInt(first.size))) {
			throw new Error(`Refusing to read changing file: ${path}`);
		}
		return;
	}
	if (
		snapshots.some((snapshot) => !snapshot.isFile() || snapshot.nlink !== 1n) ||
		snapshots.some((snapshot) => snapshot.dev !== first.dev || snapshot.ino !== first.ino) ||
		snapshots.some(
			(snapshot) =>
				snapshot.size !== first.size || snapshot.mtimeNs !== first.mtimeNs || snapshot.ctimeNs !== first.ctimeNs,
		)
	) {
		throw new Error(`Refusing to read aliased, replaced, or changing file: ${path}`);
	}
}

function decode(bytes: Buffer, requestId?: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		fail("INVALID_REQUEST", requestId);
	}
}

function parseContent(name: string, content: string, requestId?: string) {
	if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) fail("INVALID_REQUEST", requestId);
	let parsed: ReturnType<typeof parseFrontmatter<{ name?: unknown; description?: unknown }>>;
	try {
		parsed = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
	} catch {
		fail("INVALID_REQUEST", requestId);
	}
	if (parsed.frontmatter.name !== name) fail("INVALID_REQUEST", requestId);
	if (
		typeof parsed.frontmatter.description !== "string" ||
		!parsed.frontmatter.description.trim() ||
		Buffer.byteLength(parsed.frontmatter.description, "utf8") > 1024 ||
		!parsed.body
	) {
		fail("INVALID_REQUEST", requestId);
	}
	return { description: parsed.frontmatter.description.trim(), instructions: parsed.body };
}

async function filesFor(skill: Skill): Promise<string[]> {
	if (basename(skill.filePath) !== "SKILL.md") return [basename(skill.filePath)];
	const files: string[] = [];
	const directories = [skill.baseDir];
	let visitedDirectories = 0;
	while (directories.length > 0 && files.length < MAX_SKILL_FILES && visitedDirectories < MAX_VISITED_DIRECTORIES) {
		const directory = directories.shift()!;
		visitedDirectories += 1;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			fail("OPERATION_FAILED");
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name === ".trash" || entry.isSymbolicLink()) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				directories.push(path);
			} else if (entry.isFile()) {
				files.push(relative(skill.baseDir, path).split(sep).join("/"));
				if (files.length === MAX_SKILL_FILES) break;
			}
		}
	}
	return files.sort();
}

export async function readSkillDetail(
	skills: readonly Skill[],
	input: ClientParams<"skill/get">,
): Promise<ClientResult<"skill/get">> {
	const skill = findSkill(skills, input.source, input.name);
	if (!skill) fail("NOT_FOUND");
	const { bytes, updatedAt } = await readEntry(
		skill.filePath,
		undefined,
		isImmutableAsarSkill(skill.filePath, input.source),
	);
	const content = decode(bytes);
	const parsed = parseContent(input.name, content);
	return {
		name: input.name,
		description: parsed.description,
		source: input.source,
		revision: createHash("sha256").update(bytes).digest("hex"),
		directoryPath: skill.baseDir,
		entryFile: basename(skill.filePath),
		files: await filesFor(skill),
		content,
		instructions: parsed.instructions,
		updatedAt,
		editable: input.source !== "system",
	};
}

function writableRoot(context: SkillFileContext, source: "user" | "project", requestId: string): string {
	if (source === "user") return join(context.agentDir, "skills");
	if (!context.cwd) fail("OPERATION_FAILED", requestId);
	return join(resolve(context.cwd), CONFIG_DIR_NAME, "skills");
}

async function assertDirectory(path: string, requestId: string): Promise<void> {
	try {
		const metadata = await lstat(path);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("OPERATION_FAILED", requestId);
	} catch (error) {
		if (error instanceof AppServerError) throw error;
		fail("OPERATION_FAILED", requestId);
	}
}

async function assertManagedEntry(root: string, skill: Skill, requestId: string): Promise<void> {
	if (
		!isInside(root, skill.filePath) ||
		!isInside(root, skill.baseDir) ||
		resolve(skill.baseDir) !== resolve(dirname(skill.filePath))
	) {
		fail("OPERATION_FAILED", requestId);
	}
	await assertDirectory(root, requestId);
	const relativeDirectory = relative(resolve(root), resolve(skill.baseDir));
	let cursor = resolve(root);
	for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
		cursor = join(cursor, segment);
		await assertDirectory(cursor, requestId);
	}
	try {
		const metadata = await lstat(skill.filePath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) fail("OPERATION_FAILED", requestId);
	} catch (error) {
		if (error instanceof AppServerError) throw error;
		fail("OPERATION_FAILED", requestId);
	}
}

export async function writeSkill(context: SkillFileContext, input: ClientParams<"skill/upsert">): Promise<void> {
	if (input.cwd !== context.cwd || !SKILL_NAME.test(input.name)) fail("INVALID_REQUEST", input.requestId);
	if (input.source !== "user" && input.source !== "project") fail("OPERATION_FAILED", input.requestId);
	parseContent(input.name, input.content, input.requestId);
	const root = writableRoot(context, input.source, input.requestId);
	const current = findSkill(context.skills, input.source, input.name);
	if (input.expectedRevision === null ? current !== undefined : current === undefined) {
		fail("CONFLICT", input.requestId);
	}

	let filePath: string;
	if (current) {
		await assertManagedEntry(root, current, input.requestId);
		const { bytes } = await readEntry(current.filePath, input.requestId);
		if (createHash("sha256").update(bytes).digest("hex") !== input.expectedRevision) {
			fail("CONFLICT", input.requestId);
		}
		filePath = current.filePath;
	} else {
		await mkdir(root, { recursive: true });
		await assertDirectory(root, input.requestId);
		const directory = join(root, input.name);
		try {
			await mkdir(directory);
		} catch {
			fail("CONFLICT", input.requestId);
		}
		filePath = join(directory, "SKILL.md");
	}

	const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(input.content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, filePath);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		if (error instanceof AppServerError) throw error;
		fail("OPERATION_FAILED", input.requestId);
	}
}

export async function trashSkill(context: SkillFileContext, input: ClientParams<"skill/remove">): Promise<void> {
	if (input.cwd !== context.cwd || !SKILL_NAME.test(input.name)) fail("INVALID_REQUEST", input.requestId);
	const root = writableRoot(context, input.source, input.requestId);
	const current = findSkill(context.skills, input.source, input.name);
	if (!current) fail("CONFLICT", input.requestId);
	await assertManagedEntry(root, current, input.requestId);
	const { bytes } = await readEntry(current.filePath, input.requestId);
	if (createHash("sha256").update(bytes).digest("hex") !== input.expectedRevision) {
		fail("CONFLICT", input.requestId);
	}
	const legacyFile = dirname(resolve(current.filePath)) === resolve(root);
	const sourcePath = legacyFile ? current.filePath : current.baseDir;
	if (resolve(sourcePath) === resolve(root)) fail("OPERATION_FAILED", input.requestId);
	const trashRoot = join(root, ".trash");
	await mkdir(trashRoot, { recursive: true });
	await assertDirectory(trashRoot, input.requestId);
	const suffix = legacyFile ? ".md" : "";
	const destination = join(trashRoot, `${Date.now()}-${randomUUID()}-${input.name}${suffix}`);
	try {
		await rename(sourcePath, destination);
	} catch {
		fail("OPERATION_FAILED", input.requestId);
	}
}

interface ImportedEntry {
	readonly path: string;
	readonly bytes: Buffer;
	readonly mode: 0o600 | 0o700;
}

interface ImportedCandidate {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly entries: readonly ImportedEntry[];
}

interface InspectedImport {
	readonly revision: string;
	readonly candidates: readonly ImportedCandidate[];
}

type FetchImplementation = typeof globalThis.fetch;

function validArchivePath(path: string): boolean {
	if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
	const parts = path.replace(/\/$/u, "").split("/");
	return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function regularZipEntry(entry: Entry): boolean {
	const directory = entry.fileName.endsWith("/");
	const madeBy = entry.versionMadeBy >>> 8;
	if (madeBy !== 3) return true;
	const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
	const kind = mode & 0o170000;
	return kind === 0 || kind === (directory ? 0o040000 : 0o100000);
}

function importedFileMode(entry: Entry): 0o600 | 0o700 {
	return entry.versionMadeBy >>> 8 === 3 && ((entry.externalFileAttributes >>> 16) & 0o111) !== 0 ? 0o700 : 0o600;
}

function openZip(bytes: Buffer): Promise<ZipFile> {
	return new Promise((resolveZip, reject) => {
		yauzl.fromBuffer(
			bytes,
			{ autoClose: false, decodeStrings: true, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, zip) => (error ? reject(error) : resolveZip(zip)),
		);
	});
}

function readZipEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
	return new Promise((resolveEntry, reject) => {
		zip.openReadStream(entry, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			stream.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > MAX_IMPORT_FILE_BYTES) stream.destroy(new Error("Skill import entry is too large"));
				else chunks.push(chunk);
			});
			stream.once("error", reject);
			stream.once("end", () => resolveEntry(Buffer.concat(chunks, bytes)));
		});
	});
}

async function archiveEntries(bytes: Buffer, stripRoot = false, skipNonRegular = false): Promise<ImportedEntry[]> {
	let zip: ZipFile | undefined;
	try {
		zip = await openZip(bytes);
		if (zip.entryCount < 1 || zip.entryCount > MAX_IMPORT_ENTRIES) fail("INVALID_REQUEST");
		const entries: ImportedEntry[] = [];
		let totalBytes = 0;
		await new Promise<void>((resolveEntries, reject) => {
			zip!.on("error", reject);
			zip!.on("end", resolveEntries);
			zip!.on("entry", (entry: Entry) => {
				void (async () => {
					if (!validArchivePath(entry.fileName) || entry.isEncrypted()) {
						throw new Error("Unsafe Skill archive entry");
					}
					if (!regularZipEntry(entry)) {
						if (!skipNonRegular) throw new Error("Unsafe Skill archive entry");
						zip!.readEntry();
						return;
					}
					if (entry.uncompressedSize > MAX_IMPORT_FILE_BYTES) throw new Error("Skill archive entry is too large");
					if (!entry.fileName.endsWith("/")) {
						totalBytes += entry.uncompressedSize;
						if (totalBytes > MAX_IMPORT_UNCOMPRESSED_BYTES) throw new Error("Skill archive is too large");
						entries.push({
							path: entry.fileName,
							bytes: await readZipEntry(zip!, entry),
							mode: importedFileMode(entry),
						});
					}
					zip!.readEntry();
				})().catch(reject);
			});
			zip!.readEntry();
		});
		if (!stripRoot) return entries;
		const roots = new Set(entries.map((entry) => entry.path.split("/")[0]));
		if (roots.size !== 1) fail("INVALID_REQUEST");
		return entries
			.map((entry) => ({ ...entry, path: entry.path.slice(entry.path.indexOf("/") + 1) }))
			.filter((entry) => entry.path);
	} catch (error) {
		if (error instanceof AppServerError) throw error;
		fail("INVALID_REQUEST");
	} finally {
		zip?.close();
	}
	throw new AppServerError("INVALID_REQUEST");
}

function importedCandidates(entries: readonly ImportedEntry[]): ImportedCandidate[] {
	const skillEntries = entries.filter((entry) => posix.basename(entry.path) === "SKILL.md");
	if (skillEntries.length < 1 || skillEntries.length > MAX_IMPORT_CANDIDATES) fail("INVALID_REQUEST");
	const roots = skillEntries.map((entry) => ({
		id: posix.dirname(entry.path) === "." ? "." : posix.dirname(entry.path),
		entry,
	}));
	const candidates = roots.map(({ id, entry }) => {
		const prefix = id === "." ? "" : `${id}/`;
		const owned = entries
			.filter((candidate) => {
				if (!candidate.path.startsWith(prefix)) return false;
				return !roots.some((other) => {
					if (other.id === id || other.id === ".") return false;
					return candidate.path.startsWith(`${other.id}/`) && other.id.startsWith(prefix);
				});
			})
			.map((candidate) => ({
				path: candidate.path.slice(prefix.length),
				bytes: candidate.bytes,
				mode: candidate.mode,
			}));
		const content = decode(entry.bytes);
		let parsed: ReturnType<typeof parseFrontmatter<{ name?: unknown; description?: unknown }>>;
		try {
			parsed = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
		} catch {
			fail("INVALID_REQUEST");
		}
		const name = parsed.frontmatter.name;
		if (typeof name !== "string" || !SKILL_NAME.test(name)) fail("INVALID_REQUEST");
		const validated = parseContent(name, content);
		return { id, name, description: validated.description, entries: owned };
	});
	if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) fail("INVALID_REQUEST");
	if (new Set(candidates.map((candidate) => candidate.name)).size !== candidates.length) fail("INVALID_REQUEST");
	return candidates;
}

async function inspectArchive(path: string): Promise<InspectedImport> {
	if (![".zip", ".skill"].includes(extname(path).toLowerCase())) fail("INVALID_REQUEST");
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(path);
	} catch {
		fail("OPERATION_FAILED");
	}
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		metadata.size < 1 ||
		metadata.size > MAX_IMPORT_SOURCE_BYTES
	) {
		fail("INVALID_REQUEST");
	}
	const { bytes } = await readEntry(path, undefined, false, MAX_IMPORT_SOURCE_BYTES);
	if (bytes.length !== metadata.size) fail("OPERATION_FAILED");
	return {
		revision: createHash("sha256").update(bytes).digest("hex"),
		candidates: importedCandidates(await archiveEntries(bytes)),
	};
}

interface GitHubSource {
	readonly owner: string;
	readonly repo: string;
	readonly route?: { readonly kind: "tree" | "blob"; readonly parts: readonly string[] };
}

function githubSource(value: string): GitHubSource {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail("INVALID_REQUEST");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		fail("INVALID_REQUEST");
	}
	const parts = url.pathname.split("/").filter(Boolean);
	const owner = parts[0];
	const repo = parts[1]?.replace(/\.git$/u, "");
	if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo))
		fail("INVALID_REQUEST");
	if (parts.length === 2) return { owner, repo };
	const kind = parts[2];
	const route = parts.slice(3);
	if ((kind !== "tree" && kind !== "blob") || route.length < 1 || !validArchivePath(route.join("/"))) {
		fail("INVALID_REQUEST");
	}
	return { owner, repo, route: { kind, parts: route } };
}

async function fetchBytes(
	fetchImpl: FetchImplementation,
	url: string,
	maximum: number,
	accept: string,
	missingStatuses?: ReadonlySet<number>,
): Promise<Buffer | undefined> {
	let response: Response | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			response = await fetchImpl(url, {
				redirect: "error",
				headers: { Accept: accept, "User-Agent": "Metis-Desktop" },
				signal: AbortSignal.timeout(60_000),
			});
		} catch {
			if (attempt === 1) fail("OPERATION_FAILED");
			await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
			continue;
		}
		if (attempt === 0 && RETRYABLE_HTTP_STATUS.has(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
			continue;
		}
		break;
	}
	if (response && missingStatuses?.has(response.status)) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	if (!response?.ok || !response.body) fail("OPERATION_FAILED");
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maximum) fail("INVALID_REQUEST");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				fail("INVALID_REQUEST");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, length);
}

async function fetchJson(fetchImpl: FetchImplementation, url: string): Promise<unknown> {
	const bytes = await fetchBytes(fetchImpl, url, MAX_GITHUB_JSON_BYTES, "application/vnd.github+json");
	if (!bytes) fail("OPERATION_FAILED");
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		fail("OPERATION_FAILED");
	}
}

async function fetchOptionalJson(fetchImpl: FetchImplementation, url: string): Promise<unknown | undefined> {
	const bytes = await fetchBytes(
		fetchImpl,
		url,
		MAX_GITHUB_JSON_BYTES,
		"application/vnd.github+json",
		MISSING_GITHUB_COMMIT_STATUS,
	);
	if (!bytes) return undefined;
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		fail("OPERATION_FAILED");
	}
}

async function inspectGithub(value: string, fetchImpl: FetchImplementation): Promise<InspectedImport> {
	const source = githubSource(value);
	const api = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
	let commit: string | undefined;
	let path = "";
	if (!source.route) {
		const repository = (await fetchJson(fetchImpl, api)) as { default_branch?: unknown };
		if (typeof repository.default_branch !== "string" || !repository.default_branch) fail("OPERATION_FAILED");
		const result = (await fetchJson(
			fetchImpl,
			`${api}/commits/${encodeURIComponent(repository.default_branch)}`,
		)) as { sha?: unknown };
		if (typeof result.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(result.sha)) fail("OPERATION_FAILED");
		commit = result.sha.toLowerCase();
	} else {
		if (source.route.parts.length > MAX_GITHUB_ROUTE_PARTS) fail("INVALID_REQUEST");
		for (let length = source.route.parts.length; length >= 1; length -= 1) {
			const ref = source.route.parts.slice(0, length).join("/");
			const result = (await fetchOptionalJson(fetchImpl, `${api}/commits/${encodeURIComponent(ref)}`)) as
				| { sha?: unknown }
				| undefined;
			if (!result) continue;
			if (typeof result.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(result.sha)) fail("OPERATION_FAILED");
			commit = result.sha.toLowerCase();
			path = source.route.parts.slice(length).join("/");
			if (source.route.kind === "blob" && posix.basename(path) === "SKILL.md") path = posix.dirname(path);
			if (path === ".") path = "";
			if (path && !validArchivePath(path)) fail("INVALID_REQUEST");
			break;
		}
	}
	if (!commit) fail("OPERATION_FAILED");
	const bytes = await fetchBytes(
		fetchImpl,
		`https://codeload.github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/zip/${commit}`,
		MAX_IMPORT_SOURCE_BYTES,
		"application/zip",
	);
	if (!bytes) fail("OPERATION_FAILED");
	const prefix = path ? `${path.replace(/\/$/u, "")}/` : "";
	const candidates = importedCandidates(
		(await archiveEntries(bytes, true, true)).filter((entry) => entry.path.startsWith(prefix)),
	);
	return {
		revision: createHash("sha256").update(`${source.owner}/${source.repo}@${commit}\0${path}`).digest("hex"),
		candidates,
	};
}

async function inspectImport(
	input: ClientParams<"skill/import/inspect">["input"],
	fetchImpl: FetchImplementation,
): Promise<InspectedImport> {
	return input.kind === "archive" ? await inspectArchive(input.path) : await inspectGithub(input.url, fetchImpl);
}

export async function inspectSkillImport(
	context: SkillFileContext,
	input: ClientParams<"skill/import/inspect">,
	fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<ClientResult<"skill/import/inspect">> {
	if (input.cwd !== context.cwd) fail("INVALID_REQUEST");
	const inspected = await inspectImport(input.input, fetchImpl);
	return {
		revision: inspected.revision,
		candidates: inspected.candidates.map((candidate) => ({
			id: candidate.id,
			name: candidate.name,
			description: candidate.description,
			fileCount: candidate.entries.length,
		})),
	};
}

async function entriesForImport(
	input: ClientParams<"skill/import">,
	fetchImpl: FetchImplementation,
): Promise<InspectedImport> {
	if (input.input.kind === "archive") return await inspectArchive(input.input.path);
	const inspected = await inspectGithub(input.input.url, fetchImpl);
	if (inspected.revision !== input.sourceRevision) fail("CONFLICT", input.requestId);
	return inspected;
}

export async function importSkills(
	context: SkillFileContext,
	input: ClientParams<"skill/import">,
	fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<void> {
	if (input.cwd !== context.cwd) fail("INVALID_REQUEST", input.requestId);
	const inspected = await entriesForImport(input, fetchImpl);
	if (inspected.revision !== input.sourceRevision) fail("CONFLICT", input.requestId);
	const byId = new Map(inspected.candidates.map((candidate) => [candidate.id, candidate]));
	const selected = input.candidateIds.map((id) => byId.get(id));
	if (selected.some((candidate) => candidate === undefined)) fail("CONFLICT", input.requestId);
	const candidates = selected as ImportedCandidate[];
	if (new Set(candidates.map((candidate) => candidate.name)).size !== candidates.length)
		fail("INVALID_REQUEST", input.requestId);
	if (candidates.some((candidate) => findSkill(context.skills, input.source, candidate.name)))
		fail("CONFLICT", input.requestId);
	const root = writableRoot(context, input.source, input.requestId);
	await mkdir(root, { recursive: true });
	await assertDirectory(root, input.requestId);
	const assertMissing = async (path: string) => {
		try {
			await lstat(path);
			fail("CONFLICT", input.requestId);
		} catch (error) {
			if (error instanceof AppServerError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("OPERATION_FAILED", input.requestId);
		}
	};
	for (const candidate of candidates) await assertMissing(join(root, candidate.name));
	const staging: string[] = [];
	const installed: string[] = [];
	try {
		for (const candidate of candidates) {
			const temporary = join(root, `.import-${randomUUID()}`);
			staging.push(temporary);
			await mkdir(temporary);
			for (const entry of candidate.entries) {
				if (!validArchivePath(entry.path)) fail("INVALID_REQUEST", input.requestId);
				const target = join(temporary, ...entry.path.split("/"));
				if (!isInside(temporary, target)) fail("INVALID_REQUEST", input.requestId);
				await mkdir(dirname(target), { recursive: true });
				const handle = await open(target, "wx", entry.mode);
				try {
					await handle.writeFile(entry.bytes);
					await handle.sync();
				} finally {
					await handle.close();
				}
			}
			const destination = join(root, candidate.name);
			await assertMissing(destination);
			await rename(temporary, destination);
			staging.splice(staging.indexOf(temporary), 1);
			installed.push(destination);
		}
	} catch (error) {
		await Promise.all(
			[...staging, ...installed].map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)),
		);
		if (error instanceof AppServerError) throw error;
		fail("OPERATION_FAILED", input.requestId);
	}
}
