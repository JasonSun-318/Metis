import type {
	MemoryChangelogEntryView,
	MemoryNoteSummaryView,
	MemoryNoteTypeView,
	MemorySettingsView,
	ModelSettingsView,
} from "@metis/app-protocol";
import { PatchDiff, WorkerPoolContextProvider, type WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import {
	ArrowCounterClockwise,
	Brain,
	CaretRight,
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
import { type DreamSettingsDraft, parseDreamDraft, toDreamDraft } from "./memory-dream-settings.ts";
import { MemoryDialog } from "./MemoryDialog.tsx";
import { MemorySessionSettings } from "./MemorySessionSettings.tsx";
import { MemoryDreamSettings } from "./MemoryDreamSettings.tsx";
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

function draftFrom(
	scope: "global" | "project",
	note: {
		readonly slug: string;
		readonly name: string;
		readonly description: string;
		readonly type: MemoryNoteTypeView;
		readonly body: string;
	},
): NoteDraft {
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

const NOTE_TYPE_LABELS: Record<MemoryNoteTypeView, string> = {
	user: "About you",
	feedback: "Preferences",
	project: "Project context",
	reference: "Reference",
	decision: "Decision",
};

function changeSummary(entry: MemoryChangelogEntryView, translate: (key: string) => string): string {
	const operations: Record<MemoryChangelogEntryView["op"], string> = {
		create: "Memory created",
		append: "Memory updated",
		replace: "Memory updated",
		str_replace: "Memory updated",
		rename: "Memory renamed",
		delete: "Memory deleted",
		migrate: "Memory imported",
		undo: "Memory restored",
	};
	const actors: Record<MemoryChangelogEntryView["actor"]["kind"], string> = {
		user: "You",
		agent: "Metis",
		dream: "Consolidation",
		migrate: "Import",
	};
	return `${translate(operations[entry.op])} · ${translate(entry.scope === "global" ? "Global" : "Project")} · ${translate(actors[entry.actor.kind])}`;
}

function changeTimestamp(entry: MemoryChangelogEntryView): string {
	const parsed = Date.parse(entry.ts);
	return Number.isNaN(parsed) ? entry.ts : new Date(parsed).toLocaleString();
}

function dreamTimestamp(at: string): string {
	const parsed = Date.parse(at);
	return Number.isNaN(parsed) ? at : new Date(parsed).toLocaleString();
}

type DiffState =
	| { readonly kind: "loading" }
	| { readonly kind: "error" }
	| { readonly kind: "loaded"; readonly patch?: string };

export function MemorySettingsPanel({
	api,
	onDirtyChange,
	serverReady,
	sessionId,
	theme = "dark",
}: {
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
		| "listSessions"
		| "getModelSettings"
	>;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly serverReady: boolean;
	readonly sessionId?: string;
	readonly theme?: "dark" | "light";
}) {
	const { t } = useTranslation();
	const [activePanel, setActivePanel] = useState<"notes" | "advanced" | "history" | "storage" | null>(null);
	const [advancedBaseline, setAdvancedBaseline] = useState<DreamSettingsDraft | null>(null);
	const [settings, setSettings] = useState<MemorySettingsView | null>(null);
	const [savedSettings, setSavedSettings] = useState<MemorySettingsView | null>(null);
	const [history, setHistory] = useState<MemoryChangelogEntryView[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [undoBusy, setUndoBusy] = useState<string | null>(null);
	const [dreamBusy, setDreamBusy] = useState<"run" | "undo" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [notesScope, setNotesScope] = useState<"global" | "project">("global");
	const [notesQuery, setNotesQuery] = useState("");
	const [notes, setNotes] = useState<MemoryNoteSummaryView[] | null>(null);
	const [notesError, setNotesError] = useState<string | null>(null);
	const [draft, setDraft] = useState<NoteDraft | null>(null);
	const [savedDraft, setSavedDraft] = useState<NoteDraft | null>(null);
	const [noteBusy, setNoteBusy] = useState<"load" | "save" | "delete" | null>(null);
	const [expandedChange, setExpandedChange] = useState<string | null>(null);
	const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
	const [dreamDraft, setDreamDraft] = useState<DreamSettingsDraft | null>(null);
	const [savedDreamDraft, setSavedDreamDraft] = useState<DreamSettingsDraft | null>(null);
	const [modelSettings, setModelSettings] = useState<ModelSettingsView | null>(null);
	const [modelChoicesError, setModelChoicesError] = useState(false);
	const [failedRunId, setFailedRunId] = useState<string | null>(null);

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
				setDreamDraft((currentDraft) => currentDraft ?? toDreamDraft(view.dream));
				setSavedDreamDraft((currentDraft) => currentDraft ?? toDreamDraft(view.dream));
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Couldn’t load memory settings."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, serverReady, sessionId, t]);

	// Model choices load independently: a failure must not take down the rest of the panel.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		void api.getModelSettings().then(
			(view) => {
				if (current) {
					setModelSettings(view);
					setModelChoicesError(false);
				}
			},
			() => {
				if (current) setModelChoicesError(true);
			},
		);
		return () => {
			current = false;
		};
	}, [api, serverReady]);

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

	const dreamDraftDirty = Boolean(
		dreamDraft &&
			savedDreamDraft &&
			(dreamDraft.enabled !== savedDreamDraft.enabled ||
				dreamDraft.modelKey !== savedDreamDraft.modelKey ||
				dreamDraft.minHours !== savedDreamDraft.minHours ||
				dreamDraft.minSessions !== savedDreamDraft.minSessions ||
				dreamDraft.maxUnusedDays !== savedDreamDraft.maxUnusedDays),
	);
	const dreamParse = dreamDraft ? parseDreamDraft(dreamDraft) : null;
	const settingsDirty = Boolean(
		(savedSettings &&
			settings &&
			(settings.enabled !== savedSettings.enabled || settings.activeContext !== savedSettings.activeContext)) ||
			dreamDraftDirty,
	);
	const noteDirty = draftDirty(draft, savedDraft);
	const dirty = settingsDirty || noteDirty;
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
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

	/** Refresh run state/history/notes after a dream run; unsaved Dream drafts survive. */
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
					},
		);
		if (!dreamDraftDirty) {
			const next = toDreamDraft(view.dream);
			setDreamDraft(next);
			setSavedDreamDraft(next);
		}
		void reloadNotes().catch(() => undefined);
	};

	const runDreamNow = async () => {
		setDreamBusy("run");
		setError(null);
		setNotice(null);
		try {
			const result = await api.runMemoryDream();
			if (!result.ok) {
				if (result.runId) {
					// Partial writes are committed under this runId and can be reverted.
					setFailedRunId(result.runId);
					setError(t("Consolidation did not finish. Saved changes are still available to undo."));
					await reloadAfterDream();
				} else {
					setError(result.error ?? t("Couldn’t run memory consolidation."));
				}
				return;
			}
			setFailedRunId(null);
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
			if (result.undone.length > 0) {
				setNotice(
					result.skipped.length > 0
						? t("{{undone}} change(s) undone; {{skipped}} skipped.", {
								undone: result.undone.length,
								skipped: result.skipped.length,
							})
						: t("Undid the last dream"),
				);
			}
			if (result.skipped.length > 0) {
				setError(result.skipped.map((item) => `${item.changeId}: ${item.reason}`).join("; "));
			}
			setFailedRunId((current) => (current === runId ? null : current));
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
		setDreamDraft((current) => (current ? { ...current, enabled } : current));
		setNotice(null);
		setError(null);
	};

	const save = async () => {
		if (!settings) return;
		const parsed = dreamDraft ? parseDreamDraft(dreamDraft) : null;
		if (parsed && !parsed.ok) {
			setError(t(parsed.message));
			return;
		}
		const submittedDream = dreamDraft;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateMemorySettings({
				...(sessionId === undefined ? {} : { sessionId }),
				enabled: settings.enabled,
				activeContext: settings.activeContext,
				...(parsed ? { dream: parsed.value } : {}),
			});
			setSettings(next);
			setSavedSettings(next);
			// Only the submitted draft version becomes the new baseline; edits made
			// while the save was in flight stay dirty.
			if (submittedDream) setSavedDreamDraft(submittedDream);
			setNotice(t("Saved"));
			return true;
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
	const projectScopeAvailable = settings?.vault.projectDir !== undefined;
	const dreamModelOptions = (() => {
		const options = (modelSettings?.providers ?? [])
			.filter((provider) => provider.auth.configured)
			.flatMap((provider) =>
				provider.models.map((model) => ({
					value: JSON.stringify([model.provider, model.modelId]),
					label: `${provider.name} / ${model.name}`,
				})),
			);
		const savedKey = savedDreamDraft?.modelKey ?? "";
		if (savedKey !== "" && !options.some((option) => option.value === savedKey)) {
			options.push({ value: savedKey, label: t("Saved model (currently unavailable)") });
		}
		return options;
	})();
	const dreamFieldError = dreamDraftDirty && dreamParse && !dreamParse.ok ? dreamParse.message : null;

	const openPanel = (panel: "notes" | "advanced" | "history" | "storage") => {
		setError(null);
		setNotice(null);
		setActivePanel(panel);
	};
	const dialogFeedback = (
		<>
			{error && (
				<p className="settings-action-message error" role="alert">
					{error}
				</p>
			)}
			{notice && (
				<p className="memory-dialog-notice" role="status">
					{notice}
				</p>
			)}
		</>
	);

	return (
		<div className="settings-page memory-page">
			<section className="settings-section memory-settings-section">
				<header className="settings-section-heading">
					<h3>{t("Memory preferences")}</h3>
					<span className="memory-section-caption">{t("Applies to all conversations")}</span>
				</header>
				<div className="settings-card memory-settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Enable long-term memory")}</span>
							<p>
								{t(
									"Let Metis remember your preferences and useful context across conversations. Turning this off keeps existing notes.",
								)}
							</p>
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
							<span>{t("Remember project progress")}</span>
							<p>{t("Keep a short summary of each project’s progress and next steps for future conversations.")}</p>
						</div>
						<div className="general-setting-control">
							<label className="web-search-toggle">
								<span className="sr-only">{t("Remember project progress")}</span>
								<input
									aria-label={t("Remember project progress")}
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
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Manage memory")}</h3>
				</header>
				<div className="settings-card memory-management-card">
					<button
						aria-label={t("Manage saved memories")}
						className="memory-manage-row"
						onClick={() => openPanel("notes")}
						type="button"
					>
						<Brain aria-hidden="true" size={19} />
						<span className="memory-manage-copy">
							<strong>{t("Saved memories")}</strong>
							<span>{t("Review what Metis remembers. You can edit or remove any note.")}</span>
						</span>
						<CaretRight aria-hidden="true" size={14} />
					</button>
					<MemorySessionSettings api={api} currentSessionId={sessionId} serverReady={serverReady} />
					<button
						aria-label={t("Recent changes")}
						className="memory-manage-row"
						onClick={() => openPanel("history")}
						type="button"
					>
						<ArrowCounterClockwise aria-hidden="true" size={19} />
						<span className="memory-manage-copy">
							<strong>{t("Recent changes")}</strong>
							<span>{t("Review and undo")}</span>
						</span>
						<CaretRight aria-hidden="true" size={14} />
					</button>
					<button
						aria-label={t("Storage location")}
						className="memory-manage-row"
						onClick={() => openPanel("storage")}
						type="button"
					>
						<FolderOpen aria-hidden="true" size={19} />
						<span className="memory-manage-copy">
							<strong>{t("Storage location")}</strong>
							<span>{t("Global and current project memory folders")}</span>
						</span>
						<CaretRight aria-hidden="true" size={14} />
					</button>
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Automatic consolidation")}</h3>
				</header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Consolidate memory while idle")}</span>
							<p>{t("Review past conversations to combine useful memories and remove outdated details.")}</p>
						</div>
						<div className="general-setting-control">
							<label className="web-search-toggle">
								<span className="sr-only">{t("Consolidate memory while idle")}</span>
								<input
									aria-label={t("Consolidate memory while idle")}
									checked={dreamDraft?.enabled ?? settings?.dream.enabled ?? false}
									disabled={!serverReady || busy}
									onChange={(event) => toggleDream(event.target.checked)}
									role="switch"
									type="checkbox"
								/>
								<span aria-hidden="true" className="web-search-toggle-track" />
							</label>
						</div>
					</div>
					{modelChoicesError ? (
						<div className="memory-info-banner" role="alert">
							<XCircle aria-hidden="true" size={15} />
							<span>{t("Couldn’t load memory model choices.")}</span>
						</div>
					) : null}
					<button
						aria-label={t("Advanced settings")}
						className="memory-manage-row memory-advanced-entry"
						onClick={() => {
							setAdvancedBaseline(dreamDraft);
							openPanel("advanced");
						}}
						type="button"
					>
						<span className="memory-manage-copy">
							<strong>{t("Advanced settings")}</strong>
							<span>{t("Model, frequency and cleanup")}</span>
						</span>
						<CaretRight aria-hidden="true" size={14} />
					</button>
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
						<span className="memory-run-hint">{t("Uses your saved settings and model quota.")}</span>
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
						{dreamDraftDirty ? (
							<span className="memory-history-meta">{t("Save changes to use them for the next run.")}</span>
						) : null}
						{failedRunId !== null ? (
							<button
								aria-label={t("Undo changes from failed run")}
								className="settings-secondary-button"
								disabled={!serverReady || dreamBusy !== null}
								onClick={() => void undoDreamRun(failedRunId)}
								type="button"
							>
								<ArrowCounterClockwise aria-hidden="true" size={13} />
								{dreamBusy === "undo" ? t("Undoing…") : t("Undo changes from failed run")}
							</button>
						) : null}
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

			{activePanel === "notes" && (
				<MemoryDialog
					title={t("Saved memories")}
					description={
						projectScopeAvailable
							? t("Project: {{path}}", { path: settings?.vault.projectRoot })
							: t("Global memories apply across conversations.")
					}
					onClose={() => setActivePanel(null)}
					busy={noteBusy !== null}
				>
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
						<div className="memory-empty-state">
							<Brain aria-hidden="true" size={22} />
							<strong>{notesQuery.trim() ? t("No matching memories") : t("No memories yet")}</strong>
							<p>
								{notesQuery.trim()
									? t("Try another search, or clear it to see all notes.")
									: t("Tell Metis what to remember, or add a note yourself.")}
							</p>
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
											{note.slug} · {t(NOTE_TYPE_LABELS[note.type])}
											{note.description ? ` · ${note.description}` : ""}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{dialogFeedback}
				</MemoryDialog>
			)}
			{draft && (
				<MemoryDialog
					title={t(draft.originalSlug === null ? "New memory note" : "Edit memory note")}
					description={t(draft.scope === "global" ? "Global" : "Project")}
					onClose={() => {
						setDraft(null);
						setSavedDraft(null);
					}}
					busy={noteBusy !== null}
					dirty={noteDirty}
					className="memory-editor-dialog"
				>
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
										<option key={type} value={type}>
											{t(NOTE_TYPE_LABELS[type])}
										</option>
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
								className="settings-primary-button"
								disabled={!serverReady || noteBusy !== null}
								onClick={() => void saveNote()}
								type="button"
							>
								{noteBusy === "save" ? t("Saving…") : t("Save note")}
							</button>
						</div>
					</div>
					{dialogFeedback}
				</MemoryDialog>
			)}
			{activePanel === "storage" && (
				<MemoryDialog title={t("Storage location")} onClose={() => setActivePanel(null)}>
					<div className="memory-storage-location">
						<strong>{t("Global")}</strong>
						<p className="memory-vault-path">{settings?.vault.globalDir}</p>
					</div>
					{settings?.vault.projectDir && (
						<div className="memory-storage-location">
							<strong>{t("Project")}</strong>
							<p>{settings.vault.projectRoot}</p>
							<p className="memory-vault-path">{settings.vault.projectDir}</p>
						</div>
					)}
				</MemoryDialog>
			)}
			{activePanel === "advanced" && dreamDraft && (
				<MemoryDialog
					title={t("Advanced settings")}
					description={t("Model, frequency and cleanup")}
					dirty={JSON.stringify(dreamDraft) !== JSON.stringify(advancedBaseline)}
					busy={busy}
					onClose={() => {
						if (advancedBaseline) setDreamDraft(advancedBaseline);
						setActivePanel(null);
					}}
					footer={
						<button
							className="settings-primary-button"
							disabled={!serverReady || busy || Boolean(dreamParse && !dreamParse.ok)}
							onClick={() =>
								void save().then((saved) => {
									if (saved) setActivePanel(null);
								})
							}
							type="button"
						>
							{t(busy ? "Saving…" : "Save settings")}
						</button>
					}
				>
					<div className="memory-advanced-body memory-note-editor-grid">
						<MemoryDreamSettings
							disabled={!serverReady || busy}
							draft={dreamDraft}
							modelOptions={dreamModelOptions}
							onChange={setDreamDraft}
						/>
					</div>
					{dreamFieldError && (
						<p role="alert" className="settings-action-message error">
							{t(dreamFieldError)}
						</p>
					)}
					{dialogFeedback}
				</MemoryDialog>
			)}
			{activePanel === "history" && (
				<MemoryDialog
					title={t("Recent changes")}
					description={t("Review and undo")}
					onClose={() => {
						setExpandedChange(null);
						setActivePanel(null);
					}}
					busy={undoBusy !== null || dreamBusy !== null}
				>
					<div className="memory-history-content">
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
													aria-haspopup="dialog"
													className="memory-note-open"
													onClick={() => void toggleChangeDiff(entry)}
													type="button"
												>
													<strong className="memory-history-target">{changeTarget(entry)}</strong>
													<span className="memory-history-meta">
														{changeSummary(entry, t)} · {changeTimestamp(entry)}
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
												<MemoryDialog
													title={t("Memory change")}
													description={changeTarget(entry)}
													onClose={() => setExpandedChange(null)}
												>
													<div className="memory-history-diff">
														{diff === undefined || diff.kind === "loading" ? (
															<p className="memory-history-meta">{t("Loading diff…")}</p>
														) : diff.kind === "error" ? (
															<p className="memory-history-meta" role="alert">
																{t("Unable to load this change.")}
															</p>
														) : diff.patch === undefined ? (
															<p className="memory-history-meta">{t("No content changes remain for this entry.")}</p>
														) : (
															<>
																<p className="memory-history-meta">{t("Before this change → current version")}</p>
																<WorkerPoolContextProvider
																	highlighterOptions={DIFF_HIGHLIGHTER[theme]}
																	key={theme}
																	poolOptions={DIFF_WORKER_POOL}
																>
																	<PatchDiff options={DIFF_OPTIONS} patch={diff.patch} />
																</WorkerPoolContextProvider>
															</>
														)}
													</div>
												</MemoryDialog>
											) : null}
										</li>
									);
								})}
							</ul>
						)}
					</div>
					{dialogFeedback}
				</MemoryDialog>
			)}

			<div className="settings-form-actions memory-form-actions">
				{settingsDirty ? (
					<span className="settings-unsaved-label" role="status">
						{t("Unsaved changes")}
					</span>
				) : (
					<span className="memory-section-caption">
						{t("Preferences and consolidation settings apply after saving.")}
					</span>
				)}
				{error ? (
					<p className="settings-action-message error web-search-message" role="alert">
						<XCircle aria-hidden="true" size={15} />
						{error}
					</p>
				) : null}
				{dreamFieldError ? (
					<p className="settings-action-message error web-search-message" role="alert">
						<XCircle aria-hidden="true" size={15} />
						{t(dreamFieldError)}
					</p>
				) : null}
				<button
					className="settings-primary-button"
					disabled={!serverReady || busy || !settingsDirty || dreamFieldError !== null}
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
