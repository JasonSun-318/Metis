import { useVirtualizer } from "@tanstack/react-virtual";
import {
	CaretDown,
	CaretRight,
	Code,
	Copy,
	DotsThree,
	Eye,
	File,
	FilePlus,
	FileText,
	FloppyDisk,
	FolderOpen,
	FolderPlus,
	MagnifyingGlass,
	PencilSimple,
	SidebarSimple,
	SpinnerGap,
	Trash,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	MetisDesktopApi,
	DesktopWorkspaceEntry,
	DesktopWorkspaceFile,
	DesktopWorkspaceMutationInput,
	DesktopWorkspaceMutationResult,
} from "../../shared/desktop-api.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { Markdown } from "./Markdown.tsx";
import { classifyPreviewKind, isHostedPreviewKind } from "./preview/preview-kinds.ts";
import { UniversalFilePreviewer } from "./preview/UniversalFilePreviewer.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const DIRECTORY_CACHE_MS = 5_000;
const DEFAULT_TREE_WIDTH = 220;
const MIN_TREE_WIDTH = 140;
const MAX_TREE_WIDTH = 520;

function clampTreeWidth(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TREE_WIDTH;
	return Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, Math.round(value)));
}

interface CachedDirectory {
	readonly entries: readonly DesktopWorkspaceEntry[];
	readonly loadedAt: number;
}

interface TreeRow {
	readonly entry: DesktopWorkspaceEntry;
	readonly depth: number;
}

export interface WorkspaceFileDraft {
	readonly file: Extract<DesktopWorkspaceFile, { readonly kind: "text" }>;
	readonly savedText: string;
	readonly text: string;
}

interface FilePanelProps {
	readonly activePath: string | null;
	readonly api: MetisDesktopApi;
	readonly cwd: string;
	readonly expandedPaths: readonly string[];
	readonly draft: WorkspaceFileDraft | null;
	readonly dirtyPaths: readonly string[];
	readonly onDraftChange: (text: string) => void;
	readonly onDraftLoaded: (file: WorkspaceFileDraft["file"]) => void;
	readonly onExpandedPathsChange: (paths: readonly string[]) => void;
	readonly onOpenFile: (relativePath: string, fix: boolean) => void;
	readonly onError: (cause: unknown) => void;
	readonly onSave: () => Promise<void>;
	readonly onWorkspaceMutation: (result: DesktopWorkspaceMutationResult) => void;
	readonly saving: boolean;
	readonly savingPaths: readonly string[];
	readonly sessionId: string;
	readonly visible: boolean;
}

type MutationDialog =
	| { readonly type: "create"; readonly kind: "directory" | "file"; readonly parentRelativePath: string; readonly name: string }
	| { readonly type: "rename"; readonly entry: DesktopWorkspaceEntry; readonly name: string }
	| { readonly type: "move"; readonly entry: DesktopWorkspaceEntry; readonly destinationDirectoryRelativePath: string }
	| { readonly type: "trash"; readonly entry: DesktopWorkspaceEntry };

interface TreeMenu {
	readonly entry: DesktopWorkspaceEntry;
	readonly left: number;
	readonly top: number;
}

function fileName(path: string): string {
	return path.split("/").at(-1) ?? path;
}

