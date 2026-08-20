import { join } from "node:path";
import { canonicalizePathForCreation, encodePathForStorage } from "../../utils/paths.ts";
import type { AgentMode } from "../agent-mode.ts";
import { getAutoMemoryPaths, getAutoMemoryRoot } from "../auto-memory.ts";
import { ensureRealDirectoryDurablySync, replaceFileAtomicallySync } from "../durable-file.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { MemoryFact } from "./memory-types.ts";

const INDEX_SENTENCE_MAX = 120;

export interface RenderProjectionOptions {
	maxIndexLines?: number;
}

export interface ProjectionRenderResult {
	indexMarkdown: string;
	topicFiles: Map<string, string>;
	truncated: boolean;
	omittedTopicCount: number;
}

interface TopicGroup {
	topicFile: string;
	facts: MemoryFact[];
	latestCreatedAt: string;
}

export function renderProjection(
	facts: readonly MemoryFact[],
	options: RenderProjectionOptions = {},
): ProjectionRenderResult {
	const groups = groupByTopic(facts);
	groups.sort(
		(a, b) => compareIsoDesc(a.latestCreatedAt, b.latestCreatedAt) || a.topicFile.localeCompare(b.topicFile),
	);

	const topicFiles = new Map<string, string>();
	for (const group of groups) {
		topicFiles.set(group.topicFile, renderTopicFile(group.facts));
	}

	const maxIndexLines = options.maxIndexLines;
	const truncated = maxIndexLines !== undefined && groups.length > maxIndexLines;
	const visible = truncated ? groups.slice(0, maxIndexLines) : groups;
	const indexMarkdown = visible.map((group) => formatIndexLine(group)).join("\n");

	return {
		indexMarkdown,
		topicFiles,
		truncated,
		omittedTopicCount: truncated ? groups.length - visible.length : 0,
	};
}

export function writeProjection(agentDir: string, cwd: string, mode: AgentMode, store: MemoryStore): void {
	const cwdKey = encodePathForStorage(canonicalizePathForCreation(cwd));
	const paths = getAutoMemoryPaths(agentDir, cwd, mode);

	writeScopeProjection(getAutoMemoryRoot(agentDir), "MEMORY.md", store.listActiveFacts("global", null, null));
	writeScopeProjection(paths.project.directory, "project.md", store.listActiveFacts("project", cwdKey, mode));
}

function writeScopeProjection(directory: string, indexFile: string, facts: MemoryFact[]): void {
	const rendered = renderProjection(facts);
	if (rendered.topicFiles.size === 0 && rendered.indexMarkdown.length === 0) {
		return;
	}

	ensureRealDirectoryDurablySync(directory, 0o700);
	for (const [topicFile, content] of rendered.topicFiles) {
		replaceFileAtomicallySync(join(directory, topicFile), content.endsWith("\n") ? content : `${content}\n`, {
			mode: 0o600,
		});
	}
	replaceFileAtomicallySync(
		join(directory, indexFile),
		rendered.indexMarkdown.length === 0
			? ""
			: rendered.indexMarkdown.endsWith("\n")
				? rendered.indexMarkdown
				: `${rendered.indexMarkdown}\n`,
		{ mode: 0o600 },
	);
}

function groupByTopic(facts: readonly MemoryFact[]): TopicGroup[] {
	const byTopic = new Map<string, MemoryFact[]>();
	for (const fact of facts) {
		const list = byTopic.get(fact.topicFile);
		if (list) list.push(fact);
		else byTopic.set(fact.topicFile, [fact]);
	}

	const groups: TopicGroup[] = [];
	for (const [topicFile, topicFacts] of byTopic) {
		topicFacts.sort((a, b) => compareIsoAsc(a.createdAt, b.createdAt) || a.id.localeCompare(b.id));
		groups.push({
			topicFile,
			facts: topicFacts,
			latestCreatedAt: topicFacts[topicFacts.length - 1]!.createdAt,
		});
	}
	return groups;
}

function renderTopicFile(facts: readonly MemoryFact[]): string {
	return facts.map((fact) => fact.text).join("\n");
}

function formatIndexLine(group: TopicGroup): string {
	const sentence = buildRetrievalSentence(group.facts.map((fact) => fact.text));
	return `- [${group.topicFile}](${group.topicFile}) — ${sentence}`;
}

function buildRetrievalSentence(texts: readonly string[]): string {
	const joined = texts
		.map((text) => text.trim())
		.filter(Boolean)
		.join(" ");
	if (joined.length <= INDEX_SENTENCE_MAX) return joined;
	return joined.slice(0, INDEX_SENTENCE_MAX);
}

function compareIsoDesc(left: string, right: string): number {
	return right.localeCompare(left);
}

function compareIsoAsc(left: string, right: string): number {
	return left.localeCompare(right);
}
