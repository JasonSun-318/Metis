import type { Token } from "marked";
import { lexMarkdownInline, markdownParser } from "./markdown-parser.ts";

export function markdownHeadingText(value: string): string {
	const text = (tokens: readonly Token[]): string =>
		tokens
			.map((token) =>
				"tokens" in token && token.tokens ? text(token.tokens) : String("text" in token ? token.text : token.raw),
			)
			.join("");
	return text(lexMarkdownInline(value)).trim();
}

export function stripMarkdownFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
}

export function markdownBlockId(token: Token): string | undefined {
	if (token.type === "paragraph" || token.type === "text") {
		// Code, math and links remain their own tokens, so their contents cannot define a block ID.
		const last = token.tokens?.at(-1);
		if (last && last.type !== "text") return;
		return /(?:^|[ \t])\^([\w-]+)[ \t]*\n?$/u.exec(last?.raw ?? token.raw)?.[1];
	}
	if (token.type === "blockquote") {
		const last = token.tokens?.filter((child) => child.type !== "space").at(-1);
		return last ? markdownBlockId(last) : undefined;
	}
	if (token.type === "list") {
		const last = token.items
			.at(-1)
			?.tokens.filter((child: Token) => child.type !== "space")
			.at(-1);
		return last ? markdownBlockId(last) : undefined;
	}
	return;
}

/** Select source blocks, never rendered DOM text. Duplicate locators are an explicit error. */
export function selectMarkdownFragment(content: string, fragment?: string): string {
	const source = stripMarkdownFrontmatter(content).replace(/\r\n?/gu, "\n");
	if (!fragment) return source;
	const locator = decodeURIComponent(fragment.replace(/^#/u, ""));
	const tokens = markdownParser.lexer(source);
	if (locator.startsWith("^")) {
		const matches: string[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (markdownBlockId(token) !== locator.slice(1)) continue;
			if (token.raw.trim() === locator) {
				let previous = index - 1;
				while (previous >= 0 && tokens[previous]!.type === "space") previous--;
				if (previous >= 0 && ["paragraph", "list", "blockquote"].includes(tokens[previous]!.type))
					matches.push(tokens[previous]!.raw);
			} else matches.push(token.raw.replace(new RegExp(`[ \\t]+\\^${locator.slice(1)}[ \\t]*(?=\\n*$)`, "u"), ""));
		}
		if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous block ID" : "Block ID was not found");
		return matches[0]!;
	}
	const matches = tokens.flatMap((token, index) =>
		token.type === "heading" && markdownHeadingText(token.text).toLocaleLowerCase() === locator.toLocaleLowerCase()
			? [index]
			: [],
	);
	if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous heading" : "Heading was not found");
	const start = matches[0]!;
	const heading = tokens[start]!;
	const depth = heading.type === "heading" ? heading.depth : 1;
	let end = start + 1;
	while (end < tokens.length) {
		const token = tokens[end]!;
		if (token.type === "heading" && token.depth <= depth) break;
		end++;
	}
	return tokens
		.slice(start, end)
		.map((token) => token.raw)
		.join("");
}

/** Display-only copies: cached token.raw and source positions remain authoritative. */
export function withoutMarkdownBlockId(token: Token, id: string): Token {
	if (token.type === "paragraph" || token.type === "text") {
		const strip = (text: string) => text.replace(new RegExp(`(?:^|[ \\t])\\^${id}[ \\t]*$`, "u"), "");
		const children = token.tokens ? [...token.tokens] : undefined;
		const last = children?.at(-1);
		if (last?.type === "text")
			children![children!.length - 1] = { ...last, text: strip(last.text), raw: strip(last.raw) };
		return { ...token, text: strip(token.text), ...(children ? { tokens: children } : {}) };
	}
	if (token.type === "blockquote") {
		const children = [...(token.tokens ?? [])];
		for (let index = children.length - 1; index >= 0; index--) {
			if (children[index]!.type === "space") continue;
			children[index] = withoutMarkdownBlockId(children[index]!, id);
			break;
		}
		return { ...token, tokens: children };
	}
	if (token.type === "list") {
		const items = token.items.map((item: import("marked").Tokens.ListItem, index: number) =>
			index === token.items.length - 1
				? {
						...item,
						tokens: item.tokens.map((child, childIndex) =>
							childIndex === item.tokens.length - 1 ? withoutMarkdownBlockId(child, id) : child,
						),
					}
				: item,
		);
		return { ...token, items };
	}
	return token;
}
