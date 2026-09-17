import type {
	MemoryChangelogEntryView,
	MemoryNoteSummaryView,
	MemoryNoteTypeView,
	MemorySettingsView,
} from "@metis/app-protocol";
import { PatchDiff, WorkerPoolContextProvider, type WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import {
	ArrowCounterClockwise,
	Brain,
	FilePlus,
	FolderOpen,
	Info,
	MagnifyingGlass,
	Moon,
	Trash,
	XCircle,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { FloatingSystemNotice } from "./SystemNotice.tsx";

const HISTORY_LIMIT = 20;
const NOTES_LIMIT = 100;
/** Ops that leave an undoable snapshot in the vault changelog. */
const UNDOABLE_OPS = new Set(["create", "append", "replace", "str_replace", "rename", "delete"]);
const NOTE_TYPES: readonly MemoryNoteTypeView[] = ["user", "feedback", "project", "reference", "decision"];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const DIFF_OPTIONS: NonNullable<React.ComponentProps<typeof PatchDiff>["options"]> = {
	diffStyle: "unified",
	disableFileHeader: true,
	hunkSeparators: "line-info-basic",
	lineDiffType: "word-alt",
	overflow: "scroll",
};

const DIFF_WORKER_POOL = {
	poolSize: 2,
	totalASTLRUCacheSize: 24,
	workerFactory: () => new Worker(new URL("../workers/diff-worker.ts", import.meta.url), { type: "module" }),
};

const DIFF_HIGHLIGHTER: Record<"dark" | "light", WorkerInitializationRenderOptions> = {
	dark: { theme: "pierre-dark", lineDiffType: "word-alt", langs: ["markdown"] },
	light: { theme: "pierre-light", lineDiffType: "word-alt", langs: ["markdown"] },
};

interface NoteDraft {
	readonly scope: "global" | "project";
	/** Persisted slug; null while the note is unsaved/new. */
	readonly originalSlug: string | null;
	slug: string;
	name: string;
	description: string;
	type: MemoryNoteTypeView;
	body: string;
}

function draftFrom(scope: "global" | "project", note: {
	readonly slug: string;
	readonly name: string;
	readonly description: string;
	readonly type: MemoryNoteTypeView;
	readonly body: string;
}): NoteDraft {
	return {
		scope,
		originalSlug: note.slug,
		slug: note.slug,
		name: note.name,
		description: note.description,
		type: note.type,
		body: note.body,
	};
}

function draftDirty(draft: NoteDraft | null, saved: NoteDraft | null): boolean {
	if (!draft) return false;
	if (!saved) return true;
	return (
		draft.slug !== saved.slug ||
		draft.name !== saved.name ||
		draft.description !== saved.description ||
		draft.type !== saved.type ||
		draft.body !== saved.body
	);
}

function changeTarget(entry: MemoryChangelogEntryView): string {
	return "slug" in entry.target ? entry.target.slug : `_${entry.target.block}`;
}

function changeSummary(entry: MemoryChangelogEntryView): string {
	return `${entry.op} · ${entry.scope} · ${entry.actor.kind}`;
}

function changeTimestamp(entry: MemoryChangelogEntryView): string {
	const parsed = Date.parse(entry.ts);
	return Number.isNaN(parsed) ? entry.ts : new Date(parsed).toLocaleString();
}

function dreamTimestamp(at: string): string {
	const parsed = Date.parse(at);
	return Number.isNaN(parsed) ? at : new Date(parsed).toLocaleString();
}

type DiffState = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "loaded"; readonly patch?: string };

export function MemorySettingsPanel({ api, onDirtyChange, serverReady, sessionId, theme = "dark" }: {
	readonly api: Pick<
		MetisDesktopApi,
		| "getMemorySettings"
		| "updateMemorySettings"
		| "listMemoryNotes"
		| "readMemoryNote"
		| "writeMemoryNote"
		| "listMemoryHistory"
		| "readMemoryHistory"
		| "undoMemoryChange"
		| "undoMemoryRun"
		| "runMemoryDream"
		| "setSessionMemoryFlags"
	>;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly serverReady: boolean;
	readonly sessionId?: string;
	readonly theme?: "dark" | "light";
}) {
	const { t } = useTranslation();
	const [settings, setSettings] = useState<MemorySettingsView | null>(null);
	const [savedSettings, setSavedSettings] = useState<MemorySettingsView | null>(null);
	const [history, setHistory] = useState<MemoryChangelogEntryView[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [undoBusy, setUndoBusy] = useState<string | null>(null);
	const [dreamBusy, setDreamBusy] = useState<"run" | "undo" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [sessionFlagBusy, setSessionFlagBusy] = useState(false);
	const [notesScope, setNotesScope] = useState<"global" | "project">("global");
	const [notesQuery, setNotesQuery] = useState("");
	const [notes, setNotes] = useState<MemoryNoteSummaryView[] | null>(null);
	const [notesError, setNotesError] = useState<string | null>(null);
	const [draft, setDraft] = useState<NoteDraft | null>(null);
	const [savedDraft, setSavedDraft] = useState<NoteDraft | null>(null);
	const [noteBusy, setNoteBusy] = useState<"load" | "save" | "delete" | null>(null);
	const [expandedChange, setExpandedChange] = useState<string | null>(null);
	const [diffs, setDiffs] = useState<Record<string, DiffState>>({});

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void Promise.all([
			api.getMemorySettings(sessionId === undefined ? undefined : { sessionId }),
			api.listMemoryHistory({ limit: HISTORY_LIMIT }),
		]).then(
			([view, recent]) => {
				if (!current) return;
				setSettings(view);
				setSavedSettings(view);
				setHistory([...recent.entries]);
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Couldn’t load memory settings."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, serverReady, sessionId, t]);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		const query = notesQuery.trim();
		void api
			.listMemoryNotes({
				...(sessionId === undefined ? {} : { sessionId }),
				scope: notesScope,
				...(query === "" ? {} : { query }),
				limit: NOTES_LIMIT,
			})
			.then(
				(result) => {
					if (current) {
						setNotes([...result.notes]);
						setNotesError(null);
					}
				},
				(cause) => {
					if (current) setNotesError(cause instanceof Error ? cause.message : t("Couldn’t load memory notes."));
				},
			);
		return () => {
			current = false;
		};
	}, [api, serverReady, sessionId, notesScope, notesQuery, t]);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 2_500);
		return () => clearTimeout(timer);
	}, [notice]);

	const settingsDirty = Boolean(
		savedSettings &&
			settings &&
			(settings.enabled !== savedSettings.enabled ||
				settings.activeContext !== savedSettings.activeContext ||
				settings.dream.enabled !== savedSettings.dream.enabled),
	);
	const noteDirty = draftDirty(draft, savedDraft);
	const dirty = settingsDirty || noteDirty;
	useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	const reloadHistory = async () => {
		const recent = await api.listMemoryHistory({ limit: HISTORY_LIMIT });
		setHistory([...recent.entries]);
	};

	const reloadNotes = async () => {
		const query = notesQuery.trim();
		const result = await api.listMemoryNotes({
			...(sessionId === undefined ? {} : { sessionId }),
			scope: notesScope,
			...(query === "" ? {} : { query }),
			limit: NOTES_LIMIT,
		});
		setNotes([...result.notes]);
	};

	/** Refresh the view + history after a dream run; in-progress toggle edits survive. */
	const reloadAfterDream = async () => {
		const [view, recent] = await Promise.all([
			api.getMemorySettings(sessionId === undefined ? undefined : { sessionId }),
			api.listMemoryHistory({ limit: HISTORY_LIMIT }),
		]);
		setHistory([...recent.entries]);
		setSavedSettings(view);
		setSettings((current) =>
			current === null
				? view
				: {
						...view,
						enabled: current.enabled,
						activeContext: current.activeContext,
						dream: { ...view.dream, enabled: current.dream.enabled },
					},
		);
		void reloadNotes().catch(() => undefined);
	};

	const runDreamNow = async () => {
		setDreamBusy("run");
		setError(null);
		setNotice(null);
		try {
			const result = await api.runMemoryDream();
			if (!result.ok) {
				setError(result.error ?? t("Couldn’t run memory consolidation."));
				return;
			}
			setNotice(t("Dream finished"));
			await reloadAfterDream();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t run memory consolidation."));
		} finally {
			setDreamBusy(null);
		}
	};

	const undoDreamRun = async (runId: string) => {
		setDreamBusy("undo");
		setError(null);
		setNotice(null);
		try {
			const result = await api.undoMemoryRun({ runId });
			if (result.undone.length === 0 && result.skipped.length === 0) {
				setError(t("Nothing left to undo for the last dream."));
				return;
			}
			setNotice(
				result.skipped.length > 0
					? t("Undid the last dream; {{count}} change(s) were already modified", { count: result.skipped.length })
					: t("Undid the last dream"),
			);
			await reloadAfterDream();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t undo the last dream."));
		} finally {
			setDreamBusy(null);
		}
	};

	const update = (patch: Partial<Pick<MemorySettingsView, "enabled" | "activeContext">>) => {
		setSettings((current) => (current ? { ...current, ...patch } : current));
		setNotice(null);
		setError(null);
	};

	const toggleDream = (enabled: boolean) => {
		setSettings((current) => (current ? { ...current, dream: { ...current.dream, enabled } } : current));
		setNotice(null);
		setError(null);
	};

	const setSessionFlag = async (patch: { useMemory?: boolean; contributeMemory?: boolean }) => {
		if (sessionId === undefined || !settings?.session) return;
		setSessionFlagBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.setSessionMemoryFlags({ sessionId, requestId: crypto.randomUUID(), ...patch });
			setSettings((current) => (current ? { ...current, session: next } : current));
			setSavedSettings((current) => (current ? { ...current, session: next } : current));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t update this session’s memory settings."));
		} finally {
			setSessionFlagBusy(false);
		}
	};

	const save = async () => {
		if (!settings) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateMemorySettings({
				enabled: settings.enabled,
				activeContext: settings.activeContext,
				dream: { enabled: settings.dream.enabled },
			});
			setSettings(next);
			setSavedSettings(next);
			setNotice(t("Saved"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save memory settings."));
		} finally {
			setBusy(false);
		}
	};

	const undo = async (entry: MemoryChangelogEntryView) => {
		setUndoBusy(entry.id);
		setError(null);
		try {
			const result = await api.undoMemoryChange({ changeId: entry.id });
			if (!result.ok) {
				setError(result.error ?? t("Couldn’t undo the memory change."));
				return;
			}
			await reloadHistory();
			setDiffs((current) => {
				if (!(entry.id in current)) return current;
				const next = { ...current };
				delete next[entry.id];
				return next;
			});
			void reloadNotes().catch(() => undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t undo the memory change."));
		} finally {
			setUndoBusy(null);
		}
	};

	const openNote = async (summary: MemoryNoteSummaryView) => {
		setNoteBusy("load");
		setError(null);
		try {
			const { note } = await api.readMemoryNote({
				...(sessionId === undefined ? {} : { sessionId }),
				scope: summary.scope,
				slug: summary.slug,
			});
			const next = draftFrom(summary.scope, note);
			setDraft(next);
			setSavedDraft(next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t read the note."));
		} finally {
			setNoteBusy(null);
		}
	};

	const newNote = () => {
		const next: NoteDraft = {
			scope: notesScope,
			originalSlug: null,
			slug: "",
			name: "",
			description: "",
			type: notesScope === "global" ? "user" : "project",
			body: "",
		};
		setDraft(next);
		setSavedDraft(null);
		setError(null);
	};

	const saveNote = async () => {
		if (!draft) return;
		if (!SLUG_PATTERN.test(draft.slug) || draft.slug.includes("..")) {
			setError(t("Note IDs use lowercase letters, numbers, dots, underscores, and dashes."));
			return;
		}
		setNoteBusy("save");
		setError(null);
		setNotice(null);
		try {
			const frontmatter = {
				name: draft.name.trim() || draft.slug,
				description: draft.description,
				type: draft.type,
			};
			if (draft.originalSlug === null) {
				const result = await api.writeMemoryNote({
					...(sessionId === undefined ? {} : { sessionId }),
					op: "create",
					scope: draft.scope,
					target: { slug: draft.slug },
					frontmatter,
					content: draft.body,
				});
				if (!result.ok) {
					setError(result.error ?? t("Couldn’t save the note."));
					return;
				}
			} else {
				if (draft.slug !== draft.originalSlug) {
					const renamed = await api.writeMemoryNote({
						...(sessionId === undefined ? {} : { sessionId }),
						op: "rename",
						scope: draft.scope,
						target: { slug: draft.originalSlug },
						newSlug: draft.slug,
					});
					if (!renamed.ok) {
						setError(renamed.error ?? t("Couldn’t rename the note."));
						return;
					}
				}
				const result = await api.writeMemoryNote({
					...(sessionId === undefined ? {} : { sessionId }),
					op: "replace",
					scope: draft.scope,
					target: { slug: draft.slug },
					frontmatter,
					content: draft.body,
				});
				if (!result.ok) {
					setError(result.error ?? t("Couldn’t save the note."));
					return;
				}
			}
			const saved = { ...draft, originalSlug: draft.slug };
			setDraft(saved);
			setSavedDraft(saved);
			setNotice(t("Saved"));
			await Promise.all([reloadNotes(), reloadHistory()]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save the note."));
		} finally {
			setNoteBusy(null);
		}
	};

	const deleteNote = async () => {
		if (!draft || draft.originalSlug === null) return;
		setNoteBusy("delete");
		setError(null);
		setNotice(null);
		try {
			const result = await api.writeMemoryNote({
				...(sessionId === undefined ? {} : { sessionId }),
				op: "delete",
				scope: draft.scope,
				target: { slug: draft.originalSlug },
			});
			if (!result.ok) {
				setError(result.error ?? t("Couldn’t delete the note."));
				return;
			}
			setDraft(null);
			setSavedDraft(null);
			setNotice(t("Note deleted"));
			await Promise.all([reloadNotes(), reloadHistory()]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t delete the note."));
		} finally {
			setNoteBusy(null);
		}
	};

	const toggleChangeDiff = async (entry: MemoryChangelogEntryView) => {
		if (expandedChange === entry.id) {
			setExpandedChange(null);
			return;
		}
		setExpandedChange(entry.id);
		if (diffs[entry.id]) return;
		setDiffs((current) => ({ ...current, [entry.id]: { kind: "loading" } }));
		try {
			const detail = await api.readMemoryHistory({ changeId: entry.id });
			setDiffs((current) => ({ ...current, [entry.id]: { kind: "loaded", patch: detail.patch } }));
		} catch {
			setDiffs((current) => ({ ...current, [entry.id]: { kind: "error" } }));
		}
	};

	if (!settings && !error) {
		return <div aria-label={t("Memory settings")} className="settings-loading" role="status" />;
	}

	const dreamLastRun = settings?.dream.lastRun;
	const sessionFlags = settings?.session;
	const projectScopeAvailable = settings?.vault.projectDir !== undefined;

	return (
		<div className="settings-page memory-page">
			<section className="settings-section memory-settings-section">
				<header className="settings-section-heading">
					<h3>{t("Long-term memory")}</h3>
				</header>
				<div className="settings-card memory-settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Enable long-term memory")}</span>
							<p>{t("Keep durable notes outside session history; Metis searches and updates them with local tools.")}</p>
						</div>
						<div className="general-setting-control">
							<label className="web-search-toggle">
								<span className="sr-only">{t("Enable long-term memory")}</span>
								<input
									aria-label={t("Enable long-term memory")}
									checked={settings?.enabled ?? false}
									disabled={!serverReady || busy}
									onChange={(event) => update({ enabled: event.target.checked })}
									role="switch"
									type="checkbox"
								/>
								<span aria-hidden="true" className="web-search-toggle-track" />
							</label>
						</div>
					</div>
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Active context")}</span>
							<p>{t("Let Metis pin a short active-context note while working in this project.")}</p>
						</div>
						<div className="general-setting-control">
							<label className="web-search-toggle">
								<span className="sr-only">{t("Active context")}</span>
								<input
									aria-label={t("Active context")}
									checked={settings?.activeContext ?? false}
									disabled={!serverReady || busy}
									onChange={(event) => update({ activeContext: event.target.checked })}
									role="switch"
									type="checkbox"
								/>
								<span aria-hidden="true" className="web-search-toggle-track" />
							</label>
						</div>
					</div>
					<div className="memory-vault-path" title={settings?.vault.globalDir}>
						<FolderOpen aria-hidden="true" size={14} />
						<span>{settings?.vault.globalDir}</span>
					</div>
				</div>
			</section>

			{sessionFlags ? (
				<section className="settings-section">
					<header className="settings-section-heading">
						<h3>{t("This session")}</h3>
					</header>
					<div className="settings-card">
						<div className="general-setting-row">
							<div className="general-setting-copy">
								<span>{t("Use memory in this session")}</span>
								<p>{t("Search and read memory notes while working in this session.")}</p>
							</div>
							<div className="general-setting-control">
								<label className="web-search-toggle">
									<span className="sr-only">{t("Use memory in this session")}</span>
									<input
										aria-label={t("Use memory in this session")}
										checked={sessionFlags.useMemory}
										disabled={!serverReady || sessionFlagBusy}
										onChange={(event) => void setSessionFlag({ useMemory: event.target.checked })}
										role="switch"
										type="checkbox"
									/>
									<span aria-hidden="true" className="web-search-toggle-track" />
								</label>
							</div>
						</div>
						<div className="general-setting-row">
							<div className="general-setting-copy">
								<span>{t("Learn from this session")}</span>
								<p>{t("Let Metis write new memory notes and include this session in Dream consolidation.")}</p>
							</div>
							<div className="general-setting-control">
								<label className="web-search-toggle">
									<span className="sr-only">{t("Learn from this session")}</span>
									<input
										aria-label={t("Learn from this session")}
										checked={sessionFlags.contributeMemory}
										disabled={!serverReady || sessionFlagBusy}
										onChange={(event) => void setSessionFlag({ contributeMemory: event.target.checked })}
										role="switch"
										type="checkbox"
									/>
									<span aria-hidden="true" className="web-search-toggle-track" />
								</label>
							</div>
						</div>
					</div>
				</section>
			) : null}

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Notes")}</h3>
				</header>
				<div className="settings-card">
					<div className="memory-notes-toolbar">
						<div aria-label={t("Memory scope")} className="memory-scope-tabs" role="group">
							<button
								aria-pressed={notesScope === "global"}
								className={notesScope === "global" ? "is-active" : ""}
								onClick={() => setNotesScope("global")}
								type="button"
							>
								{t("Global")}
							</button>
							{projectScopeAvailable ? (
								<button
									aria-pressed={notesScope === "project"}
									className={notesScope === "project" ? "is-active" : ""}
									onClick={() => setNotesScope("project")}
									type="button"
								>
									{t("Project")}
								</button>
							) : null}
						</div>
						<label className="memory-notes-search">
							<MagnifyingGlass aria-hidden="true" size={13} />
							<span className="sr-only">{t("Search memory notes")}</span>
							<input
								aria-label={t("Search memory notes")}
								onChange={(event) => setNotesQuery(event.target.value)}
								placeholder={t("Search notes…")}
								type="search"
								value={notesQuery}
							/>
						</label>
						<button
							aria-label={t("New memory note")}
							className="settings-secondary-button"
							disabled={!serverReady || noteBusy !== null}
							onClick={newNote}
							type="button"
						>
							<FilePlus aria-hidden="true" size={13} />
							{t("New note")}
						</button>
					</div>
					{notesError ? (
						<div className="memory-info-banner" role="alert">
							<XCircle aria-hidden="true" size={15} />
							<span>{notesError}</span>
						</div>
					) : notes === null ? (
						<div className="memory-info-banner" role="status">
							<Info aria-hidden="true" size={15} />
							<span>{t("Loading…")}</span>
						</div>
					) : notes.length === 0 ? (
						<div className="memory-info-banner">
							<Brain aria-hidden="true" size={15} />
							<span>{t("No notes in this scope yet.")}</span>
						</div>
					) : (
						<ul className="memory-history-list">
							{notes.map((note) => (
								<li className="memory-note-row" key={`${note.scope}/${note.slug}`}>
									<button
										className="memory-note-open"
										disabled={noteBusy !== null}
										onClick={() => void openNote(note)}
										type="button"
									>
										<strong className="memory-note-target">{note.name}</strong>
										<span className="memory-history-meta">
											{note.slug} · {note.type}
											{note.description ? ` · ${note.description}` : ""}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{draft ? (
						<div className="memory-note-editor">
							<div className="memory-note-editor-grid">
								<label>
									<span>{t("Note ID")}</span>
									<input
										aria-label={t("Note ID")}
										onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
										placeholder="deploy-freeze"
										type="text"
										value={draft.slug}
									/>
								</label>
								<label>
									<span>{t("Type")}</span>
									<select
										aria-label={t("Note type")}
										onChange={(event) => setDraft({ ...draft, type: event.target.value as MemoryNoteTypeView })}
										value={draft.type}
									>
										{NOTE_TYPES.map((type) => (
											<option key={type} value={type}>{t(type)}</option>
										))}
									</select>
								</label>
								<label>
									<span>{t("Name")}</span>
									<input
										aria-label={t("Note name")}
										onChange={(event) => setDraft({ ...draft, name: event.target.value })}
										type="text"
										value={draft.name}
									/>
								</label>
								<label>
									<span>{t("Description")}</span>
									<input
										aria-label={t("Note description")}
										onChange={(event) => setDraft({ ...draft, description: event.target.value })}
										type="text"
										value={draft.description}
									/>
								</label>
							</div>
							<textarea
								aria-label={t("Note content")}
								className="memory-note-body"
								onChange={(event) => setDraft({ ...draft, body: event.target.value })}
								rows={10}
								value={draft.body}
							/>
							<div className="memory-note-editor-actions">
								{draft.originalSlug !== null ? (
									<button
										aria-label={t("Delete memory note")}
										className="settings-secondary-button memory-note-delete"
										disabled={!serverReady || noteBusy !== null}
										onClick={() => void deleteNote()}
										type="button"
									>
										<Trash aria-hidden="true" size={13} />
										{noteBusy === "delete" ? t("Deleting…") : t("Delete")}
									</button>
								) : null}
								<button
									className="settings-secondary-button"
									disabled={noteBusy !== null}
									onClick={() => {
										setDraft(null);
										setSavedDraft(null);
									}}
									type="button"
								>
									{t("Close")}
								</button>
								<button
									className="settings-primary-button"
									disabled={!serverReady || noteBusy !== null}
									onClick={() => void saveNote()}
									type="button"
								>
									{noteBusy === "save" ? t("Saving…") : t("Save note")}
								</button>
							</div>
						</div>
					) : null}
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Dream")}</h3>
				</header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Consolidate memory while idle")}</span>
							<p>{t("Periodically reviews recent sessions and curates long-term memory notes.")}</p>
						</div>
						<div className="general-setting-control">
							<label className="web-search-toggle">
								<span className="sr-only">{t("Consolidate memory while idle")}</span>
								<input
									aria-label={t("Consolidate memory while idle")}
									checked={settings?.dream.enabled ?? false}
									disabled={!serverReady || busy}
									onChange={(event) => toggleDream(event.target.checked)}
									role="switch"
									type="checkbox"
								/>
								<span aria-hidden="true" className="web-search-toggle-track" />
							</label>
						</div>
					</div>
					{dreamLastRun ? (
						<div className="memory-info-banner">
							<Moon aria-hidden="true" size={15} />
							<span>
								{t("Last dream: {{added}} added, {{updated}} updated, {{deleted}} deleted", {
									added: dreamLastRun.added,
									updated: dreamLastRun.updated,
									deleted: dreamLastRun.deleted,
								})}
								{` · ${dreamTimestamp(dreamLastRun.at)}`}
							</span>
						</div>
					) : null}
					{settings?.dream.modelAvailable === false ? (
						<div className="memory-info-banner">
							<Info aria-hidden="true" size={15} />
							<span>{t("No credentialed model is available for dreaming.")}</span>
						</div>
					) : null}
					<div className="memory-dream-actions">
						<button
							aria-label={t("Run memory consolidation now")}
							className="settings-secondary-button"
							disabled={!serverReady || dreamBusy !== null || settings?.dream.modelAvailable === false}
							onClick={() => void runDreamNow()}
							type="button"
						>
							<Moon aria-hidden="true" size={13} />
							{dreamBusy === "run" ? t("Running…") : t("Run now")}
						</button>
						{dreamLastRun ? (
							<button
								aria-label={t("Undo the last dream run")}
								className="settings-secondary-button"
								disabled={!serverReady || dreamBusy !== null}
								onClick={() => void undoDreamRun(dreamLastRun.runId)}
								type="button"
							>
								<ArrowCounterClockwise aria-hidden="true" size={13} />
								{dreamBusy === "undo" ? t("Undoing…") : t("Undo last run")}
							</button>
						) : null}
					</div>
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Recent changes")}</h3>
				</header>
				<div className="settings-card">
					{history === null ? (
						<div className="memory-info-banner" role="status">
							<Info aria-hidden="true" size={15} />
							<span>{t("Loading…")}</span>
						</div>
					) : history.length === 0 ? (
						<div className="memory-info-banner">
							<Brain aria-hidden="true" size={15} />
							<span>{t("No memory changes yet.")}</span>
						</div>
					) : (
						<ul className="memory-history-list">
							{history.map((entry) => {
								const undoable = UNDOABLE_OPS.has(entry.op) && entry.undoneBy === undefined;
								const diff = diffs[entry.id];
								return (
									<li className="memory-history-row memory-history-row-expandable" key={entry.id}>
										<div className="memory-history-main">
											<button
												aria-expanded={expandedChange === entry.id}
												className="memory-note-open"
												onClick={() => void toggleChangeDiff(entry)}
												type="button"
											>
												<strong className="memory-history-target">{changeTarget(entry)}</strong>
												<span className="memory-history-meta">
													{changeSummary(entry)} · {changeTimestamp(entry)}
												</span>
											</button>
											{undoable ? (
												<button
													aria-label={t("Undo memory change")}
													className="settings-secondary-button memory-history-undo"
													disabled={!serverReady || undoBusy !== null}
													onClick={() => void undo(entry)}
													type="button"
												>
													<ArrowCounterClockwise aria-hidden="true" size={13} />
													{undoBusy === entry.id ? t("Undoing…") : t("Undo")}
												</button>
											) : null}
										</div>
										{expandedChange === entry.id ? (
											<div className="memory-history-diff">
												{diff === undefined || diff.kind === "loading" ? (
													<p className="memory-history-meta">{t("Loading diff…")}</p>
												) : diff.kind === "error" ? (
													<p className="memory-history-meta" role="alert">{t("Unable to load this change.")}</p>
												) : diff.patch === undefined ? (
													<p className="memory-history-meta">{t("No content changes remain for this entry.")}</p>
												) : (
													<WorkerPoolContextProvider
														highlighterOptions={DIFF_HIGHLIGHTER[theme]}
														key={theme}
														poolOptions={DIFF_WORKER_POOL}
													>
														<PatchDiff options={DIFF_OPTIONS} patch={diff.patch} />
													</WorkerPoolContextProvider>
												)}
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</section>

			<div className="settings-form-actions memory-form-actions">
				{settingsDirty && <span className="settings-unsaved-label" role="status">{t("Unsaved changes")}</span>}
				{error ? (
					<p className="settings-action-message error web-search-message" role="alert">
						<XCircle aria-hidden="true" size={15} />
						{error}
					</p>
				) : null}
				<button
					className="settings-primary-button"
					disabled={!serverReady || busy || !settingsDirty}
					onClick={() => void save()}
					type="button"
				>
					{busy ? t("Saving…") : t("Save")}
				</button>
			</div>

			{notice ? <FloatingSystemNotice title={notice} tone="success" /> : null}
		</div>
	);
}
