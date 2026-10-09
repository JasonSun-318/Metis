import type { ClientResult, KnowledgeNote } from "@metis/app-protocol";
import {
	ArrowLeft,
	ArrowsClockwise,
	Books,
	FileText,
	FolderPlus,
	Graph,
	MagnifyingGlass,
	X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { KnowledgeGraph } from "./KnowledgeGraph.tsx";
import { KnowledgeNoteList } from "./KnowledgeNoteList.tsx";
import { Markdown } from "./Markdown.tsx";
import { MenuSelect } from "./MenuSelect.tsx";
import { notifyKnowledgeChanged, useKnowledgeLinks } from "./use-knowledge-links.ts";

const EMPTY_GRAPH: ClientResult<"knowledge/scan"> = { notes: [], edges: [], warnings: [] };
const VIEW_KEY = "metis.knowledge-view.v1";

export function knowledgeNoteMarkdown(content: string, note: KnowledgeNote): string {
	const paths = new Map(note.links.map((link) => [`${link.kind}:${link.target}`, link.path]));
	let fence: string | undefined;
	return content
		.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
		.split("\n")
		.map((line) => {
			const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (match) {
				if (!fence) fence = match[1];
				else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
				return line;
			}
			if (fence) return line;
			return line.replace(
				/(`+)[\s\S]*?\1|!?\[\[([^\]\n]+)\]\]|(?<!!)\[([^\]\n]*)\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g,
				(
					original,
					code: string | undefined,
					wiki: string | undefined,
					label: string | undefined,
					href: string | undefined,
				) => {
					if (code) return original;
					const target = (wiki?.split("|")[0] ?? href ?? "").split("#")[0].trim();
					const kind = wiki ? "wiki" : "markdown";
					let path = paths.get(`${kind}:${target}`);
					if (!path && href) {
						try {
							path = paths.get(`${kind}:${decodeURIComponent(target)}`);
						} catch {
							return original;
						}
					}
					if (!path) return original;
					const text = wiki ? (wiki.split("|")[1] ?? wiki.split("#")[0]) : (label ?? target);
					return `[${text.replace(/([\[\]\\])/g, "\\$1")}](#knowledge-note/${encodeURIComponent(path)})`;
				},
			);
		})
		.join("\n");
}

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
		loading: catalogLoading,
		error: catalogError,
		reload,
	} = useKnowledgeLinks(api, sessionId, visible);
	const [selectedId, setSelectedId] = useState(() => localStorage.getItem(VIEW_KEY) ?? "");
	const [graph, setGraph] = useState(EMPTY_GRAPH);
	const [mode, setMode] = useState<"graph" | "notes">("graph");
	const [query, setQuery] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [content, setContent] = useState<string>();
	const [readError, setReadError] = useState<string>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [adding, setAdding] = useState(false);
	const [refresh, setRefresh] = useState(0);
	// Bumped by every successful poll so the open note re-reads without replacing an unchanged graph.
	const [scanRevision, setScanRevision] = useState(0);
	const requestRevision = useRef(0);
	const contentPath = useRef("");
	const library = libraries.find((item) => item.id === selectedId);
	const note = graph.notes.find((item) => item.path === selectedPath);

	useEffect(() => {
		if (libraries.length && !libraries.some((item) => item.id === selectedId)) setSelectedId(libraries[0].id);
	}, [libraries, selectedId]);
	useEffect(() => {
		if (library) localStorage.setItem(VIEW_KEY, library.id);
	}, [library]);
	useEffect(() => {
		setSelectedPath(null);
		setContent(undefined);
		setQuery("");
	}, [selectedId]);
	useEffect(() => {
		setGraph(EMPTY_GRAPH);
		setError(undefined);
		if (!visible || !library) {
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
				const result = await api.scanKnowledgeLibrary({ libraryId: library.id });
				if (active) {
					// Keep the previous object when nothing changed so the graph layout is not restarted.
					setGraph((current) => (JSON.stringify(current) === JSON.stringify(result) ? current : result));
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
	}, [api, library?.id, library?.path, visible, refresh]);
	useEffect(() => {
		const request = ++requestRevision.current;
		const key = `${library?.id}:${selectedPath}`;
		if (contentPath.current !== key) {
			setContent(undefined);
			setReadError(undefined);
		}
		contentPath.current = key;
		if (!visible || !library || !selectedPath) return;
		void api.readKnowledgeNote({ libraryId: library.id, path: selectedPath }).then(
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
	}, [api, library?.id, selectedPath, visible, scanRevision]);
	const filtered = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		const notes = graph.notes.filter(
			(item) => !needle || `${item.title} ${item.path}`.toLocaleLowerCase().includes(needle),
		);
		const paths = new Set(notes.map((item) => item.path));
		return { ...graph, notes, edges: graph.edges.filter((edge) => paths.has(edge.source) && paths.has(edge.target)) };
	}, [graph, query]);
	const chooseDirectory = async () => {
		setAdding(true);
		try {
			const path = await api.selectProjectFolder();
			if (!path) return;
			const added = await api.registerKnowledgeLibrary({ requestId: crypto.randomUUID(), path });
			await reload();
			setSelectedId(added.id);
			notifyKnowledgeChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAdding(false);
		}
	};
	return (
		<section
			className="tool-panel knowledge-panel"
			hidden={!visible}
			id={`knowledge-panel-${sessionId}`}
			role="tabpanel"
			aria-label={t("Knowledge")}
		>
			<div className="knowledge-toolbar">
				<MenuSelect
					ariaLabel={t("Choose knowledge library")}
					placeholder={t("Choose knowledge library")}
					triggerIcon={<Books aria-hidden="true" size={17} />}
					value={selectedId}
					options={libraries.map((item) => ({
						value: item.id,
						label: item.name,
						description: item.path,
						icon: <Books aria-hidden="true" size={15} />,
					}))}
					popoverClassName="knowledge-library-options"
					onChange={setSelectedId}
				/>
				<button
					type="button"
					className="knowledge-icon-button"
					disabled={adding}
					aria-label={t("Choose knowledge directory")}
					title={t("Choose knowledge directory")}
					onClick={() => void chooseDirectory()}
				>
					<FolderPlus aria-hidden="true" size={17} />
				</button>
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
			{(error || catalogError) && (
				<div className="knowledge-error" role="alert">
					<span>{error || catalogError}</span>
					<button
						type="button"
						onClick={() => {
							void reload();
							setRefresh((value) => value + 1);
						}}
					>
						{t("Retry")}
					</button>
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
				<div className="knowledge-empty" role="status">
					<ArrowsClockwise aria-hidden="true" className="is-spinning" size={24} />
					{t("Loading…")}
				</div>
			) : !library ? (
				<div className="knowledge-empty">
					<Books aria-hidden="true" size={32} weight="light" />
					<strong>{t("Your knowledge, in one place")}</strong>
					<p>{t("Choose a directory as your knowledge library.")}</p>
					<button
						className="knowledge-action"
						type="button"
						disabled={adding}
						onClick={() => void chooseDirectory()}
					>
						<FolderPlus aria-hidden="true" size={15} />
						{t("Choose knowledge directory")}
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
							<p className="knowledge-error" role="alert">
								{readError}
							</p>
						)}
						{content !== undefined && note ? (
							<div
								className="knowledge-markdown turn-answer"
								onClick={(event) => {
									const href = (event.target as Element).closest("a")?.getAttribute("href");
									if (href?.startsWith("#knowledge-note/")) {
										event.preventDefault();
										setSelectedPath(decodeURIComponent(href.slice("#knowledge-note/".length)));
									}
								}}
							>
								<Markdown text={knowledgeNoteMarkdown(content, note)} />
							</div>
						) : !readError ? (
							<p role="status">{t("Loading…")}</p>
						) : null}
					</div>
				</div>
			) : (
				<>
					<div className="knowledge-view-controls">
						<div className="knowledge-view-switch" role="group" aria-label={t("Knowledge view")}>
							<button type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
								<Graph aria-hidden="true" size={14} />
								{t("Graph")}
							</button>
							<button type="button" aria-pressed={mode === "notes"} onClick={() => setMode("notes")}>
								<FileText aria-hidden="true" size={14} />
								{t("Knowledge notes")}
							</button>
						</div>
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
					{!filtered.notes.length ? (
						<div className="knowledge-empty">
							<MagnifyingGlass aria-hidden="true" size={28} weight="light" />
							<strong>{t("No matching notes")}</strong>
							<button className="knowledge-action" type="button" onClick={() => setQuery("")}>
								{t("Clear search")}
							</button>
						</div>
					) : mode === "graph" ? (
						<KnowledgeGraph key={library.id} graph={filtered} onOpen={setSelectedPath} active={visible} />
					) : (
						<KnowledgeNoteList
							notes={filtered.notes}
							onOpen={setSelectedPath}
							expandAll={Boolean(query.trim())}
						/>
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
