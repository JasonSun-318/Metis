import { posix } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export interface ParsedKnowledgeNote {
	title: string;
	aliases: string[];
	links: { target: string; kind: "wiki" | "markdown" }[];
}

export function parseKnowledgeNote(path: string, content: string): ParsedKnowledgeNote {
	const { frontmatter, body } = parseFrontmatter(content);
	let fence: { marker: string; length: number } | undefined;
	const prose = body
		.split("\n")
		.filter((line) => {
			const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (match) {
				if (!fence) fence = { marker: match[1][0], length: match[1].length };
				else if (match[1][0] === fence.marker && match[1].length >= fence.length) fence = undefined;
				return false;
			}
			return !fence;
		})
		.join("\n")
		.replace(/%%[\s\S]*?%%/g, "")
		.replace(/(`+)[\s\S]*?\1/g, "");
	const links: ParsedKnowledgeNote["links"] = [...prose.matchAll(/!?\[\[([^\]\n]+)\]\]/g)].map((match) => ({
		target: match[1].split("|")[0].split("#")[0].trim(),
		kind: "wiki",
	}));
	for (const match of prose.matchAll(/(?<!!)\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
		if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(match[1])) {
			try {
				links.push({ target: decodeURIComponent(match[1].split("#")[0]), kind: "markdown" });
			} catch {
				links.push({ target: match[1].split("#")[0], kind: "markdown" });
			}
		}
	}
	const rawAliases = frontmatter.aliases;
	const seen = new Set<string>();
	return {
		title:
			typeof frontmatter.title === "string" && frontmatter.title.trim()
				? frontmatter.title
				: (/^#\s+(.+)$/m.exec(prose)?.[1] ?? posix.basename(path, posix.extname(path))),
		aliases: (Array.isArray(rawAliases) ? rawAliases : typeof rawAliases === "string" ? [rawAliases] : []).filter(
			(alias): alias is string => typeof alias === "string",
		),
		links: links.filter((link) => {
			const key = JSON.stringify([link.kind, link.target]);
			if (!link.target || seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	};
}

export function resolveKnowledgeLink(
	source: string,
	target: string,
	paths: ReadonlySet<string>,
	names: ReadonlyMap<string, readonly string[]>,
	kind: "wiki" | "markdown" = "wiki",
): string | null {
	const clean = target.replace(/\\/g, "/").replace(/^\//, "");
	const withExtension = /\.md$/i.test(clean) ? clean : `${clean}.md`;
	const local = posix.normalize(posix.join(posix.dirname(source), withExtension));
	const root = posix.normalize(withExtension);
	const lookupPath = (path: string): string | null => {
		if (paths.has(path)) return path;
		const key = path.replace(/\.md$/i, "");
		const matches = (names.get(key) ?? []).filter((candidate) => candidate.replace(/\.md$/i, "") === key);
		return matches.length === 1 ? matches[0] : null;
	};
	// Markdown destinations are relative to the source; wikilink paths are vault-relative.
	if (kind === "markdown" || /^\.{1,2}\//.test(clean)) return lookupPath(local);
	if (clean.includes("/") && lookupPath(root)) return lookupPath(root);
	if (lookupPath(local)) return lookupPath(local);
	if (paths.has(root)) return root;
	const key = clean.replace(/\.md$/i, "");
	const candidates = names.get(key) ?? [];
	return candidates.length === 1 ? candidates[0] : null;
}
