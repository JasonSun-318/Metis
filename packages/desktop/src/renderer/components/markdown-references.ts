import type { TokenizerExtension } from "marked";

export interface MarkdownReference {
	readonly reference: string;
	readonly kind: "wiki" | "markdown";
	readonly label: string;
	readonly width?: number;
	readonly height?: number;
}

/** Lexical only: resolving a file always belongs to its document's authorized reader. */
export const wikiReferenceExtension: TokenizerExtension = {
	name: "wikiReference",
	level: "inline",
	start: (source) => source.search(/!?\[\[/u),
	tokenizer(source) {
		const match = /^(!?)\[\[([^\]\n]+)\]\]/u.exec(source);
		if (!match) return;
		const [reference, ...labels] = match[2]!.split("|");
		if (!reference?.trim()) return;
		const label = labels.join("|");
		const dimensions = /^(\d{1,4})(?:x(\d{1,4}))?$/u.exec(label);
		return {
			type: "wikiReference",
			raw: match[0],
			reference: reference.trim(),
			kind: "wiki",
			embed: match[1] === "!",
			label: dimensions ? reference : label || reference,
			...(dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) || undefined } : {}),
		};
	},
};

export function isLocalMarkdownReference(reference: string): boolean {
	return !/^(?:[a-z][a-z\d+.-]*:|\/\/|[\\/])/iu.test(reference);
}
