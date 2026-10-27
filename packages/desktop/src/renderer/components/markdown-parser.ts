import { Marked, type Token, type TokensList } from "marked";
import { literalInlineHtmlExtension } from "./markdown-literal-html.ts";
import { blockMathExtension, inlineMathExtension } from "./markdown-math.ts";
import { wikiReferenceExtension } from "./markdown-references.ts";

// Single private Marked instance for every parse path (incremental tail lex,
// inline lexing and the sourcePositions full lex). Extensions only produce
// tokens; HTML rendering stays with the React token dispatcher. Later phases
// (wiki links, embeds) register additional extensions on this same instance,
// so it is exported and must never be re-registered inside a render pass.
export const markdownParser = new Marked();
markdownParser.use({
	extensions: [blockMathExtension, inlineMathExtension, wikiReferenceExtension, literalInlineHtmlExtension],
});

export function lexMarkdown(text: string): Token[] {
	return markdownParser.lexer(text) as Token[];
}

export function lexMarkdownInline(text: string): Token[] {
	return markdownParser.Lexer.lexInline(text, markdownParser.defaults);
}

export function markdownDocumentDefSalt(tokens: readonly Token[]): string {
	const links = (tokens as TokensList).links;
	return links === undefined || Object.keys(links).length === 0 ? "" : JSON.stringify(links);
}

export type { Token, TokensList };