function rootName(path: string): string {
	return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function extension(path: string): string {
	const name = fileName(path);
	const index = name.lastIndexOf(".");
	return index <= 0 ? "" : name.slice(index).toLocaleLowerCase();
}

function isMarkdown(path: string): boolean {
	return extension(path) === ".md" || extension(path) === ".markdown";
}

function parentPath(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

function parentForCreate(entry: DesktopWorkspaceEntry | null): string {
	if (!entry) return "";
	return entry.kind === "directory" ? entry.relativePath : parentPath(entry.relativePath);
}

function pathListAffects(paths: readonly string[], relativePath: string): boolean {
	return paths.some((path) => path === relativePath || path.startsWith(`${relativePath}/`));
}

export function FilePanel({
	activePath,
	api,
	cwd,
	draft,
	dirtyPaths,
	expandedPaths,
	onDraftChange,
	onDraftLoaded,
	onExpandedPathsChange,
	onOpenFile,
	onError,
	onSave,
	onWorkspaceMutation,
	saving,
	savingPaths,
	sessionId,
	visible,
}: FilePanelProps) {
	const { t } = useTranslation();
	const cacheRef = useRef(new Map<string, CachedDirectory>());
	const loadingDirectoriesRef = useRef(new Set<string>());
	const treeScrollRef = useRef<HTMLDivElement>(null);
	const actionMenuRef = useRef<HTMLDivElement>(null);
	const treeMenuRef = useRef<HTMLDivElement>(null);
	const onDraftLoadedRef = useRef(onDraftLoaded);
	onDraftLoadedRef.current = onDraftLoaded;
	const readGeneration = useRef(0);
	const searchGeneration = useRef(0);
	const [treeVersion, setTreeVersion] = useState(0);
	const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(new Set());
	const [treeError, setTreeError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState<readonly string[]>([]);
	const [searching, setSearching] = useState(false);
	const [file, setFile] = useState<DesktopWorkspaceFile | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewMode, setPreviewMode] = useState(false);
	const [actionMenuOpen, setActionMenuOpen] = useState(false);
	const [selectedEntry, setSelectedEntry] = useState<DesktopWorkspaceEntry | null>(null);
	const [treeMenu, setTreeMenu] = useState<TreeMenu | null>(null);
	const [mutationDialog, setMutationDialog] = useState<MutationDialog | null>(null);
	const [mutationPending, setMutationPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [treeOpen, setTreeOpen] = useState(true);
	const [treeWidth, setTreeWidth] = useState(() => {
		try {
			const stored = Number(localStorage.getItem("metis.fileTreeWidth"));
			return clampTreeWidth(stored || DEFAULT_TREE_WIDTH);
		} catch {
			return DEFAULT_TREE_WIDTH;
		}
	});
	const [isResizing, setIsResizing] = useState(false);
	const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

	const updateTreeWidth = useCallback((nextWidth: number) => {
		const clamped = clampTreeWidth(nextWidth);
		setTreeWidth(clamped);
		try {
			localStorage.setItem("metis.fileTreeWidth", String(clamped));
		} catch {}
	}, []);
	const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);
	const draftMatchesActivePath = draft?.file.relativePath === activePath;
	const displayedFile = draftMatchesActivePath ? draft.file : file;

	const loadDirectory = useCallback(async (relativePath: string) => {
		const cached = cacheRef.current.get(relativePath);
		if (cached && Date.now() - cached.loadedAt < DIRECTORY_CACHE_MS) return;
		if (loadingDirectoriesRef.current.has(relativePath)) return;
		loadingDirectoriesRef.current.add(relativePath);
		setLoadingDirectories(new Set(loadingDirectoriesRef.current));
		try {
			const entries = await api.listWorkspaceDirectory({ sessionId, relativePath });
			cacheRef.current.set(relativePath, { entries, loadedAt: Date.now() });
			setTreeError(null);
			setTreeVersion((value) => value + 1);
		} catch (cause) {
			setTreeError(cause instanceof Error ? cause.message : t("Files could not be loaded"));
			onError(cause);
		} finally {
			loadingDirectoriesRef.current.delete(relativePath);
			setLoadingDirectories(new Set(loadingDirectoriesRef.current));
		}
	}, [api, onError, sessionId, t]);

	useEffect(() => {
		if (!visible) return;
		void loadDirectory("");
		for (const relativePath of expandedPaths) {
			const parent = relativePath.split("/").slice(0, -1).join("/");
			if (cacheRef.current.has(parent)) void loadDirectory(relativePath);
		}
	}, [expandedPaths, loadDirectory, treeVersion, visible]);

	useEffect(() => {
		const generation = ++searchGeneration.current;
		const value = query.trim();
		if (!visible || !value) {
			setSearchResults([]);
			setSearching(false);
			return;
		}
		setSearchResults([]);
		setSearching(true);
		const timer = window.setTimeout(() => {
			void api.searchWorkspaceFiles({ sessionId, query: value }).then(
				(paths) => {
					if (generation !== searchGeneration.current) return;
					setSearchResults(paths);
					setSearching(false);
				},
				(cause) => {
					if (generation !== searchGeneration.current) return;
					setSearchResults([]);
					setSearching(false);
					onError(cause);
				},
			);
		}, 120);
		return () => window.clearTimeout(timer);
	}, [api, onError, query, sessionId, visible]);

	useEffect(() => {
		const generation = ++readGeneration.current;
		setActionMenuOpen(false);
		setNotice(null);
		setPreviewMode(false);
		setPreviewError(null);
		if (!visible || !activePath) {
			setFile(null);
			setPreviewLoading(false);
			return;
		}
		if (draftMatchesActivePath) {
			setFile(null);
			setPreviewLoading(false);
			return;
		}
		if (activePath && isHostedPreviewKind(classifyPreviewKind(fileName(activePath)))) {
			setFile(null);
			setPreviewLoading(false);
			return;
		}
		setFile(null);
		setPreviewLoading(true);
		void api.readWorkspaceFile({ sessionId, relativePath: activePath }).then(
			(result) => {
				if (generation !== readGeneration.current) return;
				setFile(result);
				if (result.kind === "text") onDraftLoadedRef.current(result);
				setPreviewLoading(false);
			},
			(cause) => {
				if (generation !== readGeneration.current) return;
				setPreviewError(cause instanceof Error ? cause.message : t("File could not be opened"));
				setPreviewLoading(false);
				onError(cause);
			},
		);
	}, [activePath, api, draftMatchesActivePath, onError, sessionId, t, visible]);

	useEffect(() => {
		if (!actionMenuOpen) return;
		const close = (event: PointerEvent) => {
			if (!actionMenuRef.current?.contains(event.target as Node)) setActionMenuOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setActionMenuOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", escape);
		};
	}, [actionMenuOpen]);

	useEffect(() => {
		if (!treeMenu && !mutationDialog) return;
		const closeMenu = (event: PointerEvent) => {
			if (treeMenu && !treeMenuRef.current?.contains(event.target as Node)) setTreeMenu(null);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || mutationPending) return;
			if (mutationDialog) setMutationDialog(null);
			else setTreeMenu(null);
		};
		document.addEventListener("pointerdown", closeMenu);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", closeMenu);
			document.removeEventListener("keydown", escape);
		};
	}, [mutationDialog, mutationPending, treeMenu]);

	const treeRows = useMemo(() => {
		void treeVersion;
		const rows: TreeRow[] = [];
		const append = (directory: string, depth: number) => {
			for (const entry of cacheRef.current.get(directory)?.entries ?? []) {
				rows.push({ entry, depth });
				if (entry.kind === "directory" && expanded.has(entry.relativePath)) append(entry.relativePath, depth + 1);
			}
		};
		append("", 0);
		return rows;
	}, [expanded, treeVersion]);
	const rows = useMemo<readonly TreeRow[]>(() => {
		if (!query.trim()) return treeRows;
		return searchResults.map((relativePath) => ({
			entry: { name: fileName(relativePath), relativePath, kind: "file" },
			depth: 0,
		}));
	}, [query, searchResults, treeRows]);
	const rootLoading = loadingDirectories.has("");
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => treeScrollRef.current,
		estimateSize: () => 28,
		getItemKey: (index) => rows[index]?.entry.relativePath ?? index,
		overscan: 10,
		initialRect: { width: 320, height: 600 },
	});
	const measuredRows = virtualizer.getVirtualItems();
	const visibleRows = measuredRows.length > 0
		? measuredRows
		: Array.from({ length: Math.min(rows.length, 30) }, (_, index) => ({ index, start: index * 28 }));

	const toggleDirectory = (relativePath: string) => {
		const next = new Set(expanded);
		if (next.has(relativePath)) next.delete(relativePath);
		else {
			next.add(relativePath);
			void loadDirectory(relativePath);
		}
		onExpandedPathsChange([...next]);
	};
	const showTreeMenu = (entry: DesktopWorkspaceEntry, left: number, top: number) => {
		setSelectedEntry(entry);
		setTreeMenu({
			entry,
			left: Math.max(8, Math.min(window.innerWidth - 190, left)),
			top: Math.max(8, Math.min(window.innerHeight - 170, top)),
		});
	};
	const showTreeMenuFromButton = (entry: DesktopWorkspaceEntry, button: HTMLButtonElement) => {
		const bounds = button.getBoundingClientRect();
		showTreeMenu(entry, bounds.right - 176, bounds.bottom + 3);
	};
	const copy = async (text: string, success: string) => {
		try {
			await api.writeClipboardText({ text });
			setNotice(success);
		} catch (cause) {
			onError(cause);
		}
	};
	const open = (action: "default" | "reveal") => {
		if (!activePath) return;
		setActionMenuOpen(false);
		void api.openWorkspaceFile({ sessionId, relativePath: activePath, action }).catch(onError);
	};
	const save = useCallback(async () => {
		if (!draft || draft.text === draft.savedText || saving) return;
		await onSave();
		setNotice(t("File saved"));
	}, [draft, onSave, saving, t]);
	const beginCreate = (kind: "directory" | "file") => {
		setTreeMenu(null);
		setMutationDialog({ type: "create", kind, parentRelativePath: parentForCreate(selectedEntry), name: "" });
	};
	const beginEntryMutation = (type: "move" | "rename" | "trash", entry: DesktopWorkspaceEntry) => {
		setTreeMenu(null);
		if (type === "rename") setMutationDialog({ type, entry, name: entry.name });
		else if (type === "move") setMutationDialog({ type, entry, destinationDirectoryRelativePath: "" });
		else setMutationDialog({ type, entry });
	};
	const submitMutation = async (input: DesktopWorkspaceMutationInput) => {
		const relativePath = input.action === "create" ? null : input.relativePath;
		if (relativePath && pathListAffects(savingPaths, relativePath)) {
			onError(new Error(t("Wait for the file to finish saving.")));
			return;
		}
		setMutationPending(true);
		try {
			const result = await api.mutateWorkspaceEntry(input);
			cacheRef.current.clear();
			setTreeVersion((value) => value + 1);
			setQuery("");
			setSearchResults([]);
			setMutationDialog(null);
			if (result.action === "create") {
				const created = {
					name: fileName(result.relativePath),
					relativePath: result.relativePath,
					kind: result.kind,
				} satisfies DesktopWorkspaceEntry;
				setSelectedEntry(created);
				if (result.kind === "directory") onExpandedPathsChange([...new Set([...expandedPaths, result.relativePath])]);
			} else if (result.action === "trash") {
				if (selectedEntry && pathListAffects([selectedEntry.relativePath], result.previousRelativePath)) setSelectedEntry(null);
			} else {
				setSelectedEntry((current) => {
					if (!current || !pathListAffects([current.relativePath], result.previousRelativePath)) return current;
					const relativePath = `${result.relativePath}${current.relativePath.slice(result.previousRelativePath.length)}`;
					return { ...current, name: fileName(relativePath), relativePath };
				});
			}
			onWorkspaceMutation(result);
			setNotice(t(
				result.action === "create" ? "Created"
					: result.action === "rename" ? "Renamed"
						: result.action === "move" ? "Moved" : "Moved to Trash",
			));
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			const translated = new Map([
				["Workspace destination already exists", "An item with this name already exists."],
				["Workspace root cannot be changed", "The workspace root cannot be changed."],
				["Workspace symbolic links are read-only", "Symbolic links are read-only."],
			]);
			onError(new Error(t(translated.get(message) ?? message)));
		} finally {
			setMutationPending(false);
		}
	};
	const submitDialog = () => {
		if (!mutationDialog) return;
		if (mutationDialog.type === "create") {
			void submitMutation({
				action: "create",
				sessionId,
				parentRelativePath: mutationDialog.parentRelativePath,
				name: mutationDialog.name,
				kind: mutationDialog.kind,
			});
		} else if (mutationDialog.type === "rename") {
			void submitMutation({
				action: "rename",
				sessionId,
				relativePath: mutationDialog.entry.relativePath,
				name: mutationDialog.name,
			});
		} else if (mutationDialog.type === "move") {
			void submitMutation({
				action: "move",
				sessionId,
				relativePath: mutationDialog.entry.relativePath,
				destinationDirectoryRelativePath: mutationDialog.destinationDirectoryRelativePath,
			});
		} else {
			void submitMutation({ action: "trash", sessionId, relativePath: mutationDialog.entry.relativePath });
		}
	};
	const mutationEntry = mutationDialog && mutationDialog.type !== "create" ? mutationDialog.entry : null;
	const affectedDirtyCount = mutationEntry
		? dirtyPaths.filter((path) => path === mutationEntry.relativePath || path.startsWith(`${mutationEntry.relativePath}/`)).length
		: 0;
	const mutationDialogLabel = mutationDialog?.type === "create"
		? t(mutationDialog.kind === "file" ? "New file" : "New folder")
		: mutationDialog?.type === "rename" ? t("Rename")
			: mutationDialog?.type === "move" ? t("Move to…")
				: t("Move to Trash");
	const mutationTitle = mutationDialog?.type === "create"
		? t(mutationDialog.kind === "file" ? "New file" : "New folder")
		: mutationDialog?.type === "rename" ? t("Rename {{name}}", { name: mutationDialog.entry.name })
			: mutationDialog?.type === "move" ? t("Move {{name}}", { name: mutationDialog.entry.name })
				: mutationDialog?.type === "trash" ? t("Move {{name}} to Trash?", { name: mutationDialog.entry.name }) : "";
	const hostedPreview = Boolean(activePath && isHostedPreviewKind(classifyPreviewKind(fileName(activePath))));

	return (
		<section
			aria-hidden={!visible}
			className={`file-panel${visible ? " is-visible" : ""}${treeOpen ? "" : " is-tree-hidden"}${isResizing ? " is-resizing" : ""}`}
			id={`file-panel-${sessionId}`}
			role="tabpanel"
			style={{ "--file-tree-width": `${treeWidth}px` } as React.CSSProperties}
		>
			<div className="file-preview">
				<header className="file-preview-toolbar">
					<div aria-label={t("File path")} className="file-breadcrumbs">
						<span>{rootName(cwd)}</span>
						{activePath?.split("/").map((part, index) => <span key={`${index}:${part}`}>{part}</span>)}
					</div>
					<div className="file-preview-actions">
						{displayedFile && activePath && (
							<>
								{displayedFile.kind === "text" && draftMatchesActivePath && (
									<button aria-label={t("Save file")} disabled={draft.text === draft.savedText || saving} onClick={() => void save().catch(onError)} title={t(saving ? "Saving…" : "Save")} type="button">
										<FloppyDisk aria-hidden="true" size={14} />
									</button>
								)}
								{displayedFile.kind === "text" && isMarkdown(activePath) && (
									<button aria-label={t(previewMode ? "View source" : "Show preview")} onClick={() => setPreviewMode((value) => !value)} title={t(previewMode ? "Source" : "Preview")} type="button">
										{previewMode ? <Code aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
									</button>
								)}
								<button aria-label={t("Copy path")} onClick={() => void copy(displayedFile.absolutePath, t("Path copied"))} title={t("Copy path")} type="button"><Copy aria-hidden="true" size={14} /></button>
								{displayedFile.kind === "text" && <button aria-label={t("Copy contents")} onClick={() => void copy(draftMatchesActivePath ? draft.text : displayedFile.text, t("Contents copied"))} title={t("Copy contents")} type="button"><FileText aria-hidden="true" size={14} /></button>}
								<div className="file-open-menu" ref={actionMenuRef}>
									<button aria-expanded={actionMenuOpen} aria-haspopup="menu" aria-label={t("Open file actions")} onClick={() => setActionMenuOpen((value) => !value)} title={t("Open file actions")} type="button"><DotsThree aria-hidden="true" size={16} /></button>
									{actionMenuOpen && <div aria-label={t("Open file actions")} className="file-open-popover" role="menu">
										<button onClick={() => open("default")} role="menuitem" type="button">{t("Open in default app")}</button>
										<button onClick={() => open("reveal")} role="menuitem" type="button">{t("Reveal in file manager")}</button>
									</div>}
								</div>
							</>
						)}
						<button aria-expanded={treeOpen} aria-label={t(treeOpen ? "Hide workspace tree" : "Show workspace tree")} className={`file-tree-toggle${treeOpen ? " is-active" : ""}`} onClick={() => setTreeOpen((val) => !val)} title={t(treeOpen ? "Hide workspace tree" : "Show workspace tree")} type="button"><SidebarSimple aria-hidden="true" size={14} /></button>
					</div>
				</header>
				{notice && <div className="file-preview-notice" role="status">{notice}</div>}
				<div className={`file-preview-body transcript-code${draftMatchesActivePath && !previewMode ? " has-editor" : ""}${hostedPreview ? " has-hosted-preview" : ""}`}>
					{!activePath ? (
						<div className="file-empty-state"><FolderOpen aria-hidden="true" size={29} /><strong>{t("Open file")}</strong><span>{t("Choose a file from the workspace tree")}</span></div>
					) : previewLoading ? (
						<div className="file-empty-state"><SpinnerGap aria-hidden="true" className="is-spinning" size={24} /><span>{t("Opening file…")}</span></div>
					) : previewError ? (
						<div className="file-empty-state is-error"><File aria-hidden="true" size={27} /><strong>{t("File could not be opened")}</strong><span>{previewError}</span></div>
					) : hostedPreview && activePath ? (
						<UniversalFilePreviewer
							active={visible}
							api={api}
							file={{
								source: "workspace",
								sessionId,
								relativePath: activePath,
								name: fileName(activePath),
							}}
							onError={onError}
						/>
					) : displayedFile?.kind === "binary" ? (
						<UniversalFilePreviewer
							api={api}
							file={{
								source: "workspace",
								sessionId,
								relativePath: displayedFile.relativePath,
								name: fileName(displayedFile.relativePath),
								byteLength: displayedFile.byteLength,
							}}
							onError={onError}
						/>
					) : displayedFile?.kind === "unsupported" ? (
						<div className="file-empty-state"><File aria-hidden="true" size={27} /><strong>{t(displayedFile.reason === "too-large" ? "File is too large to preview" : "Binary file cannot be previewed")}</strong><span>{t("Open it in the default app to inspect it")}</span></div>
					) : visible && draftMatchesActivePath && isMarkdown(draft.file.relativePath) && previewMode ? (
						<article className="file-markdown code-turn-answer"><Markdown text={draft.text} /></article>
					) : visible && draftMatchesActivePath ? (
						<CodeEditor
							label={t("Edit {{name}}", { name: fileName(draft.file.relativePath) })}
							onChange={(text) => { setNotice(null); onDraftChange(text); }}
							onSave={() => void save().catch(onError)}
							path={draft.file.relativePath}
							value={draft.text}
						/>
					) : null}
				</div>
			</div>

			<aside className="file-tree">
				{treeOpen && (
					<div
						aria-label={t("Resize file tree")}
						aria-orientation="vertical"
						aria-valuemax={MAX_TREE_WIDTH}
						aria-valuemin={MIN_TREE_WIDTH}
						aria-valuenow={treeWidth}
						className={`file-tree-resizer${isResizing ? " is-resizing" : ""}`}
						onDoubleClick={() => updateTreeWidth(DEFAULT_TREE_WIDTH)}
						onKeyDown={(event) => {
							if (event.key === "ArrowLeft") {
								event.preventDefault();
								updateTreeWidth(treeWidth + 16);
							} else if (event.key === "ArrowRight") {
								event.preventDefault();
								updateTreeWidth(treeWidth - 16);
							}
						}}
						onPointerDown={(event) => {
							resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: treeWidth };
							setIsResizing(true);
							event.currentTarget.setPointerCapture(event.pointerId);
						}}
						onPointerMove={(event) => {
							const start = resizeRef.current;
							if (!start || start.pointerId !== event.pointerId) return;
							updateTreeWidth(start.startWidth + (start.startX - event.clientX));
						}}
						onPointerUp={(event) => {
							if (resizeRef.current?.pointerId === event.pointerId) {
								resizeRef.current = null;
								setIsResizing(false);
							}
							event.currentTarget.releasePointerCapture(event.pointerId);
						}}
						role="separator"
						tabIndex={0}
					/>
				)}
				<div className="file-tree-toolbar">
					<div className="file-search-field">
						<MagnifyingGlass aria-hidden="true" size={14} />
						<input aria-label={t("Filter files")} onChange={(event) => setQuery(event.target.value)} placeholder={t("Filter files…")} type="search" value={query} />
						{searching && <SpinnerGap aria-hidden="true" className="is-spinning" size={13} />}
					</div>
					<button aria-label={t("New file")} onClick={() => beginCreate("file")} title={t("New file")} type="button"><FilePlus aria-hidden="true" size={14} /></button>
					<button aria-label={t("New folder")} onClick={() => beginCreate("directory")} title={t("New folder")} type="button"><FolderPlus aria-hidden="true" size={14} /></button>
				</div>
				<div aria-label={t("Workspace files")} className="file-tree-scroll" ref={treeScrollRef} role="tree">
					<div className="file-tree-virtual" style={{ height: virtualizer.getTotalSize() }}>
						{visibleRows.map((item) => {
							const row = rows[item.index]!;
							const entry = row.entry;
							const isExpanded = entry.kind === "directory" && expanded.has(entry.relativePath);
							const loading = loadingDirectories.has(entry.relativePath);
							return <div
								aria-expanded={entry.kind === "directory" ? isExpanded : undefined}
								className={`file-tree-row${activePath === entry.relativePath ? " is-active" : ""}${selectedEntry?.relativePath === entry.relativePath ? " is-selected" : ""}`}
								key={entry.relativePath}
								onContextMenu={(event) => {
									event.preventDefault();
									showTreeMenu(entry, event.clientX, event.clientY);
								}}
								role="treeitem"
								style={{ paddingLeft: 8 + row.depth * 17, transform: `translateY(${item.start}px)` }}
							>
								<button
									className="file-tree-row-select"
									onClick={() => {
										setSelectedEntry(entry);
										if (entry.kind === "directory") toggleDirectory(entry.relativePath);
										else onOpenFile(entry.relativePath, false);
									}}
									onDoubleClick={() => { if (entry.kind !== "directory") onOpenFile(entry.relativePath, true); }}
									title={entry.relativePath}
									type="button"
								>
									{entry.kind === "directory" ? (isExpanded ? <CaretDown aria-hidden="true" size={12} /> : <CaretRight aria-hidden="true" size={12} />) : <span className="file-tree-caret" />}
									<WorkspaceFileIcon expanded={isExpanded} kind={entry.kind} path={entry.relativePath} />
									<span>{query.trim() ? entry.relativePath : entry.name}</span>
									{loading && <SpinnerGap aria-hidden="true" className="is-spinning" size={12} />}
								</button>
								<button
									aria-label={t("Actions for {{name}}", { name: entry.name })}
									className="file-tree-row-actions"
									onClick={(event) => showTreeMenuFromButton(entry, event.currentTarget)}
									type="button"
								><DotsThree aria-hidden="true" size={14} /></button>
							</div>;
						})}
					</div>
					{!searching && rows.length === 0 && (
						<div className="file-tree-empty" role="status">
							{rootLoading ? (
								<><SpinnerGap aria-hidden="true" className="is-spinning" size={14} /><span>{t("Loading…")}</span></>
							) : (
								<>
									<span>{t(query.trim() ? "No matching files" : treeError ?? "This workspace is empty")}</span>
									{treeError && !query.trim() && <button onClick={() => void loadDirectory("")} type="button">{t("Retry")}</button>}
								</>
							)}
						</div>
					)}
				</div>
			</aside>

			{treeMenu && (
				<div
					aria-label={t("File actions")}
					className="file-tree-menu"
					ref={treeMenuRef}
					role="menu"
					style={{ left: treeMenu.left, top: treeMenu.top }}
				>
					{treeMenu.entry.kind === "directory" && <>
						<button onClick={() => beginCreate("file")} role="menuitem" type="button"><FilePlus aria-hidden="true" size={13} />{t("New file")}</button>
						<button onClick={() => beginCreate("directory")} role="menuitem" type="button"><FolderPlus aria-hidden="true" size={13} />{t("New folder")}</button>
						<div className="file-tree-menu-separator" />
					</>}
					<button disabled={treeMenu.entry.kind === "symlink" || pathListAffects(savingPaths, treeMenu.entry.relativePath)} onClick={() => beginEntryMutation("rename", treeMenu.entry)} role="menuitem" type="button"><PencilSimple aria-hidden="true" size={13} />{t("Rename")}</button>
					<button disabled={treeMenu.entry.kind === "symlink" || pathListAffects(savingPaths, treeMenu.entry.relativePath)} onClick={() => beginEntryMutation("move", treeMenu.entry)} role="menuitem" type="button"><FolderOpen aria-hidden="true" size={13} />{t("Move to…")}</button>
					<button className="is-destructive" disabled={treeMenu.entry.kind === "symlink" || pathListAffects(savingPaths, treeMenu.entry.relativePath)} onClick={() => beginEntryMutation("trash", treeMenu.entry)} role="menuitem" type="button"><Trash aria-hidden="true" size={13} />{t("Move to Trash")}</button>
				</div>
			)}

			{mutationDialog && (
				<div className="modal-backdrop">
					<div
						aria-label={mutationDialogLabel}
						aria-modal="true"
						className="interaction-dialog file-mutation-dialog"
						role="dialog"
					>
						<h2>{mutationTitle}</h2>
						{mutationDialog.type === "trash" ? (
							<>
								{affectedDirtyCount > 0 && <p>{t(affectedDirtyCount === 1
									? "Unsaved changes in {{count}} open file will be discarded."
									: "Unsaved changes in {{count}} open files will be discarded.", { count: affectedDirtyCount })}</p>}
								<p>{t("The saved version can be recovered from Trash.")}</p>
								<div className="interaction-actions">
									<button autoFocus className="button-secondary" disabled={mutationPending} onClick={() => setMutationDialog(null)} type="button">{t("Cancel")}</button>
									<button className="file-trash-confirm" disabled={mutationPending} onClick={submitDialog} type="button">{t(mutationPending ? "Moving…" : "Move to Trash")}</button>
								</div>
							</>
						) : (
							<form onSubmit={(event) => { event.preventDefault(); submitDialog(); }}>
								<label>
									<span>{t(mutationDialog.type === "move" ? "Destination folder" : "Name")}</span>
									<input
										autoFocus
										aria-label={t(mutationDialog.type === "move" ? "Destination folder" : "Name")}
										disabled={mutationPending}
										onChange={(event) => setMutationDialog((current) => {
											if (!current || current.type === "trash") return current;
											return current.type === "move"
												? { ...current, destinationDirectoryRelativePath: event.target.value }
												: { ...current, name: event.target.value };
										})}
										placeholder={mutationDialog.type === "move" ? t("Workspace root") : undefined}
										required={mutationDialog.type !== "move"}
										value={mutationDialog.type === "move" ? mutationDialog.destinationDirectoryRelativePath : mutationDialog.name}
									/>
								</label>
								<div className="interaction-actions">
									<button className="button-secondary" disabled={mutationPending} onClick={() => setMutationDialog(null)} type="button">{t("Cancel")}</button>
									<button disabled={mutationPending || (mutationDialog.type !== "move" && mutationDialog.name.length === 0)} type="submit">{t(
										mutationPending ? "Working…" : mutationDialog.type === "create" ? "Create" : mutationDialog.type === "rename" ? "Rename" : "Move",
									)}</button>
								</div>
							</form>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
