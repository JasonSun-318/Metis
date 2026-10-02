import type { ClientResult, KnowledgeNote } from "@metis/app-protocol";
import { ArrowLeft, ArrowsClockwise, FolderPlus, Link, LinkBreak } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { KnowledgeGraph } from "./KnowledgeGraph.tsx";
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
		linked,
		busy: linking,
		error: linkError,
		reload,
		toggle,
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
	const requestRevision = useRef(0);
	const contentPath = useRef("");
	const library = libraries.find((item) => item.id === selectedId);
	const isLinked = linked.some((item) => item.id === selectedId);
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
		if (!visible || !library) return;
		let active = true;
		let scanning = false;
		setLoading(true);
		const scan = async () => {
			if (scanning) return;
			scanning = true;
			try {
				const result = await api.scanKnowledgeLibrary({ libraryId: library.id });
				if (active) {
					setGraph(result);
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
	}, [api, library?.id, selectedPath, visible, graph]);
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
					value={selectedId}
					options={libraries.map((item) => ({ value: item.id, label: item.name }))}
					onChange={setSelectedId}
				/>
				<button
					type="button"
					className="icon-button"
					disabled={adding}
					aria-label={t("Choose knowledge directory")}
					title={t("Choose knowledge directory")}
					onClick={() => void chooseDirectory()}
				>
					<FolderPlus size={18} />
				</button>
				<button
					type="button"
					className="icon-button"
					disabled={!library || loading}
					aria-label={t("Refresh knowledge")}
					title={t("Refresh knowledge")}
					onClick={() => setRefresh((value) => value + 1)}
				>
					<ArrowsClockwise size={18} />
				</button>
			</div>
			{library && (
				<div className="knowledge-library-context">
					<span className="knowledge-root-path" title={library.path}>
						{library.path}
					</span>
					<button
						className="knowledge-link-button"
						type="button"
						disabled={linking}
						aria-pressed={isLinked}
						onClick={() => void toggle(library)}
					>
						{isLinked ? <LinkBreak size={14} /> : <Link size={14} />}
						{t(isLinked ? "Unlink from conversation" : "Link to conversation")}
					</button>
				</div>
			)}
			{(error || linkError) && (
				<div className="knowledge-error" role="alert">
					{error || linkError}
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
			{!library ? (
				<div className="knowledge-empty">
					<p>{t("Choose a directory as your knowledge library.")}</p>
					<button type="button" disabled={adding} onClick={() => void chooseDirectory()}>
						{t("Choose knowledge directory")}
					</button>
				</div>
			) : loading ? (
				<div className="knowledge-empty" role="status">
					{t("Loading…")}
				</div>
			) : !graph.notes.length ? (
				<div className="knowledge-empty">
					<p>{t("No usable content in this knowledge library yet.")}</p>
					<p>{t("Link this library to your conversation, then send a material and ask Metis to organize it.")}</p>
				</div>
			) : selectedPath ? (
				<div className="knowledge-note-view">
					<button className="knowledge-back" type="button" onClick={() => setSelectedPath(null)}>
						<ArrowLeft size={16} />
						{t("Back to knowledge library")}
					</button>
					<h3>{note?.title ?? selectedPath}</h3>
					<div className="knowledge-root-path">{selectedPath}</div>
					{readError && (
						<p className="knowledge-error" role="alert">
							{readError}
						</p>
					)}
					{content !== undefined && note ? (
						<div
							className="knowledge-markdown"
							onClick={(event) => {
								const anchor = (event.target as Element).closest("a");
								const href = anchor?.getAttribute("href");
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
			) : (
				<>
					<div className="knowledge-view-controls">
						<div>
							<button type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
								{t("Graph")}
							</button>
							<button type="button" aria-pressed={mode === "notes"} onClick={() => setMode("notes")}>
								{t("Knowledge notes")}
							</button>
						</div>
						<input
							aria-label={t("Search knowledge notes")}
							placeholder={t("Search knowledge notes")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					{!filtered.notes.length ? (
						<p className="knowledge-empty">{t("No matching notes")}</p>
					) : mode === "graph" ? (
						<KnowledgeGraph graph={filtered} onOpen={setSelectedPath} />
					) : (
						<div className="knowledge-note-list">
							{filtered.notes.map((item) => (
								<button type="button" key={item.path} onClick={() => setSelectedPath(item.path)}>
									<strong>{item.title}</strong>
									<span>{item.path}</span>
								</button>
							))}
						</div>
					)}
				</>
			)}
		</section>
	);
}
