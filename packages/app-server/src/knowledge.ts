import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ClientResult, KnowledgeLibrary } from "@metis/app-protocol";
import {
	parseKnowledgeNote,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	resolveKnowledgeLink,
} from "@metis/coding-agent/host";

const MAX_NOTE_BYTES = 4 * 1024 * 1024;
// A library is polled while visible, so a broad directory such as a home folder must not walk forever.
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SCAN_NOTES = 5_000;
const SKIP_DIRECTORIES = new Set(["node_modules", "vendor"]);
type ParsedNote = ReturnType<typeof parseKnowledgeNote>;

export class KnowledgeService {
	private readonly catalogPath: string;
	private readonly cache = new Map<string, { stamp: string; note: ParsedNote }>();

	constructor(agentDir: string) {
		this.catalogPath = join(agentDir, "knowledge-libraries.json");
	}

	list(): ClientResult<"knowledge/list"> {
		const content = readSingleLinkTextFileSync(this.catalogPath, { maxBytes: 4 * 1024 * 1024 });
		if (!content) return { libraries: [] };
		const data = JSON.parse(content) as { libraries?: KnowledgeLibrary[] };
		if (
			!Array.isArray(data.libraries) ||
			data.libraries.some(
				(item) =>
					!item ||
					typeof item.id !== "string" ||
					typeof item.name !== "string" ||
					typeof item.path !== "string" ||
					!isAbsolute(item.path),
			)
		)
			throw new Error("Invalid knowledge directory catalog");
		return { libraries: data.libraries };
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

	async read(id: string, path: string): Promise<ClientResult<"knowledge/read">> {
		const library = this.library(id);
		const root = await realpath(library.path);
		return { path, content: await this.readAt(root, path) };
	}

	private async readAt(root: string, path: string): Promise<string> {
		if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || !/\.md$/i.test(path))
			throw new Error("Invalid knowledge note path");
		const absolute = await realpath(join(root, path));
		const within = relative(root, absolute);
		if (within.startsWith(`..${sep}`) || within === ".." || isAbsolute(within))
			throw new Error("Note is outside the selected directory");
		const info = await stat(absolute);
		if (!info.isFile() || info.size > MAX_NOTE_BYTES)
			throw new Error("Note preview supports Markdown files up to 4 MiB");
		const content = await readFile(absolute, "utf8");
		if (Buffer.byteLength(content, "utf8") > MAX_NOTE_BYTES)
			throw new Error("Note preview supports Markdown files up to 4 MiB");
		return content;
	}

	async scan(id: string): Promise<ClientResult<"knowledge/scan">> {
		const library = this.library(id);
		const root = await realpath(library.path);
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
}
