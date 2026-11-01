import { PatchDiff, type WorkerInitializationRenderOptions, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DesktopWorkspaceReviewCommit,
	DesktopWorkspaceReviewFile,
	DesktopWorkspaceReviewFileDiff,
	DesktopWorkspaceReviewRevision,
	DesktopWorkspaceReviewSnapshot,
	MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import { ArrowClockwise, CaretDown, CaretRight, ClockCounterClockwise, FolderOpen, GitCommit } from "../icons.tsx";
import { buildReviewTree, type ReviewTreeNode, reviewPatchKey } from "./review-model.ts";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const DIFF_OPTIONS: NonNullable<React.ComponentProps<typeof PatchDiff>["options"]> = {
	diffStyle: "unified",
	disableFileHeader: true,
	hunkSeparators: "line-info-basic",
	lineDiffType: "word-alt",
	overflow: "scroll",
};

const WORKER_POOL_OPTIONS = {
	poolSize: 4,
	totalASTLRUCacheSize: 48,
	workerFactory: () =>
		new Worker(new URL("../workers/diff-worker.ts", import.meta.url), {
			name: "review-diff-worker",
			type: "module",
		}),
};

const HIGHLIGHTER_OPTIONS: Record<"dark" | "light", WorkerInitializationRenderOptions> = {
	dark: {
		theme: "pierre-dark",
		lineDiffType: "word-alt",
		langs: ["bash", "css", "html", "javascript", "json", "markdown", "python", "tsx", "typescript", "yaml"],
	},
	light: {
		theme: "pierre-light",
		lineDiffType: "word-alt",
		langs: ["bash", "css", "html", "javascript", "json", "markdown", "python", "tsx", "typescript", "yaml"],
	},
};

// Collapsed rows are a 36px header plus its 1px separator. Expanded rows are measured after mount.
const FILE_ROW_ESTIMATED_HEIGHT = 37;
const FILE_ROW_OVERSCAN = 4;
const FILE_LIST_BOTTOM_PADDING = 20;
// Without a laid-out scroll element (for example in jsdom) the virtualizer reports no rows; render a small
// first window so the review stays inspectable instead of going blank.
const MAX_UNMEASURED_ROWS = 30;
const EMPTY_FILES: readonly DesktopWorkspaceReviewFile[] = [];

type PatchState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly value: DesktopWorkspaceReviewFileDiff }
	| { readonly kind: "error" };

interface ReviewPanelProps {
	readonly focusRequest?: { readonly id: string; readonly path?: string };
	readonly api: MetisDesktopApi;
	readonly sessionId: string;
	readonly theme?: "dark" | "light";
	readonly visible: boolean;
}

function ChangeCounts({ file }: { readonly file: DesktopWorkspaceReviewFile }) {
	return (
		<span className="review-change-counts">
			<span>+{file.additions ?? "–"}</span>
			<span>−{file.deletions ?? "–"}</span>
		</span>
	);
}

