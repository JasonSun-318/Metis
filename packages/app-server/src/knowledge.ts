import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ClientResult, KnowledgeLibrary } from "@metis/app-protocol";
import {
	parseKnowledgeNote,
	readKnowledgeCatalog,
	replaceFileAtomicallySync,
	resolveKnowledgeLink,
} from "@metis/coding-agent/host";
import { readKnowledgeFile } from "./knowledge-file.ts";
import { type KnowledgeNoteIndex, resolveKnowledgeResource } from "./knowledge-resource.ts";

const MAX_NOTE_BYTES = 4 * 1024 * 1024;
// A library is polled while visible, so a broad directory such as a home folder must not walk forever.
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SCAN_NOTES = 5_000;
const SKIP_DIRECTORIES = new Set(["node_modules", "vendor"]);
type ParsedNote = ReturnType<typeof parseKnowledgeNote>;
type WalkIndex = Awaited<ReturnType<KnowledgeService["walk"]>>;
// A visible library's graph scan refreshes every few seconds, so resolving one embedded
// note can reuse the recent index instead of walking thousands of notes again.
const INDEX_REUSE_MS = 5_000;
const ATTACHMENT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf"]);

export class KnowledgeService {
	private readonly agentDir: string;
	private readonly catalogPath: string;
	private readonly cache = new Map<string, { stamp: string; note: ParsedNote }>();
	private indexInFlight: { key: string; root: string; promise: Promise<WalkIndex> } | undefined;
	private indexCached: { key: string; root: string; at: number; value: WalkIndex } | undefined;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.catalogPath = join(agentDir, "knowledge-libraries.json");
	}

	list(): ClientResult<"knowledge/list"> {
		return { libraries: readKnowledgeCatalog(this.agentDir) ?? [] };
	}

	async register(path: string): Promise<KnowledgeLibrary> {
		if (!isAbsolute(path)) throw new Error("Knowledge directory must use a complete absolute path");
		const canonical = await realpath(path);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Knowledge path must be a directory");
		// Read after filesystem validation so concurrent registrations share the latest catalog.
		const { libraries } = this.list();
		const existing = libraries.find((item) => item.path === canonical);
		if (existing) return existing;
		const library = { id: randomUUID(), name: basename(canonical) || canonical, path: canonical };
		replaceFileAtomicallySync(this.catalogPath, JSON.stringify({ libraries: [...libraries, library] }, null, 2), {
			mode: 0o600,
		});
		return library;
	}

	/** Forget a directory without inspecting or modifying any of its files. */
	remove(id: string): ClientResult<"knowledge/remove"> {
		const current = this.list().libraries;
		const libraries = current.filter((library) => library.id !== id);
		if (libraries.length !== current.length) {
			replaceFileAtomicallySync(this.catalogPath, JSON.stringify({ libraries }, null, 2), { mode: 0o600 });
			this.cache.clear();
			this.indexCached = undefined;
		}
		return { libraries };
	}

	libraries(ids: readonly string[]): KnowledgeLibrary[] {
		const catalog = new Map(this.list().libraries.map((item) => [item.id, item]));
		return [...new Set(ids)].map((id) => {
			const library = catalog.get(id);
			if (!library) throw new Error("Knowledge directory is not registered");
			return library;
		});
	}

	private library(id: string): KnowledgeLibrary {
		return this.libraries([id])[0];
	}

	private async root(library: KnowledgeLibrary): Promise<string> {
		const root = await realpath(library.path);
		// Registration stores a canonical path. Replacing that root with a symlink grants no new directory.
		if (root !== library.path) throw new Error("Knowledge directory root has changed; register it again");
		return root;
	}

	async read(id: string, path: string): Promise<ClientResult<"knowledge/read">> {
		const library = this.library(id);
		const root = await this.root(library);
		const content = await this.readAt(root, path);
		// Confirm the registration survived the read so a removed id never delivers content.
		if (this.library(id).path !== library.path) throw new Error("Knowledge directory registration has changed");
		return { path, content };
	}

	private async readAt(root: string, path: string): Promise<string> {
		if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || !/\.md$/i.test(path))
			throw new Error("Invalid knowledge note path");
		const { bytes } = await readKnowledgeFile(root, path, MAX_NOTE_BYTES);
		return Buffer.from(bytes).toString("utf8");
	}

	/** Walks the library once, returning the live note index used by scans and reference resolution. */
	private async walk(id: string): Promise<
		KnowledgeNoteIndex & {
			notes: Map<string, ParsedNote>;
			names: Map<string, string[]>;
			warnings: string[];
		}
	> {
		const library = this.library(id);
		const root = await this.root(library);
		const notes = new Map<string, ParsedNote>();
		const live = new Set<string>();
		const warnings: string[] = [];
		let entries = 0;
		let truncated = false;
		const visit = async (directory: string): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (truncated) return;
				if (++entries > MAX_SCAN_ENTRIES) {
					truncated = true;
					return;
				}
				if (entry.name.startsWith(".")) continue;
				const absolute = join(directory, entry.name);
				const path = relative(root, absolute).split(sep).join("/");
				if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
					try {
						await visit(absolute);
					} catch (error) {
						warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
					}
				} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
					if (live.size >= MAX_SCAN_NOTES) {
						truncated = true;
						return;
					}
					live.add(absolute);
					try {
						const info = await stat(absolute);
						if (info.size > MAX_NOTE_BYTES) throw new Error("Markdown preview limit is 4 MiB");
						const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
						let cached = this.cache.get(absolute);
						if (cached?.stamp !== stamp) {
							const content = await this.readAt(root, path);
							cached = { stamp, note: parseKnowledgeNote(path, content) };
							this.cache.set(absolute, cached);
						}
						notes.set(path, cached.note);
					} catch (error) {
						warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
		};
		await visit(root);
		if (truncated) {
			warnings.push(
				`Scan stopped after ${MAX_SCAN_NOTES.toLocaleString("en-US")} notes or ${MAX_SCAN_ENTRIES.toLocaleString("en-US")} entries; choose a narrower directory`,
			);
		}
		// A truncated walk did not see every note, so it keeps cached entries it never reached.
		for (const path of truncated ? [] : this.cache.keys()) {
			const within = relative(root, path);
			if (!within.startsWith(`..${sep}`) && !isAbsolute(within) && !live.has(path)) this.cache.delete(path);
		}
		const paths = new Set(notes.keys());
		const names = new Map<string, string[]>();
		for (const [path, note] of notes) {
			for (const name of new Set([
				path.replace(/\.md$/i, ""),
				basename(path).replace(/\.md$/i, ""),
				...note.aliases,
			])) {
				names.set(name, [...(names.get(name) ?? []), path]);
			}
		}
		return { root, notes, paths, names, warnings };
	}

	async scan(id: string): Promise<ClientResult<"knowledge/scan">> {
		const index = await this.walk(id);
		this.library(id);
		this.indexCached = { key: id, root: index.root, at: Date.now(), value: index };
		const { notes, paths, names, warnings } = index;
		const projected = [...notes]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([path, note]) => ({
				path,
				title: note.title,
				links: note.links.map(({ target, kind }) => ({
					target,
					kind,
					path: resolveKnowledgeLink(path, target, paths, names, kind),
				})),
			}));
		const seen = new Set<string>();
		const edges: { source: string; target: string }[] = [];
		for (const note of projected)
			for (const link of note.links) {
				if (!link.path || link.path === note.path) continue;
				const key = JSON.stringify([note.path, link.path].sort());
				if (!seen.has(key)) {
					seen.add(key);
					edges.push({ source: note.path, target: link.path });
				}
			}
		return { notes: projected, edges, warnings };
	}

	/** Reuses the fresh scan index, coalescing concurrent walks for the same library. */
	private async acquireIndex(id: string, root: string): Promise<WalkIndex> {
		const cached = this.indexCached;
		if (cached && cached.key === id && cached.root === root && Date.now() - cached.at < INDEX_REUSE_MS)
			return cached.value;
		if (!this.indexInFlight || this.indexInFlight.key !== id || this.indexInFlight.root !== root) {
			const promise = this.walk(id).then((value) => {
				this.indexCached = { key: id, root, at: Date.now(), value };
				return value;
			});
			this.indexInFlight = { key: id, root, promise };
			// The cleanup chain swallows its own rejection; the original promise still rejects for callers.
			promise
				.then(
					() => undefined,
					() => undefined,
				)
				.then(() => {
					if (this.indexInFlight?.promise === promise) this.indexInFlight = undefined;
				});
		}
		return this.indexInFlight.promise;
	}

	/** Resolves one embedded reference against the current registration and note index. */
	async resolve(
		id: string,
		sourcePath: string,
		reference: string,
		kind: "wiki" | "markdown",
	): Promise<ClientResult<"knowledge/resource/resolve">> {
		// Re-check registration on every call so a removed library id is rejected even with a warm cache.
		const library = this.library(id);
		const root = await this.root(library);
		// Attachment references resolve by path only; they must not trigger a full note walk.
		const targetExt = (/\.([a-z\d]+)$/i.exec(reference.split("#")[0] ?? "")?.[1] ?? "").toLowerCase();
		const index: KnowledgeNoteIndex = ATTACHMENT_EXTENSIONS.has(targetExt)
			? { root, paths: new Set(), names: new Map() }
			: await this.acquireIndex(id, root);
		const resolved = await resolveKnowledgeResource({ library, index, sourcePath, reference, kind });
		// Final registration check so an id removed during resolution never resolves.
		if (this.library(id).path !== library.path) throw new Error("Knowledge directory registration has changed");
		return resolved;
	}
}
