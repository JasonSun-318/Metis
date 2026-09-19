import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type ContextReplacement,
	type ContextRewriteBatch,
	type ContextSource,
	ContextViewError,
	getContextSourceDigest,
} from "./context-view.ts";
import {
	formatContextArtifactReference,
	parseContextArtifactReference,
	restoreContextArtifact,
} from "./large-tool-output.ts";

/** Keep verification bounded to the active view, and rehash whenever file identity or metadata changes. */
export class ContextArtifactReplay {
	private verified = new Map<string, string>();

	private stamp(path: string): string | undefined {
		try {
			const directory = lstatSync(dirname(path));
			const file = lstatSync(path);
			if (!directory.isDirectory() || !file.isFile() || file.nlink !== 1) return undefined;
			return [
				directory.dev,
				directory.ino,
				directory.ctimeMs,
				file.dev,
				file.ino,
				file.size,
				file.mtimeMs,
				file.ctimeMs,
			].join(":");
		} catch {
			return undefined;
		}
	}

	async prepare(
		outputDir: string,
		sources: readonly ContextSource[],
		batches: readonly ContextRewriteBatch[],
		signal?: AbortSignal,
	): Promise<ContextReplacement[]> {
		const byId = new Map(sources.map((source) => [source.entryId, source.message]));
		const latest = new Map<string, ContextReplacement>();
		for (const batch of batches)
			for (const replacement of batch.replacements) latest.set(replacement.sourceEntryId, replacement);
		const verified = new Map<string, string>();
		const repairs: ContextReplacement[] = [];
		for (const replacement of latest.values()) {
			const message = byId.get(replacement.sourceEntryId);
			if (message?.role !== "toolResult" || getContextSourceDigest(message) !== replacement.sourceDigest) continue;
			signal?.throwIfAborted();
			const oldPath = parseContextArtifactReference(replacement.content);
			if (!oldPath || !isAbsolute(oldPath) || basename(oldPath) !== replacement.artifactRelativePath) {
				throw new ContextViewError(
					"invalid-record",
					"Context artifact reference does not match its recorded file name",
				);
			}
			const path = join(outputDir, replacement.artifactRelativePath);
			const key = `${path}\0${replacement.artifactDigest}\0${replacement.artifactBytes}`;
			let stamp = this.stamp(path);
			if (stamp === undefined || this.verified.get(key) !== stamp) {
				const artifact = {
					absolutePath: oldPath,
					relativePath: replacement.artifactRelativePath,
					digest: replacement.artifactDigest,
					bytes: replacement.artifactBytes,
				};
				let ready = await restoreContextArtifact(outputDir, artifact, undefined, signal);
				const details = message.details as { fullOutputPath?: unknown } | undefined;
				const recoveries: Array<{ sourcePath: string } | { text: string }> = [];
				if (resolve(oldPath) !== resolve(path)) recoveries.push({ sourcePath: oldPath });
				if (typeof details?.fullOutputPath === "string") recoveries.push({ sourcePath: details.fullOutputPath });
				if (message.content.every((block) => block.type === "text"))
					recoveries.push({
						text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
					});
				for (const recover of recoveries) {
					if (ready === "ready") break;
					ready = await restoreContextArtifact(outputDir, artifact, recover, signal);
				}
				if (ready !== "ready")
					throw new ContextViewError(
						"artifact-unavailable",
						`Saved tool result is unavailable or changed: ${path}. Restore the original artifact before continuing.`,
					);
				stamp = this.stamp(path);
			}
			if (stamp !== undefined) verified.set(key, stamp);
			if (resolve(oldPath) !== resolve(path))
				repairs.push({
					...replacement,
					content: replacement.content.map((block) => ({
						...block,
						text: block.text.replace(
							formatContextArtifactReference(oldPath),
							formatContextArtifactReference(path),
						),
					})),
				});
		}
		this.verified = verified;
		return repairs;
	}
}
