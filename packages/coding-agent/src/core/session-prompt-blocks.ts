/** Serialize prompt-embedded JSON without allowing quoted data to look like a tag. */
export function stringifyPromptJson(value: unknown, space?: number): string {
	return JSON.stringify(value, null, space).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/** Append one versioned strict prompt block; empty blocks leave the text untouched. */
export function formatVersionedPromptBlock(
	text: string,
	tag: "file_selections" | "conversation_quotes",
	instructions: string,
	itemKey: "files" | "quotes",
	items: readonly unknown[],
): string {
	if (items.length === 0) return text;
	const json = stringifyPromptJson({ version: 1, instructions, [itemKey]: items });
	return `${text}\n\n<${tag}>\n${json}\n</${tag}>`;
}

/**
 * Replace only well-formed blocks for one tag. Validation and replacement errors
 * preserve the original block, matching the strict file-selection and quote format.
 */
export function replaceVersionedPromptBlock<T>(
	text: string,
	tag: "file_selections" | "conversation_quotes",
	instructions: string,
	itemKey: "files" | "quotes",
	readItems: (value: unknown) => T[],
	replacement: (items: T[]) => string,
): string {
	const pattern = new RegExp(`<${tag}>\\n([^<]*)\\n</${tag}>`, "gu");
	return text.replace(pattern, (block, json: string) => {
		try {
			const parsed = JSON.parse(json);
			if (
				parsed.version !== 1 ||
				parsed.instructions !== instructions ||
				Object.keys(parsed).some((key) => !["version", "instructions", itemKey].includes(key))
			)
				return block;
			const items = readItems(parsed[itemKey]);
			if (items.length === 0) return block;
			return replacement(items);
		} catch {
			return block;
		}
	});
}
