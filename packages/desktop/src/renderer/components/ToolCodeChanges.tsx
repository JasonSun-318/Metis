import type { CodeChangesView, CodeFileChangeView } from "@metis/app-protocol";
import {
	FileDiff as DiffViewer,
	type WorkerInitializationRenderOptions,
	WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseToolFileDiff } from "./tool-code-diff.ts";

const DIFF_OPTIONS: NonNullable<React.ComponentProps<typeof DiffViewer>["options"]> = {
	theme: { dark: "pierre-dark", light: "pierre-light" },
	diffStyle: "unified",
	disableFileHeader: true,
	diffIndicators: "bars",
	hunkSeparators: "simple",
	lineDiffType: "word-alt",
	overflow: "scroll",
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

interface ChangeCounts {
	readonly additions?: number;
	readonly deletions?: number;
	readonly partial?: boolean;
}

export function codeStepCounts(changes: CodeChangesView): ChangeCounts {
	const counted = changes.files.filter((file) => file.additions !== undefined && file.deletions !== undefined);
	return {
		...(counted.length > 0 || changes.files.length === 0
			? {
					additions: counted.reduce((total, file) => total + file.additions!, 0),
					deletions: counted.reduce((total, file) => total + file.deletions!, 0),
				}
			: {}),
		partial: changes.partial || counted.length < changes.files.length,
	};
}

export function CodeChangeCounts({ counts, turn = false }: { readonly counts: ChangeCounts; readonly turn?: boolean }) {
	const { t } = useTranslation();
	return (
		<span
			className={`code-change-counts${turn ? " code-turn-change-counts" : ""}`}
			title={t(
				counts.partial
					? "Some file changes could not be counted"
					: turn
						? "Net changes in this turn"
						: "Changes made by this step",
			)}
		>
			<span className="sr-only">
				{t("{{additions}} lines added, {{deletions}} lines removed", {
					additions: counts.additions ?? "—",
					deletions: counts.deletions ?? "—",
				})}
				{counts.partial ? ` (${t("Some file changes could not be counted")})` : ""}
			</span>
			<span className="code-change-additions" aria-hidden="true">
				+{counts.additions ?? "—"}
			</span>
			<span className="code-change-deletions" aria-hidden="true">
				−{counts.deletions ?? "—"}
			</span>
			{counts.partial && (
				<span className="code-change-incomplete" aria-hidden="true">
					*
				</span>
			)}
		</span>
	);
}

function FileDiff({ file }: { readonly file: CodeFileChangeView }) {
	const { t } = useTranslation();
	const diff = useMemo(() => parseToolFileDiff(file), [file]);
	return (
		<div className="code-file-change">
			<div className="code-file-change-header">
				<span title={file.path}>{file.path}</span>
				<CodeChangeCounts counts={file} />
			</div>
			{diff ? (
				<section className="code-file-diff" aria-label={t("Diff for {{path}}", { path: file.path })}>
					<DiffViewer fileDiff={diff} options={DIFF_OPTIONS} />
				</section>
			) : null}
			{(file.binary || file.unavailable || file.truncated || !diff) && (
				<p className="code-diff-notice">
					{t(
						file.binary
							? "Binary file changed"
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
	const { t } = useTranslation();
	return (
		<WorkerPoolContextProvider poolOptions={DIFF_WORKER_POOL} highlighterOptions={DIFF_HIGHLIGHTER}>
			<div className="code-tool-changes">
				{changes.files.map((file) => (
					<FileDiff key={file.path} file={file} />
				))}
				{changes.partial && <p className="code-diff-notice">{t("Some file changes could not be counted")}</p>}
			</div>
		</WorkerPoolContextProvider>
	);
}
