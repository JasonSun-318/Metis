import type { TokenizerExtension } from "marked";

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/** HTML is displayed as source in Metis, including math/wiki-like content inside a literal element. */
export const literalInlineHtmlExtension: TokenizerExtension = {
	name: "literalInlineHtml",
	level: "inline",
	start: (source) => source.indexOf("<"),
	tokenizer(source) {
		const opening = /^<([a-z][a-z\d-]*)(?=[\s/>])[^>]*>/iu.exec(source);
		if (!opening || /\/>$/u.test(opening[0]) || VOID_TAGS.has(opening[1]!.toLowerCase())) return;
		const tags = new RegExp(`</?${opening[1]}(?=[\\s/>])[^>]*>`, "giu");
		tags.lastIndex = opening[0].length;
		let depth = 1;
		let end = source.length;
		for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
			if (tag[0].startsWith("</")) depth--;
			else if (!/\/>$/u.test(tag[0])) depth++;
			if (depth === 0) {
				end = tags.lastIndex;
				break;
			}
		}
		const raw = source.slice(0, end);
		return { type: "html", raw, text: raw, block: false };
	},
};
