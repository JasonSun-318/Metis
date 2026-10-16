import {
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
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DesktopWorkspaceEntry,
	DesktopWorkspaceFile,
	DesktopWorkspaceMutationInput,
	DesktopWorkspaceMutationResult,
	MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import { CodeEditor, type CodeTextSelection } from "./CodeEditor.tsx";
import { Markdown } from "./Markdown.tsx";
import { DialogFrame } from "./ProjectActions.tsx";
import { useFileSelections } from "./preview/FileSelectionContext.tsx";
import { FileSelectionPopover } from "./preview/FileSelectionPopover.tsx";
import { type DraftFileSelection, selectionFromRange, selectionFromText } from "./preview/file-selection.ts";
import { classifyPreviewKind, isHostedPreviewKind } from "./preview/preview-kinds.ts";
import { UniversalFilePreviewer } from "./preview/UniversalFilePreviewer.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const DIRECTORY_CACHE_MS = 5_000;
const DEFAULT_TREE_WIDTH = 220;
const MIN_TREE_WIDTH = 140;
const MAX_TREE_WIDTH = 520;
const CREATE_ROW_KEY = "__metis_create__";

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

type InlineEdit =
	| {
			readonly type: "create";
			readonly kind: "directory" | "file";
			readonly parentRelativePath: string;
			readonly name: string;
	  }
	| { readonly type: "rename"; readonly entry: DesktopWorkspaceEntry; readonly name: string };

interface TreeMenu {
	readonly entry: DesktopWorkspaceEntry | null;
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

function pathListAffects(paths: readonly string[], relativePath: string): boolean {
	return paths.some((path) => path === relativePath || path.startsWith(`${relativePath}/`));
}

function isValidEntryName(name: string): boolean {
	return name !== "." && name !== ".." && !/[\\/\0]/u.test(name);
}

function isWorkspaceNotAFileError(cause: unknown): boolean {
	return (cause instanceof Error ? cause.message : String(cause)).includes("Workspace target is not a file");
}

function withCreateRow(rows: readonly TreeRow[], edit: Extract<InlineEdit, { type: "create" }>): TreeRow[] {
	const parentIndex = edit.parentRelativePath
		? rows.findIndex((row) => row.entry.relativePath === edit.parentRelativePath)
		: -1;
	const draft: TreeRow = {
		entry: { name: edit.name, relativePath: CREATE_ROW_KEY, kind: edit.kind },
		depth: parentIndex >= 0 ? rows[parentIndex]!.depth + 1 : 0,
	};
	if (parentIndex < 0) return [draft, ...rows];
	return [...rows.slice(0, parentIndex + 1), draft, ...rows.slice(parentIndex + 1)];
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
	const selectionActions = useFileSelections();
	const previewBodyRef = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState<{ draft: DraftFileSelection; range: Range } | null>(null);
	const [selectionOpen, setSelectionOpen] = useState(false);
	const [selectionError, setSelectionError] = useState("");
	const currentDraft = useRef(draft);
	currentDraft.current = draft;
	// biome-ignore lint/correctness/useExhaustiveDependencies(draft?.text): Edits invalidate text selection offsets.
	// biome-ignore lint/correctness/useExhaustiveDependencies(visible): Visibility changes dismiss stale text selection popovers.
	// biome-ignore lint/correctness/useExhaustiveDependencies(sessionId): Changing sessions invalidates the previous text selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(activePath): Changing the file invalidates the previous text selection.
	useEffect(() => {
		setSelection(null);
		setSelectionOpen(false);
		setSelectionError("");
	}, [activePath, sessionId, visible, draft?.text]);
	const cacheRef = useRef(new Map<string, CachedDirectory>());
	const loadingDirectoriesRef = useRef(new Set<string>());
	const treeScrollRef = useRef<HTMLDivElement>(null);
	const actionMenuRef = useRef<HTMLDivElement>(null);
	const treeMenuRef = useRef<HTMLDivElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const trashCancelRef = useRef<HTMLButtonElement>(null);
	const inlineEditRef = useRef<InlineEdit | null>(null);
	const inlineLockedRef = useRef(false);
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
	const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
	const [trashEntry, setTrashEntry] = useState<DesktopWorkspaceEntry | null>(null);
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
	inlineEditRef.current = inlineEdit;

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

	const captureSelection = (editor?: CodeTextSelection) => {
		if (!visible || !draftMatchesActivePath || !activePath || !selectionActions?.enabled) return;
		const root = previewBodyRef.current;
		const native = window.getSelection();
		if (!root || (!editor && !native?.rangeCount)) return;
		const range = editor?.range ?? native!.getRangeAt(0).cloneRange();
		const target = { source: "workspace" as const, sessionId, relativePath: activePath, name: fileName(activePath) };
		try {
			const quote = editor
				? selectionFromText({
						file: target,
						sourceText: editor.text,
						selectedText: editor.text.slice(editor.from, editor.to),
						basis: "source",
						start: editor.from,
						end: editor.to,
					})
				: selectionFromRange({
						root,
						range,
						file: target,
						sourceText: draft.text,
						displayText: draft.text,
						kind: "markdown",
						selectedText: native!.toString(),
					});
			if (quote) {
				setSelection({ draft: quote, range });
				setSelectionOpen(true);
				setSelectionError("");
			}
		} catch (cause) {
			setSelectionOpen(false);
			setSelectionError(cause instanceof Error ? cause.message : "Failed to add reference");
		}
	};

	// Refresh clean editor drafts after agent writes; never overwrite local unsaved edits.
	useEffect(() => {
		if (!visible || !activePath) return;
		let cancelled = false;
		let read = 0;
		const refresh = async () => {
			const before = currentDraft.current;
			if (before?.file.relativePath !== activePath || before.text !== before.savedText) return;
			const generation = ++read;
			try {
				const result = await api.readWorkspaceFile({ sessionId, relativePath: activePath });
				if (cancelled || generation !== read || currentDraft.current !== before) return;
				if (result.kind === "text") onDraftLoadedRef.current(result);
			} catch (cause) {
				if (!cancelled && generation === read) onError(cause);
			}
		};
		void refresh();
		const unsubscribe = api.subscribe?.((event) => {
			if (
				event.type === "app-server" &&
				event.envelope.method === "connection/events" &&
				event.envelope.params.events.some(
					(event) =>
						(event.type === "turn/completed" || event.type === "turn/interrupted") &&
						event.turn.sessionId === sessionId,
				)
			)
				void refresh();
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [activePath, api, sessionId, visible, onError]);

	const loadDirectory = useCallback(
		async (relativePath: string) => {
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
		},
		[api, onError, sessionId, t],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies(treeVersion): Directory cache updates require loading newly reachable expanded paths.
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
				setPreviewError(
					isWorkspaceNotAFileError(cause)
						? t("Choose a file from the workspace tree")
						: cause instanceof Error
							? cause.message
							: t("File could not be opened"),
				);
				setPreviewLoading(false);
				if (!isWorkspaceNotAFileError(cause)) onError(cause);
			},
		);
	}, [activePath, api, draftMatchesActivePath, onError, sessionId, t, visible]);

	useEffect(() => {
		if (!actionMenuOpen) return;
		const close = (event: PointerEvent) => {
			if (!actionMenuRef.current?.contains(event.target as Node)) setActionMenuOpen(false);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setActionMenuOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [actionMenuOpen]);

	useEffect(() => {
		if (!treeMenu) return;
		const closeMenu = (event: PointerEvent) => {
			if (!treeMenuRef.current?.contains(event.target as Node)) setTreeMenu(null);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || mutationPending || inlineEdit || trashEntry) return;
			setTreeMenu(null);
		};
		document.addEventListener("pointerdown", closeMenu);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", closeMenu);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [inlineEdit, mutationPending, trashEntry, treeMenu]);

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
		if (inlineEdit?.type === "create") return withCreateRow(treeRows, inlineEdit);
		if (!query.trim()) return treeRows;
		return searchResults.map((relativePath) => ({
			entry: { name: fileName(relativePath), relativePath, kind: "file" },
			depth: 0,
		}));
	}, [inlineEdit, query, searchResults, treeRows]);
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
	const visibleRows =
		measuredRows.length > 0
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
	const showTreeMenu = (entry: DesktopWorkspaceEntry | null, left: number, top: number) => {
		if (entry) setSelectedEntry(entry);
		setTreeMenu({
			entry,
			left: Math.max(8, Math.min(window.innerWidth - 190, left)),
			top: Math.max(8, Math.min(window.innerHeight - (entry ? 170 : 80), top)),
		});
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
	const beginInlineEdit = (next: InlineEdit) => {
		inlineLockedRef.current = false;
		setTreeMenu(null);
		setQuery("");
		setSearchResults([]);
		setInlineEdit(next);
	};
	const beginCreate = (kind: "directory" | "file", parentRelativePath: string) => {
		if (parentRelativePath && !expanded.has(parentRelativePath)) {
			onExpandedPathsChange([...expandedPaths, parentRelativePath]);
			void loadDirectory(parentRelativePath);
		}
		beginInlineEdit({ type: "create", kind, parentRelativePath, name: "" });
	};
	const beginEntryMutation = (type: "rename" | "trash", entry: DesktopWorkspaceEntry) => {
		setTreeMenu(null);
		if (type === "rename") beginInlineEdit({ type: "rename", entry, name: entry.name });
		else setTrashEntry(entry);
	};
	const cancelInlineEdit = () => {
		inlineLockedRef.current = true;
		setInlineEdit(null);
	};
	const submitMutation = async (input: DesktopWorkspaceMutationInput) => {
		const relativePath = input.action === "create" ? null : input.relativePath;
		if (relativePath && pathListAffects(savingPaths, relativePath)) {
			onError(new Error(t("Wait for the file to finish saving.")));
			inlineLockedRef.current = false;
			return;
		}
		setMutationPending(true);
		try {
			const result = await api.mutateWorkspaceEntry(input);
			cacheRef.current.clear();
			setTreeVersion((value) => value + 1);
			setQuery("");
			setSearchResults([]);
			setTrashEntry(null);
			setInlineEdit(null);
			if (result.action === "create") {
				const created = {
					name: fileName(result.relativePath),
					relativePath: result.relativePath,
					kind: result.kind,
				} satisfies DesktopWorkspaceEntry;
				setSelectedEntry(created);
				if (result.kind === "directory")
					onExpandedPathsChange([...new Set([...expandedPaths, result.relativePath])]);
			} else if (result.action === "trash") {
				if (selectedEntry && pathListAffects([selectedEntry.relativePath], result.previousRelativePath))
					setSelectedEntry(null);
			} else {
				setSelectedEntry((current) => {
					if (!current || !pathListAffects([current.relativePath], result.previousRelativePath)) return current;
					const relativePath = `${result.relativePath}${current.relativePath.slice(result.previousRelativePath.length)}`;
					return { ...current, name: fileName(relativePath), relativePath };
				});
			}
			onWorkspaceMutation(result);
			setNotice(
				t(
					result.action === "create"
						? "Created"
						: result.action === "rename"
							? "Renamed"
							: result.action === "move"
								? "Moved"
								: "Moved to Trash",
				),
			);
		} catch (cause) {
			inlineLockedRef.current = false;
			const message = cause instanceof Error ? cause.message : String(cause);
			const translated = new Map([
				["Workspace destination already exists", "An item with this name already exists."],
				["Workspace root cannot be changed", "The workspace root cannot be changed."],
				["Workspace symbolic links are read-only", "Symbolic links are read-only."],
				["Invalid workspace entry name", "Enter a valid name."],
			]);
			onError(new Error(t(translated.get(message) ?? message)));
		} finally {
			setMutationPending(false);
		}
	};
	const commitInlineEdit = () => {
		if (inlineLockedRef.current) return;
		const edit = inlineEditRef.current;
		if (!edit) return;
		const name = (nameInputRef.current?.value ?? edit.name).trim();
		if (!name || (edit.type === "rename" && name === edit.entry.name)) {
			cancelInlineEdit();
			return;
		}
		if (!isValidEntryName(name)) {
			onError(new Error(t("Enter a valid name.")));
			return;
		}
		inlineLockedRef.current = true;
		if (edit.type === "create") {
			void submitMutation({
				action: "create",
				sessionId,
				parentRelativePath: edit.parentRelativePath,
				name,
				kind: edit.kind,
			});
			return;
		}
		void submitMutation({
			action: "rename",
			sessionId,
			relativePath: edit.entry.relativePath,
			name,
		});
	};
	const submitTrash = () => {
		if (!trashEntry) return;
		void submitMutation({ action: "trash", sessionId, relativePath: trashEntry.relativePath });
	};
	const inlineSessionKey = inlineEdit
		? inlineEdit.type === "create"
			? `create:${inlineEdit.kind}:${inlineEdit.parentRelativePath}`
			: `rename:${inlineEdit.entry.relativePath}`
		: "";
	useLayoutEffect(() => {
		if (!inlineSessionKey) return;
		const input = nameInputRef.current;
		const edit = inlineEditRef.current;
		if (!input || !edit) return;
		input.focus();
		if (edit.type === "rename" && edit.entry.kind === "file") {
			const index = edit.name.lastIndexOf(".");
			if (index > 0) input.setSelectionRange(0, index);
			else input.select();
			return;
		}
		input.select();
	}, [inlineSessionKey]);
	const affectedDirtyCount = trashEntry
		? dirtyPaths.filter((path) => path === trashEntry.relativePath || path.startsWith(`${trashEntry.relativePath}/`))
				.length
		: 0;
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
					<nav aria-label={t("File path")} className="file-breadcrumbs">
						<span>{rootName(cwd)}</span>
						{activePath?.split("/").map((part, index) => (
							<span key={`${index}:${part}`}>{part}</span>
						))}
					</nav>
					<div className="file-preview-actions">
						{displayedFile && activePath && (
							<>
								{displayedFile.kind === "text" && draftMatchesActivePath && (
									<button
										aria-label={t("Save file")}
										disabled={draft.text === draft.savedText || saving}
										onClick={() => void save().catch(onError)}
										title={t(saving ? "Saving…" : "Save")}
										type="button"
									>
										<FloppyDisk aria-hidden="true" size={14} />
									</button>
								)}
								{displayedFile.kind === "text" && isMarkdown(activePath) && (
									<button
										aria-label={t(previewMode ? "View source" : "Show preview")}
										onClick={() => setPreviewMode((value) => !value)}
										title={t(previewMode ? "Source" : "Preview")}
										type="button"
									>
										{previewMode ? (
											<Code aria-hidden="true" size={14} />
										) : (
											<Eye aria-hidden="true" size={14} />
										)}
									</button>
								)}
								<button
									aria-label={t("Copy path")}
									onClick={() => void copy(displayedFile.absolutePath, t("Path copied"))}
									title={t("Copy path")}
									type="button"
								>
									<Copy aria-hidden="true" size={14} />
								</button>
								{displayedFile.kind === "text" && (
									<button
										aria-label={t("Copy contents")}
										onClick={() =>
											void copy(
												draftMatchesActivePath ? draft.text : displayedFile.text,
												t("Contents copied"),
											)
										}
										title={t("Copy contents")}
										type="button"
									>
										<FileText aria-hidden="true" size={14} />
									</button>
								)}
								<div className="file-open-menu" ref={actionMenuRef}>
									<button
										aria-expanded={actionMenuOpen}
										aria-haspopup="menu"
										aria-label={t("Open file actions")}
										onClick={() => setActionMenuOpen((value) => !value)}
										title={t("Open file actions")}
										type="button"
									>
										<DotsThree aria-hidden="true" size={16} />
									</button>
									{actionMenuOpen && (
										<div aria-label={t("Open file actions")} className="file-open-popover" role="menu">
											<button onClick={() => open("default")} role="menuitem" type="button">
												{t("Open in default app")}
											</button>
											<button onClick={() => open("reveal")} role="menuitem" type="button">
												{t("Reveal in file manager")}
											</button>
										</div>
									)}
								</div>
							</>
						)}
						<button
							aria-expanded={treeOpen}
							aria-label={t(treeOpen ? "Hide workspace tree" : "Show workspace tree")}
							className={`file-tree-toggle${treeOpen ? " is-active" : ""}`}
							onClick={() => setTreeOpen((val) => !val)}
							title={t(treeOpen ? "Hide workspace tree" : "Show workspace tree")}
							type="button"
						>
							<SidebarSimple aria-hidden="true" size={14} />
						</button>
					</div>
				</header>
				{notice && <output className="status-block file-preview-notice">{notice}</output>}
				<div
					role="document"
					ref={previewBodyRef}
					onPointerUp={(event) => {
						if (previewMode && event.button === 0) captureSelection();
					}}
					onKeyUp={(event) => {
						if (previewMode && (event.key === "Shift" || event.shiftKey)) captureSelection();
					}}
					className={`file-preview-body transcript-code${draftMatchesActivePath && !previewMode ? " has-editor" : ""}${hostedPreview ? " has-hosted-preview" : ""}`}
				>
					{!activePath ? (
						<div className="file-empty-state">
							<FolderOpen aria-hidden="true" size={29} />
							<strong>{t("Open file")}</strong>
							<span>{t("Choose a file from the workspace tree")}</span>
						</div>
					) : previewLoading ? (
						<div className="file-empty-state">
							<SpinnerGap aria-hidden="true" className="is-spinning" size={24} />
							<span>{t("Opening file…")}</span>
						</div>
					) : previewError ? (
						<div className="file-empty-state is-error">
							<File aria-hidden="true" size={27} />
							<strong>{t("File could not be opened")}</strong>
							<span>{previewError}</span>
						</div>
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
						<div className="file-empty-state">
							<File aria-hidden="true" size={27} />
							<strong>
								{t(
									displayedFile.reason === "too-large"
										? "File is too large to preview"
										: "Binary file cannot be previewed",
								)}
							</strong>
							<span>{t("Open it in the default app to inspect it")}</span>
						</div>
					) : visible && draftMatchesActivePath && isMarkdown(draft.file.relativePath) && previewMode ? (
						<article className="file-markdown code-turn-answer">
							<Markdown text={draft.text} sourcePositions />
						</article>
					) : visible && draftMatchesActivePath ? (
						<CodeEditor
							onSelect={captureSelection}
							label={t("Edit {{name}}", { name: fileName(draft.file.relativePath) })}
							onChange={(text) => {
								setNotice(null);
								onDraftChange(text);
							}}
							onSave={() => void save().catch(onError)}
							path={draft.file.relativePath}
							value={draft.text}
						/>
					) : null}
				</div>
				{selectionError && (
					<div className="selection-error" role="alert">
						{t(selectionError)}
					</div>
				)}
				{selection && selectionActions && (
					<FileSelectionPopover
						key={selection.draft.id}
						selection={selection.draft}
						range={selection.range}
						open={selectionOpen && visible}
						enabled={selectionActions.enabled && draft?.text === draft?.savedText}
						disabledReason={
							draft?.text !== draft?.savedText ? t("Save this file before referencing its contents") : undefined
						}
						onAdd={() => selectionActions.add(selection.draft)}
						onRequestChange={(instruction) => selectionActions.requestChange(selection.draft, instruction)}
						onDismiss={() => setSelectionOpen(false)}
						onAccepted={() => requestAnimationFrame(() => document.getElementById("composer-input")?.focus())}
					/>
				)}
			</div>

			<aside className="file-tree">
				{treeOpen && (
					<hr
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
						tabIndex={0}
					/>
				)}
				<div className="file-tree-toolbar">
					<div className="file-search-field">
						<MagnifyingGlass aria-hidden="true" size={14} />
						<input
							aria-label={t("Filter files")}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("Filter files…")}
							type="search"
							value={query}
						/>
						{searching && <SpinnerGap aria-hidden="true" className="is-spinning" size={13} />}
					</div>
				</div>
				<div
					aria-label={t("Workspace files")}
					className="file-tree-scroll"
					onContextMenu={(event) => {
						if ((event.target as Element).closest(".file-tree-row")) return;
						event.preventDefault();
						showTreeMenu(null, event.clientX, event.clientY);
					}}
					ref={treeScrollRef}
					role="tree"
				>
					<div className="file-tree-virtual" style={{ height: virtualizer.getTotalSize() }}>
						{visibleRows.map((item) => {
							const row = rows[item.index]!;
							const entry = row.entry;
							const isCreateRow = entry.relativePath === CREATE_ROW_KEY;
							const isRenaming =
								inlineEdit?.type === "rename" && inlineEdit.entry.relativePath === entry.relativePath;
							const isEditing = isCreateRow || isRenaming;
							const editName =
								isCreateRow && inlineEdit?.type === "create"
									? inlineEdit.name
									: isRenaming && inlineEdit?.type === "rename"
										? inlineEdit.name
										: entry.name;
							const isExpanded = entry.kind === "directory" && expanded.has(entry.relativePath);
							const loading = loadingDirectories.has(entry.relativePath);
							const rowBody = (
								<>
									{entry.kind === "directory" ? (
										<CaretRight
											aria-hidden="true"
											className={`file-tree-caret ${isExpanded ? "is-expanded" : ""}`}
											size={12}
										/>
									) : (
										<span className="file-tree-caret" />
									)}
									<WorkspaceFileIcon
										expanded={isExpanded}
										kind={entry.kind}
										path={isCreateRow ? editName : entry.relativePath}
									/>
									{isEditing ? (
										<input
											aria-label={t("Name")}
											autoCapitalize="off"
											autoComplete="off"
											autoCorrect="off"
											className="file-tree-name-input"
											disabled={mutationPending}
											onBlur={commitInlineEdit}
											onChange={(event) =>
												setInlineEdit((current) =>
													current ? { ...current, name: event.target.value } : current,
												)
											}
											onContextMenu={(event) => event.stopPropagation()}
											onKeyDown={(event) => {
												if (event.key === "Enter") {
													event.preventDefault();
													commitInlineEdit();
												} else if (event.key === "Escape") {
													event.preventDefault();
													event.stopPropagation();
													cancelInlineEdit();
												}
											}}
											ref={nameInputRef}
											spellCheck={false}
											value={editName}
										/>
									) : (
										<span>{query.trim() ? entry.relativePath : entry.name}</span>
									)}
									{loading && <SpinnerGap aria-hidden="true" className="is-spinning" size={12} />}
								</>
							);
							return (
								<div
									tabIndex={-1}
									aria-expanded={entry.kind === "directory" ? isExpanded : undefined}
									className={`file-tree-row${activePath === entry.relativePath ? " is-active" : ""}${selectedEntry?.relativePath === entry.relativePath || isEditing ? " is-selected" : ""}`}
									key={entry.relativePath}
									onContextMenu={(event) => {
										event.preventDefault();
										event.stopPropagation();
										if (isEditing) return;
										showTreeMenu(entry, event.clientX, event.clientY);
									}}
									role="treeitem"
									style={{ paddingLeft: 8 + row.depth * 17, transform: `translateY(${item.start}px)` }}
								>
									{isEditing ? (
										<div className="file-tree-row-select is-editing">{rowBody}</div>
									) : (
										<button
											className="file-tree-row-select"
											onClick={() => {
												setSelectedEntry(entry);
												if (entry.kind === "directory") toggleDirectory(entry.relativePath);
												else onOpenFile(entry.relativePath, false);
											}}
											onDoubleClick={() => {
												if (entry.kind !== "directory") onOpenFile(entry.relativePath, true);
											}}
											title={entry.relativePath}
											type="button"
										>
											{rowBody}
										</button>
									)}
								</div>
							);
						})}
					</div>
					{!searching && rows.length === 0 && (
						<output className="status-block file-tree-empty">
							{rootLoading ? (
								<>
									<SpinnerGap aria-hidden="true" className="is-spinning" size={14} />
									<span>{t("Loading…")}</span>
								</>
							) : (
								<>
									<span>
										{t(query.trim() ? "No matching files" : (treeError ?? "This workspace is empty"))}
									</span>
									{treeError && !query.trim() && (
										<button onClick={() => void loadDirectory("")} type="button">
											{t("Retry")}
										</button>
									)}
								</>
							)}
						</output>
					)}
				</div>
			</aside>

			{treeMenu &&
				(() => {
					const menuEntry = treeMenu.entry;
					return (
						<div
							aria-label={t("File actions")}
							className="file-tree-menu"
							ref={treeMenuRef}
							role="menu"
							style={{ left: treeMenu.left, top: treeMenu.top }}
						>
							{(menuEntry === null || menuEntry.kind === "directory") && (
								<>
									<button
										onClick={() => beginCreate("file", menuEntry?.relativePath ?? "")}
										role="menuitem"
										type="button"
									>
										<FilePlus aria-hidden="true" size={13} />
										{t("New file")}
									</button>
									<button
										onClick={() => beginCreate("directory", menuEntry?.relativePath ?? "")}
										role="menuitem"
										type="button"
									>
										<FolderPlus aria-hidden="true" size={13} />
										{t("New folder")}
									</button>
									{menuEntry && <div className="file-tree-menu-separator" />}
								</>
							)}
							{menuEntry && (
								<>
									<button
										disabled={
											menuEntry.kind === "symlink" || pathListAffects(savingPaths, menuEntry.relativePath)
										}
										onClick={() => beginEntryMutation("rename", menuEntry)}
										role="menuitem"
										type="button"
									>
										<PencilSimple aria-hidden="true" size={13} />
										{t("Rename")}
									</button>
									<button
										className="is-destructive"
										disabled={
											menuEntry.kind === "symlink" || pathListAffects(savingPaths, menuEntry.relativePath)
										}
										onClick={() => beginEntryMutation("trash", menuEntry)}
										role="menuitem"
										type="button"
									>
										<Trash aria-hidden="true" size={13} />
										{t("Move to Trash")}
									</button>
								</>
							)}
						</div>
					);
				})()}

			{trashEntry && (
				<DialogFrame
					cancellable={!mutationPending}
					className="project-dialog file-trash-dialog"
					descriptionId="file-trash-description"
					initialFocus={trashCancelRef}
					onCancel={() => setTrashEntry(null)}
					titleId="file-trash-title"
				>
					<h2 id="file-trash-title">{t("Move {{name}} to Trash?", { name: trashEntry.name })}</h2>
					<div id="file-trash-description">
						{affectedDirtyCount > 0 && (
							<p>
								{t(
									affectedDirtyCount === 1
										? "Unsaved changes in {{count}} open file will be discarded."
										: "Unsaved changes in {{count}} open files will be discarded.",
									{ count: affectedDirtyCount },
								)}
							</p>
						)}
						<p>{t("The saved version can be recovered from Trash.")}</p>
					</div>
					<div className="project-dialog-actions">
						<button
							className="button-secondary"
							disabled={mutationPending}
							onClick={() => setTrashEntry(null)}
							ref={trashCancelRef}
							type="button"
						>
							{t("Cancel")}
						</button>
						<button
							className="project-delete-confirm"
							disabled={mutationPending}
							onClick={submitTrash}
							type="button"
						>
							{t(mutationPending ? "Moving…" : "Move to Trash")}
						</button>
					</div>
				</DialogFrame>
			)}
		</section>
	);
}
