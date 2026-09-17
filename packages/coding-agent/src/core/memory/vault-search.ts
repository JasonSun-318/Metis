import { readdirSync, statSync } from "node:fs";
import type { MemoryVault } from "./vault.ts";
import { memoryUsageKey } from "./vault-identity.ts";
import { getNotesDir, getScopeDir } from "./vault-paths.ts";
import { isSafeSlug, MEMORY_SCOPES, type MemoryScope, type Note, type NoteType } from "./vault-types.ts";
import { readUsage, recordUsage } from "./vault-usage.ts";

export interface SearchHit {
	slug: string;
	scope: MemoryScope;
	type: NoteType;
	name: string;
	description: string;
	snippet: string;
	score: number;
	updated: string;
}

/** A note flattened into per-field token lists for ranking. */
export interface IndexedNote {
	slug: string;
	scope: MemoryScope;
	note: Note;
	fields: {
		name: string[];
		aliases: string[];
		description: string[];
		body: string[];
	};
}

export interface Ranker {
	rank(query: string, candidates: IndexedNote[]): Array<{ note: IndexedNote; score: number }>;
}

/** NFKC + en-US lowercase + [\p{L}\p{N}] words + Han bigrams. */
export function memoryTokens(text: string): string[] {
	const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
	const tokens: string[] = [...(normalized.match(/[\p{L}\p{N}]+/gu) ?? [])];
	for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
		const chars = Array.from(run);
		for (let index = 0; index + 1 < chars.length; index++) {
			tokens.push(`${chars[index]}${chars[index + 1]}`);
		}
	}
	return tokens;
}

const FIELD_WEIGHTS = { name: 3, aliases: 3, description: 2, body: 1 } as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DECAY_HALF_LIFE_DAYS = 180;
const DECAY_FLOOR = 0.5;
const USAGE_WEIGHT = 0.1;
const SNIPPET_CHARS = 200;

/** In-memory BM25 over field-weighted term frequencies. */
export class BM25Ranker implements Ranker {
	rank(query: string, candidates: IndexedNote[]): Array<{ note: IndexedNote; score: number }> {
		const queryTokens = [...new Set(memoryTokens(query))];
		if (queryTokens.length === 0 || candidates.length === 0) return [];

		const docTokens = candidates.map((candidate) => {
			const weighted: string[] = [];
			for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as Array<[keyof typeof FIELD_WEIGHTS, number]>) {
				const tokens = candidate.fields[field];
				for (let index = 0; index < weight; index++) weighted.push(...tokens);
			}
			return weighted;
		});

		const documentFrequency = new Map<string, number>();
		for (const tokens of docTokens) {
			for (const token of new Set(tokens)) {
				documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
			}
		}
		const averageLength = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / candidates.length || 1;

		const scored: Array<{ note: IndexedNote; score: number }> = [];
		for (let index = 0; index < candidates.length; index++) {
			const tokens = docTokens[index]!;
			const frequencies = new Map<string, number>();
			for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			let score = 0;
			for (const token of queryTokens) {
				const tf = frequencies.get(token) ?? 0;
				if (tf === 0) continue;
				const df = documentFrequency.get(token) ?? 0;
				const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
				score +=
					(idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / averageLength));
			}
			if (score > 0) scored.push({ note: candidates[index]!, score });
		}
		return scored;
	}
}

interface FileStamp {
	mtimeMs: number;
	size: number;
}

function pickSnippet(body: string, queryTokens: string[]): string {
	const paragraphs = body.split(/\n{2,}/u).filter((paragraph) => paragraph.trim().length > 0);
	if (paragraphs.length === 0) return "";
	let best = paragraphs[0]!;
	let bestHits = -1;
	for (const paragraph of paragraphs) {
		const tokens = new Set(memoryTokens(paragraph));
		let hits = 0;
		for (const token of queryTokens) if (tokens.has(token)) hits++;
		if (hits > bestHits) {
			bestHits = hits;
			best = paragraph;
		}
	}
	const trimmed = best.trim();
	const chars = [...trimmed];
	return chars.length <= SNIPPET_CHARS ? trimmed : `${chars.slice(0, SNIPPET_CHARS - 1).join("")}…`;
}

