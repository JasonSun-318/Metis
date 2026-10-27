import { isAbsolute, join } from "node:path";
import { readSingleLinkTextFileSync } from "./durable-file.ts";
import type { KnowledgeLibraryLink } from "./knowledge-context.ts";

/** Missing catalogs retain compatibility with hosts that only persist conversation links. */
export function readKnowledgeCatalog(agentDir: string): KnowledgeLibraryLink[] | undefined {
	const content = readSingleLinkTextFileSync(join(agentDir, "knowledge-libraries.json"), {
		maxBytes: 4 * 1024 * 1024,
	});
	if (content === undefined) return undefined;
	const data = JSON.parse(content) as { libraries?: KnowledgeLibraryLink[] };
	if (
		!data ||
		!Array.isArray(data.libraries) ||
		data.libraries.some(
			(library) =>
				!library ||
				typeof library.id !== "string" ||
				typeof library.name !== "string" ||
				typeof library.path !== "string" ||
				!isAbsolute(library.path),
		)
	)
		throw new Error("Invalid knowledge directory catalog");
	return data.libraries;
}