function ReviewTree({
	nodes,
	onSelect,
}: {
	readonly nodes: readonly ReviewTreeNode[];
	readonly onSelect: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(
		() => new Set(nodes.flatMap((node) => (node.kind === "directory" ? [node.path] : []))),
	);
	return (
		<ul className="review-tree">
			{nodes.map((node) =>
				node.kind === "directory" ? (
					<li key={node.path}>
						<button
							aria-expanded={expanded.has(node.path)}
							onClick={() =>
								setExpanded((current) => {
									const next = new Set(current);
									if (next.has(node.path)) next.delete(node.path);
									else next.add(node.path);
									return next;
								})
							}
							type="button"
						>
							{expanded.has(node.path) ? (
								<CaretDown aria-hidden="true" size={12} />
							) : (
								<CaretRight aria-hidden="true" size={12} />
							)}
							<span className="review-tree-icon">
								<WorkspaceFileIcon
									expanded={expanded.has(node.path)}
									kind="directory"
									path={node.path}
									size={13}
								/>
							</span>
							<span className="review-tree-label">{node.name}</span>
						</button>
						{expanded.has(node.path) && <ReviewTree nodes={node.children} onSelect={onSelect} />}
					</li>
				) : (
					<li key={node.path}>
						<button onClick={() => onSelect(node.path)} type="button">
							<span className="review-tree-icon">
								<WorkspaceFileIcon path={node.path} size={13} />
							</span>
							<span className="review-tree-label">{node.name}</span>
							<ChangeCounts file={node.file} />
						</button>
					</li>
				),
			)}
		</ul>
	);
}

function ReviewDetails({
	open,
	snapshot,
	onSelectFile,
	onSelectRevision,
}: {
	readonly open: boolean;
	readonly snapshot: Extract<DesktopWorkspaceReviewSnapshot, { kind: "review" }>;
	readonly onSelectFile: (path: string) => void;
	readonly onSelectRevision: (revision: DesktopWorkspaceReviewRevision) => void;
}) {
	const { t } = useTranslation();
	const [commitsCollapsed, setCommitsCollapsed] = useState(false);
	const tree = useMemo(() => buildReviewTree(snapshot.files), [snapshot.files]);
	return (
		<aside
			aria-hidden={!open}
			aria-label={t("Review details")}
			className={`review-details${open ? "" : " is-hidden"}`}
		>
			<div className="review-details-scroll">
				{snapshot.files.length > 0 && <ReviewTree key={snapshot.revision} nodes={tree} onSelect={onSelectFile} />}
			</div>
			<div className={`review-history${commitsCollapsed ? " is-collapsed" : ""}`}>
				<button
					aria-pressed={snapshot.revision === "working-tree"}
					className={`review-revision${snapshot.revision === "working-tree" ? " is-active" : ""}`}
					onClick={() => onSelectRevision("working-tree")}
					type="button"
				>
					<FolderOpen aria-hidden="true" size={14} />
					<span>{t("All Changes")}</span>
				</button>
				<button
					aria-expanded={!commitsCollapsed}
					className="review-history-toggle"
					onClick={() => setCommitsCollapsed((val) => !val)}
					type="button"
				>
					<h3>
						<ClockCounterClockwise aria-hidden="true" size={13} />
						<span>{t("Recent commits")}</span>
						<span className="review-count-badge">{snapshot.commits.length}</span>
					</h3>
					{commitsCollapsed ? (
						<CaretRight aria-hidden="true" size={12} />
					) : (
						<CaretDown aria-hidden="true" size={12} />
					)}
				</button>
				{!commitsCollapsed && (
					<ul className="review-commits">
						{snapshot.commits.map((commit) => (
							<CommitItem
								commit={commit}
								key={commit.hash}
								onSelect={onSelectRevision}
								selected={snapshot.revision === commit.hash}
							/>
						))}
					</ul>
				)}
			</div>
		</aside>
	);
}

function CommitItem({
	commit,
	onSelect,
	selected,
}: {
	readonly commit: DesktopWorkspaceReviewCommit;
	readonly onSelect: (revision: DesktopWorkspaceReviewRevision) => void;
	readonly selected: boolean;
}) {
	return (
		<li>
			<button
				aria-pressed={selected}
				className={selected ? "is-active" : ""}
				onClick={() => onSelect(commit.hash)}
				title={commit.subject}
				type="button"
			>
				<GitCommit aria-hidden="true" size={13} />
				<span>
					<strong>{commit.subject}</strong>
					<small>
						{commit.shortHash} · {commit.authorName}
					</small>
				</span>
			</button>
		</li>
	);
}

function PatchBody({
	api,
	file,
	onRetry,
	revision,
	sessionId,
	state,
}: {
	readonly api: MetisDesktopApi;
	readonly file: DesktopWorkspaceReviewFile;
	readonly onRetry: () => void;
	readonly revision: DesktopWorkspaceReviewRevision;
	readonly sessionId: string;
	readonly state: PatchState | undefined;
}) {
	const { t } = useTranslation();
	const [contextError, setContextError] = useState<"binary" | "too-large" | "unknown" | null>(null);
	const options = useMemo<NonNullable<React.ComponentProps<typeof PatchDiff>["options"]>>(
		() =>
			["modified", "renamed", "copied"].includes(file.status)
				? {
						...DIFF_OPTIONS,
						loadDiffFiles: async () => {
							setContextError(null);
							try {
								const context = await api.getWorkspaceReviewFileContext({
									sessionId,
									revision,
									relativePath: file.relativePath,
								});
								if (context.kind === "unavailable") {
									setContextError(context.reason);
									throw new Error(context.reason);
								}
								return { oldFile: context.oldFile, newFile: context.newFile };
							} catch (cause) {
								setContextError((current) => current ?? "unknown");
								throw cause;
							}
						},
					}
				: DIFF_OPTIONS,
		[api, file.relativePath, file.status, revision, sessionId],
	);
	if (!state || state.kind === "loading") return <p className="review-diff-state">{t("Loading diff…")}</p>;
	if (state.kind === "error")
		return (
			<p className="review-diff-state is-error" role="alert">
				{t("Unable to load diff")}{" "}
				<button onClick={onRetry} type="button">
					{t("Retry")}
				</button>
			</p>
		);
	if (state.value.kind === "binary") return <p className="review-diff-state">{t("Binary file changed")}</p>;
	if (state.value.kind === "too-large") return <p className="review-diff-state">{t("Diff too large to display")}</p>;
	return (
		<>
			<PatchDiff options={options} patch={state.value.patch} />
			{contextError && (
				<output className="review-context-error">
					{t(
						contextError === "too-large"
							? "Unchanged context is too large to display"
							: contextError === "binary"
								? "Binary context cannot be displayed"
								: "Unable to load unchanged context",
					)}
				</output>
			)}
		</>
	);
}

export function ReviewPanel({ api, sessionId, theme = "dark", visible, focusRequest }: ReviewPanelProps) {
	const { t } = useTranslation();
	const [focusNotice, setFocusNotice] = useState("");
	const consumedFocus = useRef<string>(undefined);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [detailsMounted, setDetailsMounted] = useState(false);
	const [revision, setRevision] = useState<DesktopWorkspaceReviewRevision>("working-tree");
	const [snapshot, setSnapshot] = useState<DesktopWorkspaceReviewSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [refreshVersion, setRefreshVersion] = useState(0);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [patches, setPatches] = useState<ReadonlyMap<string, PatchState>>(new Map());
	const expandedRef = useRef(expanded);
	const patchesRef = useRef(patches);
	const patchRequestsRef = useRef(new Map<string, symbol>());
	const refreshRequestRef = useRef(false);
	const scrollRef = useRef<HTMLElement | null>(null);
	const filesRef = useRef<HTMLDivElement | null>(null);
	const [listOffset, setListOffset] = useState(0);
	expandedRef.current = expanded;
	patchesRef.current = patches;
	const displayedRevision = snapshot?.kind === "review" ? snapshot.revision : revision;
	const files = snapshot?.kind === "review" ? snapshot.files : EMPTY_FILES;
	const virtualizer = useVirtualizer({
		count: files.length,
		estimateSize: () => FILE_ROW_ESTIMATED_HEIGHT,
		getItemKey: (index) => files[index]?.relativePath ?? index,
		getScrollElement: () => scrollRef.current,
		overscan: FILE_ROW_OVERSCAN,
		paddingEnd: FILE_LIST_BOTTOM_PADDING,
		scrollMargin: listOffset,
	});

	// The collapse note and focus notice precede the list inside the scrolling pane, so the list's
	// offset becomes the virtualizer's scroll margin. The content pane resizes when details open or the
	// panel is resized, which can rewrap those lines, so its size is observed as well.
	// biome-ignore lint/correctness/useExhaustiveDependencies(focusNotice): The notice changes the content above the list, so the offset must be re-measured.
	// biome-ignore lint/correctness/useExhaustiveDependencies(snapshot): The list only renders after a review snapshot arrives, so its offset must be measured then.
	useLayoutEffect(() => {
		const scrollElement = scrollRef.current;
		if (!visible || !scrollElement || !filesRef.current) return;
		const update = () => {
			if (!filesRef.current) return;
			const offset = filesRef.current.offsetTop;
			setListOffset((current) => (current === offset ? current : offset));
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(scrollElement);
		return () => observer.disconnect();
	}, [focusNotice, snapshot, visible]);

	const scrollToFileIndex = useCallback(
		(index: number) => {
			if (index < 0) return;
			virtualizer.scrollToIndex(index, { align: "start", behavior: "smooth" });
		},
		[virtualizer],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies(refreshVersion): Refresh requests reload the review and invalidate cached patches.
	useEffect(() => {
		let current = true;
		const invalidateRevisionPatches = refreshRequestRef.current;
		refreshRequestRef.current = false;
		setLoading(true);
		setLoadError(false);
		void api.getWorkspaceReview({ sessionId, revision }).then(
			(value) => {
				if (!current) return;
				if (invalidateRevisionPatches) {
					const next = new Map([...patchesRef.current].filter(([key]) => !key.startsWith(`${revision}\0`)));
					patchesRef.current = next;
					setPatches(next);
				}
				setSnapshot(value);
				setExpanded(new Set());
				// Row heights are cached by path; a replacement review collapses every row, so stale
				// expanded heights must not offset files that are not currently mounted.
				virtualizer.measure();
				setLoading(false);
			},
			() => {
				if (!current) return;
				setLoadError(true);
				setLoading(false);
			},
		);
		return () => {
			current = false;
		};
	}, [api, refreshVersion, revision, sessionId, virtualizer]);

	const loadPatch = useCallback(
		(file: DesktopWorkspaceReviewFile, retry = false) => {
			const key = reviewPatchKey(displayedRevision, file.relativePath);
			if (!retry && patchesRef.current.has(key)) return;
			const loadingPatches = new Map(patchesRef.current).set(key, { kind: "loading" } as const);
			const request = Symbol(key);
			patchRequestsRef.current.set(key, request);
			patchesRef.current = loadingPatches;
			setPatches(loadingPatches);
			void api
				.getWorkspaceReviewFileDiff({ sessionId, revision: displayedRevision, relativePath: file.relativePath })
				.then(
					(value) => {
						if (patchRequestsRef.current.get(key) !== request) return;
						patchRequestsRef.current.delete(key);
						setPatches((current) => {
							const next = new Map(current).set(key, { kind: "loaded", value } as const);
							for (const candidate of next.keys()) {
								if (next.size <= 12) break;
								const path = candidate.slice(candidate.indexOf("\0") + 1);
								if (candidate !== key && !expandedRef.current.has(path)) next.delete(candidate);
							}
							patchesRef.current = next;
							return next;
						});
					},
					() => {
						if (patchRequestsRef.current.get(key) !== request) return;
						patchRequestsRef.current.delete(key);
						setPatches((current) => {
							const next = new Map(current).set(key, { kind: "error" } as const);
							patchesRef.current = next;
							return next;
						});
					},
				);
		},
		[api, displayedRevision, sessionId],
	);

	useEffect(() => {
		if (
			!visible ||
			loading ||
			!focusRequest ||
			consumedFocus.current === focusRequest.id ||
			snapshot?.kind !== "review"
		)
			return;
		consumedFocus.current = focusRequest.id;
		setFocusNotice("");
		if (!focusRequest.path) return;
		const index = snapshot.files.findIndex((entry) => entry.relativePath === focusRequest.path);
		if (index < 0) {
			setFocusNotice(t("This file is not in the current review"));
			return;
		}
		const file = snapshot.files[index]!;
		setExpanded((current) => new Set(current).add(file.relativePath));
		loadPatch(file);
		scrollToFileIndex(index);
	}, [focusRequest, loading, snapshot, visible, loadPatch, scrollToFileIndex, t]);

	const toggleFile = (file: DesktopWorkspaceReviewFile, forceOpen = false) => {
		const isExpanded = expanded.has(file.relativePath);
		const nextExpanded = new Set(expanded);
		if (isExpanded && !forceOpen) nextExpanded.delete(file.relativePath);
		else nextExpanded.add(file.relativePath);
		setExpanded(nextExpanded);
		if (isExpanded && !forceOpen && patchesRef.current.size > 12) {
			const next = new Map(patchesRef.current);
			for (const candidate of next.keys()) {
				if (next.size <= 12) break;
				const path = candidate.slice(candidate.indexOf("\0") + 1);
				if (!nextExpanded.has(path)) next.delete(candidate);
			}
			patchesRef.current = next;
			setPatches(next);
		}
		if (!isExpanded || forceOpen) loadPatch(file);
	};

	const selectRevision = (value: DesktopWorkspaceReviewRevision) => {
		if (value === revision || loading) return;
		setLoading(true);
		setRevision(value);
	};

	const selectFile = (path: string) => {
		if (snapshot?.kind !== "review") return;
		const index = snapshot.files.findIndex((candidate) => candidate.relativePath === path);
		if (index < 0) return;
		toggleFile(snapshot.files[index]!, true);
		scrollToFileIndex(index);
	};

	const refresh = () => {
		setLoading(true);
		refreshRequestRef.current = true;
		setRefreshVersion((value) => value + 1);
	};

	const toggleDetails = () => {
		if (!detailsOpen) setDetailsMounted(true);
		setDetailsOpen((value) => !value);
	};
	const repositoryLabel =
		snapshot?.kind === "review"
			? `${snapshot.branch} → ${snapshot.repositoryRoot.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? snapshot.repositoryRoot}`
			: t("Review");
	const virtualRows = virtualizer.getVirtualItems();
	const renderedRows: readonly { readonly index: number; readonly start: number }[] =
		virtualRows.length > 0
			? virtualRows
			: files.slice(0, MAX_UNMEASURED_ROWS).map((_, index) => ({
					index,
					start: listOffset + index * FILE_ROW_ESTIMATED_HEIGHT,
				}));

	return (
		<section
			aria-label={t("Review")}
			className={`review-panel${visible ? " is-visible" : ""}`}
			id={`review-panel-${sessionId}`}
			role="tabpanel"
		>
			<header className="review-toolbar">
				<button
					aria-expanded={detailsOpen}
					aria-label={t(detailsOpen ? "Hide review details" : "Show review details")}
					className={detailsOpen ? "is-active" : ""}
					disabled={loading}
					onClick={toggleDetails}
					type="button"
				>
					<FolderOpen aria-hidden="true" size={15} />
				</button>
				<span title={snapshot?.kind === "review" ? snapshot.repositoryRoot : undefined}>{repositoryLabel}</span>
				<button
					aria-label={t(loadError ? "Retry" : "Refresh review")}
					className={`review-refresh${loadError ? " is-error" : ""}`}
					disabled={loading}
					onClick={refresh}
					title={loadError ? t("Unable to load review") : undefined}
					type="button"
				>
					<ArrowClockwise aria-hidden="true" className={loading ? "is-spinning" : undefined} size={14} />
				</button>
			</header>
			<div
				aria-busy={loading}
				className={`review-layout${detailsOpen ? " has-details" : ""}`}
				inert={loading || undefined}
			>
				{visible && detailsMounted && snapshot?.kind === "review" && (
					<ReviewDetails
						open={detailsOpen}
						onSelectFile={selectFile}
						onSelectRevision={selectRevision}
						snapshot={snapshot}
					/>
				)}
				<main className="review-content" ref={scrollRef}>
					{focusNotice && <output className="code-diff-notice">{focusNotice}</output>}
					{!visible ? null : !snapshot && loading ? (
						<p className="review-empty">{t("Loading review…")}</p>
					) : !snapshot && loadError ? (
						<p className="review-empty is-error" role="alert">
							{t("Unable to load review")}{" "}
							<button onClick={refresh} type="button">
								{t("Retry")}
							</button>
						</p>
					) : snapshot?.kind === "not-repository" ? (
						<p className="review-empty">{t("This workspace is not a Git repository.")}</p>
					) : snapshot?.kind === "review" && snapshot.files.length === 0 ? (
						<p className="review-empty">{t("No changes")}</p>
					) : snapshot?.kind === "review" ? (
						<WorkerPoolContextProvider
							highlighterOptions={HIGHLIGHTER_OPTIONS[theme]}
							key={theme}
							poolOptions={WORKER_POOL_OPTIONS}
						>
							<p className="review-collapse-note">
								{t("Files are collapsed for large diffs. Select a file to expand it.")}
							</p>
							<div className="review-files" ref={filesRef} style={{ height: `${virtualizer.getTotalSize()}px` }}>
								{renderedRows.map((row) => {
									const file = files[row.index];
									if (!file) return null;
									const isExpanded = expanded.has(file.relativePath);
									const key = reviewPatchKey(snapshot.revision, file.relativePath);
									return (
										<article
											className="review-file"
											data-index={row.index}
											key={file.relativePath}
											ref={virtualizer.measureElement}
											style={{ transform: `translateY(${row.start - listOffset}px)` }}
										>
											<button
												aria-expanded={isExpanded}
												className="review-file-header"
												onClick={() => toggleFile(file)}
												type="button"
											>
												{isExpanded ? (
													<CaretDown aria-hidden="true" size={14} />
												) : (
													<CaretRight aria-hidden="true" size={14} />
												)}
												<WorkspaceFileIcon path={file.relativePath} size={14} />
												<span title={file.relativePath}>{file.relativePath}</span>
												<ChangeCounts file={file} />
											</button>
											{isExpanded && (
												<div className="review-patch">
													<PatchBody
														api={api}
														file={file}
														onRetry={() => loadPatch(file, true)}
														revision={snapshot.revision}
														sessionId={sessionId}
														state={patches.get(key)}
													/>
												</div>
											)}
										</article>
									);
								})}
							</div>
						</WorkerPoolContextProvider>
					) : null}
				</main>
			</div>
		</section>
	);
}
