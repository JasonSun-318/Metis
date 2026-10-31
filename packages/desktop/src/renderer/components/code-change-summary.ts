import type { CodeChangesView, CodeFileChangeView } from "@metis/app-protocol";
import { commandText, isCommandTool, type ToolCallBlock, type ToolResultBlock } from "./transcript-turn-model.ts";

export function codeFileName(path: string): string {
	return path.split(/[\\/]/u).at(-1) || path;
}

// Historical journals may lack binary flags, notably for empty resource files.
const NON_TEXT_FILE =
	/\.(?:png|jpe?g|gif|webp|avif|heic|ico|icns|rsrc|pdf|pptx?|docx?|xlsx?|zip|gz|bz2|xz|7z|rar|woff2?|ttf|otf|mp[34]|mov|wav|flac|sqlite3?|db|dylib|dll|exe|wasm)$/iu;

export function isTextCodeChange(file: CodeFileChangeView): boolean {
	return !file.binary && !NON_TEXT_FILE.test(file.path);
}

export function textCodeChanges(changes: CodeChangesView | undefined): CodeChangesView | undefined {
	if (!changes) return undefined;
	const files = changes.files.filter(isTextCodeChange);
	return files.length ? { ...changes, files } : undefined;
}

export function codeStepLabel(
	call: ToolCallBlock,
	result: ToolResultBlock | undefined,
	fallback: string,
	t: (key: string, values?: Record<string, unknown>) => string,
): string {
	const files = result?.codeChanges?.files.filter(isTextCodeChange);
	if (files?.length === 1) {
		const file = files[0]!;
		return t(
			file.kind === "added" ? "Created {{path}}" : file.kind === "deleted" ? "Deleted {{path}}" : "Updated {{path}}",
			{ path: codeFileName(file.path) },
		);
	}
	if (files?.length) return t("Changed {{count}} files", { count: files.length });
	if (isCommandTool(call.name)) {
		const command = commandText(call.inputPreview)?.replace(/\s+/gu, " ").trim();
		if (command)
			return t(call.state === "running" || call.state === "pending" ? "Running {{command}}" : "Ran {{command}}", {
				command,
			});
	}
	return fallback;
}

export interface CodeTextCounts {
	readonly additions?: number;
	readonly deletions?: number;
	readonly partial?: boolean;
}

export interface TurnFileChange {
	readonly file: CodeFileChangeView;
	readonly counts?: CodeTextCounts;
}

export function summarizeCodeChanges(
	snapshots: readonly CodeChangesView[],
): { readonly files: readonly TurnFileChange[]; readonly counts: CodeTextCounts } | undefined {
	if (!snapshots.length) return undefined;
	const ordered = [...snapshots].sort((a, b) => a.sequence - b.sequence);
	const latest = ordered.at(-1)!;
	const observed = new Map<string, { file: CodeFileChangeView; repeated: boolean }>();
	for (const snapshot of ordered)
		for (const file of snapshot.files.filter(isTextCodeChange)) {
			const previous = observed.get(file.path);
			observed.set(file.path, {
				file: { ...file, kind: previous?.file.kind === "added" && file.kind === "modified" ? "added" : file.kind },
				repeated: Boolean(previous),
			});
		}
	const source = latest.turnFiles?.filter(isTextCodeChange).map((file) => ({ file, repeated: false })) ?? [
		...observed.values(),
	];
	const files = source.map(
		({ file, repeated }): TurnFileChange => ({
			file,
			...(!repeated && !file.unavailable && file.additions !== undefined && file.deletions !== undefined
				? { counts: { additions: file.additions, deletions: file.deletions } }
				: {}),
		}),
	);
	// Old aggregate net counts remain valid when the turn only contains text files,
	// even though repeated edits cannot be assigned honest per-file net counts.
	const legacyTextOnly =
		latest.turnFiles === undefined && ordered.every((snapshot) => snapshot.files.every(isTextCodeChange));
	const known = files.filter((entry) => entry.counts);
	return {
		files,
		counts: legacyTextOnly
			? latest.turn
			: {
					...(known.length
						? {
								additions: known.reduce((sum, entry) => sum + entry.counts!.additions!, 0),
								deletions: known.reduce((sum, entry) => sum + entry.counts!.deletions!, 0),
							}
						: {}),
					partial: latest.turn.partial || known.length < files.length,
				},
	};
}
