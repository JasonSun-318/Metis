import type { CodeChangesView, CodeFileChangeView } from "@metis/app-protocol";
import {
	FileDiff as DiffViewer,
	type WorkerInitializationRenderOptions,
	WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type CodeTextCounts, codeFileName, isTextCodeChange } from "./code-change-summary.ts";
import { parseToolFileDiff } from "./tool-code-diff.ts";

const DIFF_OPTIONS: NonNullable<React.ComponentProps<typeof DiffViewer>["options"]> = {
	theme: { dark: "pierre-dark", light: "pierre-light" },
	diffStyle: "unified",
	disableFileHeader: true,
	diffIndicators: "bars",
	hunkSeparators: "simple",
	lineDiffType: "word-alt",
	overflow: "scroll",
	unsafeCSS: `
		[data-column-number] { --mix-dark: 80%; --mix-light: 88%; border-right: 0; }
		[data-indicators="bars"] [data-column-number][data-line-type="change-deletion"]::before {
			background-image: none; background-color: var(--diffs-deletion-base);
		}
	`,
};

const DIFF_WORKER_POOL = {
	poolSize: 2,
	totalASTLRUCacheSize: 24,
	workerFactory: () => new Worker(new URL("../workers/diff-worker.ts", import.meta.url), { type: "module" }),
};

const DIFF_HIGHLIGHTER: WorkerInitializationRenderOptions = {
	theme: DIFF_OPTIONS.theme,
	lineDiffType: "word-alt",
	langs: ["bash", "css", "html", "javascript", "json", "markdown", "python", "tsx", "typescript", "yaml"],
};

export function codeStepCounts(changes: CodeChangesView): CodeTextCounts {
	const files = changes.files.filter(isTextCodeChange);
	const counted = files.filter(
		(file) => !file.unavailable && file.additions !== undefined && file.deletions !== undefined,
	);
	return {
		...(counted.length > 0 || files.length === 0
			? {
					additions: counted.reduce((total, file) => total + file.additions!, 0),
					deletions: counted.reduce((total, file) => total + file.deletions!, 0),
				}
			: {}),
		partial: changes.partial || counted.length < files.length,
	};
}

export function CodeChangeCounts({
	counts,
	turn = false,
}: {
	readonly counts: CodeTextCounts;
	readonly turn?: boolean;
}) {
	const { t } = useTranslation();
	if (counts.additions === undefined || counts.deletions === undefined) return null;
	return (
		<span
			className={`code-change-counts${turn ? " code-turn-change-counts" : ""}`}
			title={t(
				counts.partial
					? "Recorded text changes; some text files or historical net counts are unavailable"
					: turn
						? "Net changes in this turn"
						: "Changes made by this step",
			)}
		>
			<span className="sr-only">
				{t("{{additions}} lines added, {{deletions}} lines removed", {
					additions: counts.additions,
					deletions: counts.deletions,
				})}
				{counts.partial
					? ` (${t("Recorded text changes; some text files or historical net counts are unavailable")})`
					: ""}
			</span>
			<span className="code-change-additions" aria-hidden="true">
				+{counts.additions}
			</span>
			<span className="code-change-deletions" aria-hidden="true">
				−{counts.deletions}
			</span>
		</span>
	);
}

function FileDiff({ file }: { readonly file: CodeFileChangeView }) {
	const { t } = useTranslation();
	const diff = useMemo(() => parseToolFileDiff(file), [file]);
	return (
		<div className="code-file-change">
			<div className="code-file-change-header">
				<span title={file.path}>{codeFileName(file.path)}</span>
			</div>
			{diff ? (
				<section className="code-file-diff" aria-label={t("Diff for {{path}}", { path: file.path })}>
					<DiffViewer fileDiff={diff} options={DIFF_OPTIONS} />
				</section>
			) : null}
			{(file.unavailable || file.truncated || !diff) && (
				<p className="code-diff-notice">
					{t(
						!file.unavailable && !diff && file.additions === 0 && file.deletions === 0
							? file.kind === "added"
								? "Created an empty file"
								: "No text line changes"
							: file.unavailable || (!diff && !file.truncated)
								? "Diff unavailable for this file"
								: "Diff preview truncated; line counts include the full change",
					)}
				</p>
			)}
		</div>
	);
}

export function ToolCodeChanges({ changes }: { readonly changes: CodeChangesView }) {
	return (
		<WorkerPoolContextProvider poolOptions={DIFF_WORKER_POOL} highlighterOptions={DIFF_HIGHLIGHTER}>
			<div className="code-tool-changes">
				{changes.files.filter(isTextCodeChange).map((file) => (
					<FileDiff key={file.path} file={file} />
				))}
			</div>
		</WorkerPoolContextProvider>
	);
}
