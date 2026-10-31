import type { CodeChangesView } from "@metis/app-protocol";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretRight } from "../icons.tsx";
import { codeFileName, summarizeCodeChanges, type TurnFileChange } from "./code-change-summary.ts";
import { CodeChangeCounts } from "./ToolCodeChanges.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

export function CodeTurnChanges({
	snapshots,
	onViewChanges,
}: {
	readonly snapshots: readonly CodeChangesView[];
	readonly onViewChanges?: (relativePath?: string) => void;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const drawerId = useId();
	const summary = summarizeCodeChanges(snapshots);
	if (!summary?.files.length) return null;
	const { files, counts } = summary;
	const showCounts = Boolean(counts.additions || counts.deletions || counts.partial);
	const row = ({ file, counts: fileCounts }: TurnFileChange) => (
		<button
			className="code-turn-file"
			key={file.path}
			title={fileCounts ? file.path : `${file.path} — ${t("Net line counts not recorded")}`}
			disabled={!onViewChanges}
			onClick={() => onViewChanges?.(file.path)}
			type="button"
		>
			<WorkspaceFileIcon path={file.path} size={14} />
			<span className="code-turn-file-name">{codeFileName(file.path)}</span>
			{fileCounts && <CodeChangeCounts counts={fileCounts} />}
		</button>
	);
	return (
		<section className="code-turn-changes" aria-label={t("File changes")}>
			<header>
				<div className="code-turn-changes-title">
					<span>
						{t(
							files.every(({ file }) => file.kind === "added")
								? "Created {{count}} files"
								: "Changed {{count}} files",
							{ count: files.length },
						)}
					</span>
					{files.length <= 3 && showCounts && <CodeChangeCounts counts={counts} turn />}
				</div>
				<button
					className="code-turn-review"
					disabled={!onViewChanges}
					onClick={() => onViewChanges?.()}
					type="button"
				>
					{t("View changes")}
					<CaretRight aria-hidden="true" size={11} />
				</button>
			</header>
			{files.slice(0, 3).map(row)}
			{files.length > 3 && (
				<div
					className="transcript-drawer code-turn-files-drawer"
					id={drawerId}
					data-open={expanded ? "true" : undefined}
					inert={!expanded}
				>
					<div>{files.slice(3).map(row)}</div>
				</div>
			)}
			{files.length > 3 && (
				<footer>
					<button
						className="code-turn-more"
						aria-expanded={expanded}
						aria-controls={drawerId}
						onClick={() => setExpanded((value) => !value)}
						type="button"
					>
						<CaretRight aria-hidden="true" size={12} />
						{t(expanded ? "Hide other file changes" : "View {{count}} other file changes", {
							count: files.length - 3,
						})}
					</button>
					{showCounts && <CodeChangeCounts counts={counts} turn />}
				</footer>
			)}
		</section>
	);
}
