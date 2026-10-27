import type { ClientResult } from "@metis/app-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { ArrowLeft, ArrowsClockwise, Books, FileText, FolderPlus, Graph, MagnifyingGlass, X } from "../icons.tsx";
import { KnowledgeGraph } from "./KnowledgeGraph.tsx";
import { KnowledgeLibraryRemove } from "./KnowledgeLibraryRemove.tsx";
import { KnowledgeLibrarySelect } from "./KnowledgeLibrarySelect.tsx";
import { KnowledgeNoteList } from "./KnowledgeNoteList.tsx";
import { createGraphSession, type GraphSession } from "./knowledge-graph-session.ts";
import { Markdown, type MarkdownFragment } from "./Markdown.tsx";
import { stripMarkdownFrontmatter } from "./markdown-fragments.ts";
import type { MarkdownDocument } from "./markdown-resources.ts";
import { notifyKnowledgeChanged, useKnowledgeLinks } from "./use-knowledge-links.ts";

const EMPTY_GRAPH: ClientResult<"knowledge/scan"> = { notes: [], edges: [], warnings: [] };
const VIEW_KEY = "metis.knowledge-view.v1";

export function KnowledgePanel({
	api,
	sessionId,
	visible,
}: {
	readonly api: MetisDesktopApi;
	readonly sessionId: string;
	readonly visible: boolean;
}) {
	const { t } = useTranslation();
	const {
		libraries,
		busy,
		loading: catalogLoading,
		error: catalogError,
		forgetRemovedLibraries,
		reload,
	} = useKnowledgeLinks(api, sessionId, visible);
	const [selectedId, setSelectedId] = useState(() => localStorage.getItem(VIEW_KEY) ?? "");
	const [scan, setScan] = useState({ key: "", graph: EMPTY_GRAPH });
	const graphSessions = useRef(new Map<string, { path: string; session: GraphSession }>());
	const catalogWasVisible = useRef(visible);
	const [mode, setMode] = useState<"graph" | "notes">("graph");
	const [query, setQuery] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [content, setContent] = useState<string>();
	const [fragment, setFragment] = useState<MarkdownFragment>();
	const [readError, setReadError] = useState<string>();
	const [readRetry, setReadRetry] = useState(0);
	const [error, setError] = useState<string>();
	const [mutationError, setMutationError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState(false);
	const mutation = useRef(false);
	const [refresh, setRefresh] = useState(0);
	// Bumped by every successful poll so the open note re-reads without replacing an unchanged graph.
	const [scanRevision, setScanRevision] = useState(0);
	const requestRevision = useRef(0);
	const contentPath = useRef("");
	const library = libraries.find((item) => item.id === selectedId);
	const libraryId = library?.id;
	const libraryPath = library?.path;
	const libraryKey = libraryId && libraryPath ? `${libraryId}\0${libraryPath}` : "";
	const graph = scan.key === libraryKey ? scan.graph : EMPTY_GRAPH;
	const graphSession = useMemo(() => {
		if (!libraryId || !libraryPath) return undefined;
		const cached = graphSessions.current.get(libraryId);
		if (cached?.path === libraryPath) return cached.session;
		cached?.session.layout.stop();
		const session = createGraphSession();
		graphSessions.current.set(libraryId, { path: libraryPath, session });
		return session;
	}, [libraryId, libraryPath]);
	const note = graph.notes.find((item) => item.path === selectedPath);
	const openNote = useCallback((path: string, fragment?: string) => {
		setFragment({ target: fragment ?? "", requestId: crypto.randomUUID() });
		setSelectedPath(path);
	}, []);
	const markdownDocument = useMemo<MarkdownDocument | undefined>(
		() =>
			libraryId && selectedPath
				? {
						api,
						owner: { source: "knowledge", libraryId, path: selectedPath, sessionId },
						revision: scanRevision,
						onOpenNote: openNote,
					}
				: undefined,
		[api, libraryId, selectedPath, sessionId, scanRevision, openNote],
	);

	useEffect(() => {
		const becomingVisible = visible && !catalogWasVisible.current;
		catalogWasVisible.current = visible;
		if (!visible || becomingVisible || catalogLoading || catalogError) return;
		for (const [id, cached] of graphSessions.current) {
			if (!libraries.some((item) => item.id === id && item.path === cached.path)) {
				cached.session.layout.stop();
				graphSessions.current.delete(id);
			}
		}
		if (!libraries.some((item) => item.id === selectedId)) setSelectedId(libraries[0]?.id ?? "");
		if (library) localStorage.setItem(VIEW_KEY, library.id);
		else if (!libraries.length) localStorage.removeItem(VIEW_KEY);
	}, [catalogError, catalogLoading, libraries, library, selectedId, visible]);
	// biome-ignore lint/correctness/useExhaustiveDependencies(selectedId): Switching libraries resets note selection and search.
	useEffect(() => {
		setSelectedPath(null);
		setContent(undefined);
		setReadError(undefined);
		setQuery("");
	}, [selectedId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies(refresh): Retry explicitly restarts library scanning.
	// biome-ignore lint/correctness/useExhaustiveDependencies(libraryPath): Moving a library restarts scanning its file roots.
	useEffect(() => {
		setError(undefined);
		if (!visible || !libraryId) {
			setLoading(false);
			return;
		}
		let active = true;
		let scanning = false;
		setLoading(true);
		const scan = async () => {
			if (scanning) return;
			scanning = true;
			try {
				const result = await api.scanKnowledgeLibrary({ libraryId });
				if (active) {
					// Keep the previous object when nothing changed so the graph layout is not restarted.
					setScan((current) =>
						current.key === libraryKey && JSON.stringify(current.graph) === JSON.stringify(result)
							? current
							: { key: libraryKey, graph: result },
					);
					setScanRevision((revision) => revision + 1);
					setSelectedPath((path) => (result.notes.some((item) => item.path === path) ? path : null));
					setError(undefined);
				}
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				scanning = false;
				if (active) setLoading(false);
			}
		};
		void scan();
		const timer = window.setInterval(() => {
			if (document.visibilityState !== "hidden") void scan();
		}, 5000);
		const focus = () => {
			void scan();
		};
		window.addEventListener("focus", focus);
		return () => {
			active = false;
			window.clearInterval(timer);
			window.removeEventListener("focus", focus);
		};
	}, [api, libraryId, libraryPath, libraryKey, visible, refresh]);
	// biome-ignore lint/correctness/useExhaustiveDependencies(scanRevision): A successful scan refreshes the open note even when the graph is unchanged.
	// biome-ignore lint/correctness/useExhaustiveDependencies(readRetry): Retry explicitly re-reads the open note even when its path is unchanged.
	useEffect(() => {
		const request = ++requestRevision.current;
		const key = `${libraryId}:${selectedPath}`;
		if (contentPath.current !== key) {
			setContent(undefined);
			setReadError(undefined);
		}
		contentPath.current = key;
		if (!visible || !libraryId || !selectedPath) return;
		void api.readKnowledgeNote({ libraryId, path: selectedPath }).then(
			(result) => {
				if (request === requestRevision.current) {
					setContent(result.content);
					setReadError(undefined);
				}
			},
			(cause) => {
				if (request === requestRevision.current)
					setReadError(cause instanceof Error ? cause.message : String(cause));
			},
		);
		return () => {
			++requestRevision.current;
		};
	}, [api, libraryId, selectedPath, visible, scanRevision, readRetry]);
	const filtered = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		const notes = graph.notes.filter(
			(item) => !needle || `${item.title} ${item.path}`.toLocaleLowerCase().includes(needle),
		);
		const paths = new Set(notes.map((item) => item.path));
		return { ...graph, notes, edges: graph.edges.filter((edge) => paths.has(edge.source) && paths.has(edge.target)) };
	}, [graph, query]);
	const chooseDirectory = async () => {
		if (mutation.current) return;
		mutation.current = true;
		setAdding(true);
		setMutationError(undefined);
		try {
			const path = await api.selectProjectFolder();
			if (!path) return;
			const added = await api.registerKnowledgeLibrary({ requestId: crypto.randomUUID(), path });
			await reload();
			setSelectedId(added.id);
			notifyKnowledgeChanged();
		} catch (cause) {
			setMutationError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAdding(false);
			mutation.current = false;
		}
	};
	// Serial batch removal under the panel-wide mutation lock; successful IDs are reported back so the dialog keeps only failed and unattempted items checked.
	const removeLibraries = async (ids: readonly string[]): Promise<string[]> => {
		const removed: string[] = [];
		if (mutation.current || ids.length === 0) return removed;
		mutation.current = true;
		setRemoving(true);
		setMutationError(undefined);
		try {
			for (const id of ids) {
				try {
					await api.removeKnowledgeLibrary({ libraryId: id, requestId: crypto.randomUUID() });
					removed.push(id);
					// Apply the known result immediately so a later failed or stale reload cannot redisplay the library.
					forgetRemovedLibraries([id]);
				} catch (cause) {
					setMutationError(cause instanceof Error ? cause.message : String(cause));
					break;
				}
			}
			await reload();
			if (removed.length > 0) notifyKnowledgeChanged();
			return removed;
		} finally {
			setRemoving(false);
			mutation.current = false;
		}
	};
	return (
		<section
			className="tool-panel knowledge-panel"
			data-knowledge-explorer
			hidden={!visible}
			id={`knowledge-panel-${sessionId}`}
			role="tabpanel"
			aria-label={t("Knowledge")}
		>
			<div className="knowledge-toolbar">
				<KnowledgeLibrarySelect
					busy={busy}
					disabled={adding || removing}
					libraries={libraries}
					value={selectedId}
					onChange={setSelectedId}
				/>
				<div className="knowledge-toolbar-actions">
					<button
						type="button"
						className="knowledge-create-button"
						disabled={adding || busy || removing}
						title={t("Choose knowledge directory")}
						onClick={() => void chooseDirectory()}
					>
						<FolderPlus aria-hidden="true" size={17} />
						<span>{t("New knowledge library")}</span>
					</button>
					<KnowledgeLibraryRemove
						active={visible}
						disabled={adding || busy}
						libraries={libraries}
						pending={removing}
						onRemove={removeLibraries}
					/>
					<button
						type="button"
						className="knowledge-icon-button"
						disabled={!library || loading}
						aria-label={t("Refresh knowledge")}
						title={t("Refresh knowledge")}
						onClick={() => setRefresh((value) => value + 1)}
					>
						<ArrowsClockwise aria-hidden="true" className={loading ? "is-spinning" : undefined} size={17} />
					</button>
				</div>
			</div>
			{(mutationError || error || catalogError) && (
				<div className="knowledge-error" role="alert">
					<span>{mutationError || error || catalogError}</span>
					{mutationError ? (
						<button type="button" onClick={() => setMutationError(undefined)}>
							{t("Close")}
						</button>
					) : (
						<button
							type="button"
							onClick={() => {
								void reload();
								setRefresh((value) => value + 1);
							}}
						>
							{t("Retry")}
						</button>
					)}
				</div>
			)}
			{graph.warnings.length > 0 && (
				<details className="knowledge-warnings">
					<summary>{t("Some notes could not be displayed")}</summary>
					{graph.warnings.map((warning) => (
						<p key={warning}>{warning}</p>
					))}
				</details>
			)}
			{catalogLoading || loading ? (
				<output className="status-block knowledge-empty">
					<ArrowsClockwise aria-hidden="true" className="is-spinning" size={24} />
					{t("Loading…")}
				</output>
			) : !library ? (
				<div className="knowledge-empty">
					<Books aria-hidden="true" size={32} weight="light" />
					<strong>{t("Your knowledge, in one place")}</strong>
					<p>{t("Choose a directory as your knowledge library.")}</p>
					<button
						className="knowledge-action"
						type="button"
						disabled={adding || busy}
						onClick={() => void chooseDirectory()}
					>
						<FolderPlus aria-hidden="true" size={15} />
						{t("New knowledge library")}
					</button>
				</div>
			) : !graph.notes.length ? (
				<div className="knowledge-empty">
					<FileText aria-hidden="true" size={32} weight="light" />
					<strong>{t("No usable content in this knowledge library yet.")}</strong>
					<p>{t("Use + → Knowledge to link this library, then send a material and ask Metis to organize it.")}</p>
				</div>
			) : selectedPath ? (
				<div className="knowledge-note-view">
					<div className="knowledge-reader-toolbar">
						<button
							className="knowledge-icon-button"
							type="button"
							aria-label={t("Back to knowledge library")}
							title={t("Back to knowledge library")}
							onClick={() => setSelectedPath(null)}
						>
							<ArrowLeft aria-hidden="true" size={17} />
						</button>
						<span title={selectedPath}>{note?.title ?? selectedPath}</span>
					</div>
					<div className="knowledge-reader-scroll">
						<div className="knowledge-note-path">{selectedPath}</div>
						{readError && (
							<div className="knowledge-error" role="alert">
								<span>{readError}</span>
								<button
									type="button"
									onClick={() => {
										setReadError(undefined);
										setReadRetry((value) => value + 1);
									}}
								>
									{t("Retry")}
								</button>
							</div>
						)}
						{content !== undefined && note ? (
							<div className="knowledge-markdown turn-answer">
								<Markdown
									key={`${libraryId}:${selectedPath}`}
									text={stripMarkdownFrontmatter(content)}
									document={markdownDocument}
									fragment={fragment}
								/>
							</div>
						) : !readError ? (
							<output className="status-paragraph">{t("Loading…")}</output>
						) : null}
					</div>
				</div>
			) : (
				<>
					<div className="knowledge-view-controls">
						<fieldset className="control-group knowledge-view-switch" aria-label={t("Knowledge view")}>
							<button type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
								<Graph aria-hidden="true" size={14} />
								{t("Graph")}
							</button>
							<button type="button" aria-pressed={mode === "notes"} onClick={() => setMode("notes")}>
								<FileText aria-hidden="true" size={14} />
								{t("Knowledge notes")}
							</button>
						</fieldset>
						<div className="knowledge-search">
							<MagnifyingGlass aria-hidden="true" size={14} />
							<input
								aria-label={t("Search knowledge notes")}
								placeholder={t("Search notes")}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
							{query && (
								<button type="button" aria-label={t("Clear search")} onClick={() => setQuery("")}>
									<X aria-hidden="true" size={12} />
								</button>
							)}
						</div>
					</div>
					{mode === "graph" ? (
						<KnowledgeGraph
							key={libraryKey}
							graph={graph}
							session={graphSession}
							query={query}
							onOpen={openNote}
							active={visible}
						/>
					) : !filtered.notes.length ? (
						<div className="knowledge-empty">
							<MagnifyingGlass aria-hidden="true" size={28} weight="light" />
							<strong>{t("No matching notes")}</strong>
							<button className="knowledge-action" type="button" onClick={() => setQuery("")}>
								{t("Clear search")}
							</button>
						</div>
					) : (
						<KnowledgeNoteList notes={filtered.notes} onOpen={openNote} expandAll={Boolean(query.trim())} />
					)}
				</>
			)}
			{library && (
				<div className="knowledge-footer" title={library.path}>
					<span>{library.path}</span>
					<span>{t("{{count}} notes", { count: graph.notes.length })}</span>
				</div>
			)}
		</section>
	);
}
