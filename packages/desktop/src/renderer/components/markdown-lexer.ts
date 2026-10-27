import type { Token } from "marked";
import { lexMarkdown, markdownDocumentDefSalt } from "./markdown-parser.ts";

export interface MarkdownLexCache {
	/** The exact text `tokens` were produced from. */
	readonly text: string;
	/** Top-level tokens; their raws tile `text` contiguously. */
	readonly tokens: readonly Token[];
	/** Start offset of each token inside `text`. */
	readonly blockStarts: readonly number[];
	/** Serialized link-definition state; "" when the document has none. */
	readonly defSalt: string;
}

export interface MarkdownLexResult {
	readonly tokens: readonly Token[];
	readonly cache: MarkdownLexCache | null;
	readonly defSalt: string;
}

function blockStartsOf(tokens: readonly Token[]): number[] {
	const starts = new Array<number>(tokens.length);
	let offset = 0;
	for (let index = 0; index < tokens.length; index += 1) {
		starts[index] = offset;
		offset += tokens[index]!.raw.length;
	}
	return starts;
}

function rawTextOf(tokens: readonly Token[]): string {
	return tokens.map((token) => token.raw).join("");
}

// Re-lexes the tail of an append-only change instead of the whole document.
// The window starts at the second-to-last cached block and walks toward the
// front until the first re-lexed token reproduces the cached token at that
// position (type + raw). A block can only extend over text that follows it —
// a paragraph becomes a setext heading under `===`, a pipe line becomes a
// table under its delimiter, a list merges over a blank line into the next
// items, an unclosed math opener grows into a pending token — so an anchor
// that survives proves the kept prefix still ends on the same boundary and
// everything after it re-lexed correctly. Registered link definitions can
// retro-linkify any earlier inline token, so a tail that registers one
// (top-level or nested) always falls back to a full lex.
function lexTail(text: string, cache: MarkdownLexCache): Token[] | null {
	if (cache.defSalt !== "") return null;
	const { tokens, blockStarts } = cache;
	for (let index = tokens.length - 2; index >= 0; index -= 1) {
		const source = text.slice(blockStarts[index]!);
		const tail = lexMarkdown(source);
		// Index zero re-lexes the whole text, which is the fallback itself.
		if (index === 0) return tail;
		if (tail.length === 0 || rawTextOf(tail) !== source || markdownDocumentDefSalt(tail) !== "") return null;
		const anchor = tokens[index]!;
		if (tail[0]!.type === anchor.type && tail[0]!.raw === anchor.raw) {
			return [...tokens.slice(0, index), ...tail];
		}
	}
	return null;
}

// Lexes `text`, splicing cached prefix tokens when the change is a provably
// safe append. `cache` is null on the next call when the token raws do not
// tile the text, which disables the tail path until a clean lex lands.
export function lexMarkdownBlocks(text: string, cache: MarkdownLexCache | null): MarkdownLexResult {
	if (cache && cache.text === text) return { tokens: cache.tokens, cache, defSalt: cache.defSalt };
	const tokens =
		cache && text.startsWith(cache.text) ? (lexTail(text, cache) ?? lexMarkdown(text)) : lexMarkdown(text);
	const tiled = rawTextOf(tokens) === text;
	const defSalt = markdownDocumentDefSalt(tokens);
	return {
		tokens,
		cache: tiled ? { text, tokens, blockStarts: blockStartsOf(tokens), defSalt } : null,
		defSalt,
	};
}
