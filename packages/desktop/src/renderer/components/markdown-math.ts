import type { TokenizerExtension } from "marked";

export const INLINE_MATH_TYPE = "inlineMath";
export const BLOCK_MATH_TYPE = "blockMath";

export interface MathToken {
	readonly type: typeof INLINE_MATH_TYPE | typeof BLOCK_MATH_TYPE;
	/** Verbatim source slice, including delimiters; tokens must tile the input. */
	readonly raw: string;
	/** TeX body without the delimiters. */
	readonly text: string;
	readonly displayMode: boolean;
	/** False while a block opener is still waiting for its closer. */
	readonly closed: boolean;
}

const INLINE_DOLLAR = "$";
const INLINE_PAREN_OPEN = "\\(";
const INLINE_PAREN_CLOSE = "\\)";
const BLOCK_DOLLAR = "$$";
const BLOCK_BRACKET_OPEN = "\\[";
const BLOCK_BRACKET_CLOSE = "\\]";

function inlineMathToken(raw: string, text: string, displayMode: boolean): MathToken {
	return { type: INLINE_MATH_TYPE, raw, text, displayMode, closed: true };
}

// Inline math is confined to a single line: the opener's inner side and the
// closer's inner side must both be non-blank, and a `$` directly followed by a
// digit is a price, not a closer — the candidate is rejected without scanning
// past it so later `$` signs cannot swallow the price text.
function tokenizeDollarInline(src: string): MathToken | undefined {
	const openLength = src.startsWith(BLOCK_DOLLAR) ? BLOCK_DOLLAR.length : INLINE_DOLLAR.length;
	const afterOpen = openLength;
	if (afterOpen >= src.length || /\s/u.test(src[afterOpen]!)) return undefined;
	const closerLength = openLength === BLOCK_DOLLAR.length ? BLOCK_DOLLAR.length : INLINE_DOLLAR.length;
	for (let index = afterOpen + 1; index < src.length; index += 1) {
		const char = src[index]!;
		if (char === "\n") return undefined;
		if (char !== INLINE_DOLLAR) continue;
		let backslashes = 0;
		for (let position = index - 1; position >= 0 && src[position] === "\\"; position--) backslashes++;
		if (backslashes % 2 === 1) continue;
		const end = index + closerLength;
		if (closerLength === 2 && src[end - 1] !== INLINE_DOLLAR) continue;
		// Reject the first invalid candidate. Skipping it could swallow a later real formula after a price.
		if (/\s/u.test(src[index - 1]!) || (end < src.length && /[0-9]/u.test(src[end]!))) return undefined;
		const raw = src.slice(0, end);
		return inlineMathToken(raw, raw.slice(afterOpen, index), closerLength === BLOCK_DOLLAR.length);
	}
	return undefined;
}

function tokenizeParenInline(src: string): MathToken | undefined {
	const close = src.indexOf(INLINE_PAREN_CLOSE, INLINE_PAREN_OPEN.length);
	if (close === -1) return undefined;
	const body = src.slice(INLINE_PAREN_OPEN.length, close);
	if (body.length === 0 || body.includes("\n")) return undefined;
	const raw = src.slice(0, close + INLINE_PAREN_CLOSE.length);
	return inlineMathToken(raw, body, false);
}

export const inlineMathExtension: TokenizerExtension = {
	name: INLINE_MATH_TYPE,
	level: "inline",
	start(src: string): number {
		const dollar = src.indexOf(INLINE_DOLLAR);
		const paren = src.indexOf(INLINE_PAREN_OPEN);
		if (dollar === -1) return paren;
		if (paren === -1) return dollar;
		return Math.min(dollar, paren);
	},
	tokenizer(src: string): MathToken | undefined {
		if (src.startsWith(INLINE_PAREN_OPEN)) return tokenizeParenInline(src);
		if (src.startsWith(INLINE_DOLLAR)) return tokenizeDollarInline(src);
		return undefined;
	},
};

// A legal block opener always yields a token, even unclosed: the pending token
// keeps the full remaining text as its raw so the token stream still tiles the
// input while a formula streams in, and only the closed form is typeset.
function tokenizeBlockMath(src: string): MathToken | undefined {
	const indentMatch = /^[ \t]{0,3}/u.exec(src);
	const bodyStart = indentMatch ? indentMatch[0].length : 0;
	let openLength: number;
	let closer: string;
	if (src.startsWith(BLOCK_DOLLAR, bodyStart)) {
		openLength = BLOCK_DOLLAR.length;
		closer = BLOCK_DOLLAR;
	} else if (src.startsWith(BLOCK_BRACKET_OPEN, bodyStart)) {
		openLength = BLOCK_BRACKET_OPEN.length;
		closer = BLOCK_BRACKET_CLOSE;
	} else {
		return undefined;
	}
	const contentStart = bodyStart + openLength;
	const closeIndex = src.indexOf(closer, contentStart);
	if (closeIndex === -1) {
		return {
			type: BLOCK_MATH_TYPE,
			raw: src,
			text: src.slice(contentStart),
			displayMode: true,
			closed: false,
		};
	}
	const contentEnd = closeIndex === contentStart ? contentStart : closeIndex;
	return {
		type: BLOCK_MATH_TYPE,
		raw: src.slice(0, closeIndex + closer.length),
		text: src.slice(contentStart, contentEnd),
		displayMode: true,
		closed: true,
	};
}

export const blockMathExtension: TokenizerExtension = {
	name: BLOCK_MATH_TYPE,
	level: "block",
	start(src: string): number | undefined {
		const match = /(?:^|\n)[ \t]{0,3}(?:\$\$|\\\[)/u.exec(src);
		return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
	},
	tokenizer(src: string): MathToken | undefined {
		return tokenizeBlockMath(src);
	},
};
