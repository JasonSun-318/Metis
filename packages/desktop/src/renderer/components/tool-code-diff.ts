import type { CodeFileChangeView } from "@metis/app-protocol";
import { type FileDiffMetadata, processFile } from "@pierre/diffs";

/** Keep only complete saved lines, with hunk sizes matching the bounded preview. */
function completePreview(patch: string): string {
	return patch
		.slice(0, patch.lastIndexOf("\n") + 1)
		.split(/(?=^@@ )/m)
		.map((section) => {
			const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@([^\n]*)\n/.exec(section);
			if (!header) return section;
			const body = section.slice(header[0].length);
			let additions = 0;
			let deletions = 0;
			for (const line of body.split("\n")) {
				if (line.startsWith("+") || line.startsWith(" ")) additions++;
				if (line.startsWith("-") || line.startsWith(" ")) deletions++;
			}
			return `@@ -${header[1]},${deletions} +${header[2]},${additions} @@${header[3]}\n${body}`;
		})
		.join("");
}

export function parseToolFileDiff(file: CodeFileChangeView): FileDiffMetadata | null {
	if (!file.diff) return null;
	try {
		const parsed = processFile(file.truncated ? completePreview(file.diff) : file.diff, {
			isGitDiff: false,
			throwOnError: true,
		});
		if (!parsed || parsed.hunks.length === 0) return null;
		return {
			...parsed,
			name: file.path,
			prevName: undefined,
			type: file.kind === "added" ? "new" : file.kind === "deleted" ? "deleted" : "change",
		};
	} catch {
		// Historical previews can be incomplete or invalid; retain counts and show a notice.
		return null;
	}
}
