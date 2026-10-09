import { isAbsolute } from "node:path";

export interface KnowledgeLibraryLink {
	readonly id: string;
	readonly name: string;
	readonly path: string;
}
export const KNOWLEDGE_LINKS_CUSTOM_TYPE = "metis.knowledge.links.v1";

export function readKnowledgeLinks(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): KnowledgeLibraryLink[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== KNOWLEDGE_LINKS_CUSTOM_TYPE) continue;
		const libraries = (entry.data as { libraries?: unknown } | undefined)?.libraries;
		if (!Array.isArray(libraries)) return [];
		return libraries.filter(
			(library): library is KnowledgeLibraryLink =>
				library !== null &&
				typeof library === "object" &&
				typeof library.id === "string" &&
				typeof library.name === "string" &&
				typeof library.path === "string" &&
				isAbsolute(library.path),
		);
	}
	return [];
}

const KNOWLEDGE_CONTEXT_PATTERN = /<knowledge_context>[\s\S]*?<\/knowledge_context>/g;
const LINKED_LIBRARY_LINE = /^\{"name":/m;

export function buildKnowledgeContext(libraries: readonly KnowledgeLibraryLink[]): string {
	return [
		"<knowledge_context>",
		...(libraries.length
			? [
					"当前对话已链接知识库（path 为完整绝对路径）：",
					...libraries.map(({ name, path }) => JSON.stringify({ name, path })),
					"请根据用户请求使用上述目录及其子目录。以最近一次 knowledge_context 为准，不从其他对话或侧边栏查看状态推断链接。",
				]
			: [
					"当前对话已取消链接知识库，知识库暂不可用。用户要求整理或查询知识库时，请提醒先在知识库侧边栏选择目录并链接到当前对话。",
				]),
		"知识库整理和查询请使用 knowledge skill。链接信息是工作上下文，沿用现有文件工具权限。",
		"</knowledge_context>",
	].join("\n");
}

/** Returns the newest knowledge context block still present in the model-visible messages. */
export function latestKnowledgeContext(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: unknown; hookContext?: unknown } | null;
		if (message?.role !== "user" || typeof message.hookContext !== "string") continue;
		const blocks = message.hookContext.match(KNOWLEDGE_CONTEXT_PATTERN);
		if (blocks) return blocks[blocks.length - 1];
	}
	return undefined;
}

/**
 * Attaches the knowledge block only when the links differ from the latest block the model can
 * still see. Earlier blocks stay in history, so skipping unchanged turns keeps the cached prefix
 * intact without repeating the same context on every message.
 */
export function appendKnowledgeContext(
	context: string | undefined,
	libraries: readonly KnowledgeLibraryLink[],
	messages: readonly unknown[],
): string | undefined {
	// Prepared durable prompts already contain the snapshot captured when accepted.
	if (context?.includes("<knowledge_context>")) return context;
	const knowledge = buildKnowledgeContext(libraries);
	const latest = latestKnowledgeContext(messages);
	// Older sessions repeated an "unlinked" block every turn; any block without libraries means unlinked.
	const unchanged =
		libraries.length === 0 ? latest === undefined || !LINKED_LIBRARY_LINE.test(latest) : latest === knowledge;
	if (unchanged) return context;
	return context ? `${context}\n\n${knowledge}` : knowledge;
}
