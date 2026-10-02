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

export function buildKnowledgeContext(libraries: readonly KnowledgeLibraryLink[]): string {
	return [
		"<knowledge_context>",
		...(libraries.length
			? [
					"当前对话已链接知识库（path 为完整绝对路径）：",
					...libraries.map(({ name, path }) => JSON.stringify({ name, path })),
					"请根据用户请求使用上述目录及其子目录。以本轮上下文为准，不从其他对话或侧边栏查看状态推断链接。",
				]
			: [
					"当前对话未链接知识库，知识库暂不可用。用户要求整理或查询知识库时，请提醒先在知识库侧边栏选择目录并链接到当前对话。",
				]),
		"知识库整理和查询请使用 knowledge skill。链接信息是工作上下文，沿用现有文件工具权限。",
		"</knowledge_context>",
	].join("\n");
}

export function appendKnowledgeContext(
	context: string | undefined,
	libraries: readonly KnowledgeLibraryLink[],
): string {
	// Prepared durable prompts already contain the snapshot captured when accepted.
	if (context?.includes("<knowledge_context>")) return context;
	const knowledge = buildKnowledgeContext(libraries);
	return context ? `${context}\n\n${knowledge}` : knowledge;
}