function recencyDecay(updated: string, nowMs: number): number {
	const updatedMs = Date.parse(updated);
	if (Number.isNaN(updatedMs)) return DECAY_FLOOR;
	const ageDays = Math.max(0, (nowMs - updatedMs) / (24 * 60 * 60 * 1000));
	return Math.max(DECAY_FLOOR, 2 ** (-ageDays / DECAY_HALF_LIFE_DAYS));
}

export class MemorySearchIndex {
	private readonly vault: MemoryVault;
	private readonly ranker: Ranker;
	private readonly stamps = new Map<string, FileStamp>();
	private readonly notes = new Map<string, IndexedNote>();
	private pendingUsage: Promise<void> = Promise.resolve();

	constructor(vault: MemoryVault, ranker: Ranker = new BM25Ranker()) {
		this.vault = vault;
		this.ranker = ranker;
	}

	/** Incremental refresh: re-read notes whose mtime/size changed. */
	private refresh(): void {
		const seen = new Set<string>();
		for (const scope of MEMORY_SCOPES) {
			if (!this.vault.hasScope(scope)) continue;
			const scopeDir = getScopeDir(this.vault.root, scope, this.vault.project?.projectKey);
			const notesDir = getNotesDir(scopeDir);
			let files: string[];
			try {
				files = readdirSync(notesDir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.endsWith(".md")) continue;
				const slug = file.slice(0, -3);
				if (!isSafeSlug(slug)) continue;
				const key = `${scope}/${slug}`;
				seen.add(key);
				let stamp: FileStamp;
				try {
					const stats = statSync(`${notesDir}/${file}`);
					stamp = { mtimeMs: stats.mtimeMs, size: stats.size };
				} catch {
					continue;
				}
				const previous = this.stamps.get(key);
				if (previous && previous.mtimeMs === stamp.mtimeMs && previous.size === stamp.size) continue;
				const note = this.vault.readNote(scope, slug);
				if (!note) continue;
				this.stamps.set(key, stamp);
				this.notes.set(key, {
					slug,
					scope,
					note,
					fields: {
						name: memoryTokens(note.frontmatter.name),
						aliases: memoryTokens((note.frontmatter.aliases ?? []).join(" ")),
						description: memoryTokens(note.frontmatter.description),
						body: memoryTokens(note.body),
					},
				});
			}
		}
		for (const key of [...this.notes.keys()]) {
			if (!seen.has(key)) {
				this.notes.delete(key);
				this.stamps.delete(key);
			}
		}
	}

	search(
		query: string,
		opts: { scope?: MemoryScope | "all"; type?: NoteType; limit?: number; recordUsage?: boolean } = {},
	): SearchHit[] {
		this.refresh();
		const scope = opts.scope ?? "all";
		const candidates = [...this.notes.values()].filter(
			(indexed) =>
				(scope === "all" || indexed.scope === scope) &&
				(opts.type === undefined || indexed.note.frontmatter.type === opts.type),
		);
		const usage = readUsage(this.vault.root);
		const nowMs = Date.now();
		const hits = this.ranker
			.rank(query, candidates)
			.map(({ note, score }) => {
				const key = memoryUsageKey(note.scope, note.slug, this.vault.project?.projectKey);
				const useCount = usage[key]?.useCount ?? 0;
				const finalScore =
					score * recencyDecay(note.note.frontmatter.updated, nowMs) + Math.log1p(useCount) * USAGE_WEIGHT;
				return {
					slug: note.slug,
					scope: note.scope,
					type: note.note.frontmatter.type,
					name: note.note.frontmatter.name,
					description: note.note.frontmatter.description,
					snippet: pickSnippet(note.note.body, memoryTokens(query)),
					score: finalScore,
					updated: note.note.frontmatter.updated,
				};
			})
			.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
			.slice(0, opts.limit ?? 8);

		if (opts.recordUsage !== false && hits.length > 0) {
			// Best effort: a usage write must never break a search.
			this.pendingUsage = this.pendingUsage
				.then(() =>
					recordUsage(
						this.vault.root,
						hits.map((hit) => memoryUsageKey(hit.scope, hit.slug, this.vault.project?.projectKey)),
					),
				)
				.catch(() => {});
		}
		return hits;
	}

	/** Resolves once the queued usage write for previous searches has settled. */
	async whenIdle(): Promise<void> {
		await this.pendingUsage;
	}
}
