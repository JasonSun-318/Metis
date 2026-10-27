import { posix } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export interface ParsedKnowledgeNote {
	title: string;
	aliases: string[];
	links: { target: string; kind: "wiki" | "markdown" }[];
}

/** Math delimiters are not links: pseudo wiki/Markdown syntax inside formulas must not create graph edges. */
function stripMath(text: string): string {
	const escaped = (position: number) => {
		let count = 0;
		for (let index = position - 1; index >= 0 && text[index] === "\\"; index--) count++;
		return count % 2 === 1;
	};
	let result = "";
	let lineStart = 0;
	for (let start = 0; start < text.length; ) {
		const blockStart = start - lineStart <= 3 && /^[ \t]{0,3}$/u.test(text.slice(lineStart, start));
		const opener = !escaped(start)
			? text.startsWith("$$", start)
				? "$$"
				: text.startsWith("\\[", start) && blockStart
					? "\\["
					: text.startsWith("\\(", start)
						? "\\("
						: text[start] === "$"
							? "$"
							: ""
			: "";
		const block = blockStart && (opener === "$$" || opener === "\\[");
		const closer = opener === "\\[" ? "\\]" : opener === "\\(" ? "\\)" : opener;
		let end = -1;
		if (opener && (block || opener === "\\(" || !/\s/u.test(text[start + opener.length] ?? " "))) {
			for (let index = start + opener.length; index < text.length; index++) {
				if (!block && text[index] === "\n") break;
				if (!text.startsWith(closer, index) || escaped(index)) continue;
				if (
					!block &&
					opener.startsWith("$") &&
					(/\s/u.test(text[index - 1] ?? " ") || /\d/u.test(text[index + closer.length] ?? ""))
				)
					break;
				end = index + closer.length;
				break;
			}
			if (block && end < 0) end = text.length;
		}
		if (end > start) {
			result += text.slice(start, end).replace(/[^\n]/gu, "");
			const newline = text.lastIndexOf("\n", end - 1);
			if (newline >= start) lineStart = newline + 1;
			start = end;
		} else {
			if (text[start] === "\n") lineStart = start + 1;
			result += text[start++];
		}
	}
	return result;
}

export function parseKnowledgeNote(path: string, content: string): ParsedKnowledgeNote {
	const { frontmatter, body } = parseFrontmatter(content);
	let fence: { marker: string; length: number } | undefined;
	const prose = stripMath(
		body
			.split("\n")
			.filter((line) => {
				const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
				if (!match) return !fence;
				if (!fence) fence = { marker: match[1][0], length: match[1].length };
				// A closing fence cannot carry an info string, so "```js" inside a block stays code.
				else if (match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim())
					fence = undefined;
				return false;
			})
			.join("\n")
			.replace(/%%[\s\S]*?%%/g, "")
			// Code spans never cross a blank line, so an unmatched backtick cannot swallow later paragraphs.
			.split(/\n[ \t]*\n/)
			.map((paragraph) => paragraph.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ""))
			.join("\n\n"),
	);
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
