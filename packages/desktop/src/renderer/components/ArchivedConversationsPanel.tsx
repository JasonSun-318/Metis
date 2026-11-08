import type { SessionSummary } from "@metis/app-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import {
	Archive,
	ArrowClockwise,
	ArrowCounterClockwise,
	CaretLeft,
	CaretRight,
	ChatCircle,
	Robot,
	Trash,
} from "../icons.tsx";
import { MemoryDialog } from "./MemoryDialog.tsx";
import "./archived-conversations.css";

type ArchivedPage = Awaited<ReturnType<MetisDesktopApi["listArchivedConversations"]>>;
type ArchivedConversation = ArchivedPage["conversations"][number];

export function ArchivedConversationsPanel({
	api,
	serverReady,
	onDeleteSession,
	onDeleteAgent,
	onRestoreConversation,
}: {
	readonly api: Pick<MetisDesktopApi, "listArchivedConversations">;
	readonly serverReady: boolean;
	readonly onDeleteSession?: (session: SessionSummary) => Promise<void>;
	readonly onDeleteAgent?: (rootSessionId: string, agentId: string) => Promise<void>;
	readonly onRestoreConversation?: (session: SessionSummary, agentId?: string) => Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
	const [revision, setRevision] = useState(0);
	const [page, setPage] = useState<ArchivedPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<ArchivedConversation | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [restoring, setRestoring] = useState<ArchivedConversation | null>(null);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const busy = deleting || restoring !== null;
	const cursor = cursors.at(-1);

	// biome-ignore lint/correctness/useExhaustiveDependencies(revision): A refresh explicitly reloads this metadata page.
	useEffect(() => {
		let current = true;
		setPage(null);
		setLoadError(null);
		setLoading(true);
		if (!serverReady) return;
		void api.listArchivedConversations({ ...(cursor ? { cursor } : {}), limit: 30 }).then(
			(result) => {
				if (!current) return;
				setPage(result);
				setLoading(false);
			},
			(cause: unknown) => {
				if (!current) return;
				setLoadError(t(cause instanceof Error ? cause.message : "Archived conversations could not be loaded."));
				setLoading(false);
			},
		);
		return () => {
			current = false;
		};
	}, [api, cursor, revision, serverReady, t]);

	const refresh = () => {
		setRestoreError(null);
		setCursors([undefined]);
		setRevision((current) => current + 1);
	};
	const nameOf = (entry: ArchivedConversation) =>
		(entry.kind === "session" ? entry.session.name : entry.name)?.trim() || t("Untitled conversation");
	const remove = async () => {
		if (!pendingDelete || busy || !serverReady) return;
		const operation =
			pendingDelete.kind === "session"
				? onDeleteSession && (() => onDeleteSession(pendingDelete.session))
				: onDeleteAgent && (() => onDeleteAgent(pendingDelete.session.sessionId, pendingDelete.agentId));
		if (!operation) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			await operation();
			setPendingDelete(null);
			// Root and subtree deletion can remove entries from any page and invalidate its cursor.
			refresh();
		} catch (cause) {
			setDeleteError(t(cause instanceof Error ? cause.message : "This archived conversation could not be deleted."));
		} finally {
			setDeleting(false);
		}
	};
	const restore = async (entry: ArchivedConversation) => {
		if (!onRestoreConversation || busy || !serverReady) return;
		setRestoring(entry);
		setRestoreError(null);
		try {
			await onRestoreConversation(entry.session, entry.kind === "agent" ? entry.agentId : undefined);
			// Restoring a root or ancestor can remove several archived rows and invalidate later pages.
			refresh();
		} catch (cause) {
			setRestoreError(
				t(cause instanceof Error ? cause.message : "This archived conversation could not be restored."),
			);
		} finally {
			setRestoring(null);
		}
	};

	return (
		<section className="settings-page archived-conversations-panel" aria-label={t("Archived conversations")}>
			<div className="archived-conversations-toolbar">
				<p>
					{t(
						"Archived conversations are hidden from the sidebar. Restore them to their original list or delete them permanently.",
					)}
				</p>
				<button
					className="settings-secondary-button"
					type="button"
					disabled={!serverReady || loading || busy}
					onClick={refresh}
				>
					<ArrowClockwise aria-hidden="true" size={14} />
					{t("Refresh")}
				</button>
			</div>
			{restoreError ? (
				<p className="settings-inline-error" role="alert">
					{restoreError}
				</p>
			) : null}
			{loadError ? (
				<div className="archived-conversations-error" role="alert">
					<p className="settings-inline-error">{loadError}</p>
					<button className="settings-secondary-button" type="button" onClick={refresh} disabled={!serverReady}>
						{t("Retry")}
					</button>
				</div>
			) : loading ? (
				<output className="archived-conversations-empty">
					<Archive aria-hidden="true" size={24} />
					<span>{t(serverReady ? "Loading archived conversations…" : "Waiting for connection…")}</span>
				</output>
			) : page?.conversations.length ? (
				<ul className="archived-conversations-list">
					{page.conversations.map((entry) => {
						const name = nameOf(entry);
						const stamp = entry.kind === "session" ? entry.session.updatedAt : entry.updatedAt;
						const Icon = entry.kind === "session" ? ChatCircle : Robot;
						return (
							<li
								className="settings-card archived-conversation-row"
								key={entry.kind === "session" ? entry.session.sessionId : entry.agentId}
							>
								<span className="archived-conversation-icon">
									<Icon aria-hidden="true" size={18} />
								</span>
								<div className="archived-conversation-copy">
									<div className="archived-conversation-heading">
										<strong title={name}>{name}</strong>
										<span className="archived-conversation-kind">
											{t(entry.kind === "session" ? "Main conversation" : "Subagent conversation")}
										</span>
									</div>
									<div className="archived-conversation-detail">
										{entry.kind === "agent" ? (
											<span title={entry.session.name || t("Untitled conversation")}>
												{t("From {{conversation}}", {
													conversation: entry.session.name || t("Untitled conversation"),
												})}
											</span>
										) : (
											<span>{entry.session.mode === "code" ? "Code" : "Chat"}</span>
										)}
										<time dateTime={stamp}>
											{new Date(stamp).toLocaleDateString(
												i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en",
												{ year: "numeric", month: "short", day: "numeric" },
											)}
										</time>
									</div>
								</div>
								<div className="archived-conversation-actions">
									<button
										aria-label={t("Restore {{conversation}}", { conversation: name })}
										title={t("Restore conversation")}
										className="archived-conversation-restore"
										type="button"
										disabled={!serverReady || busy || !onRestoreConversation}
										aria-busy={restoring === entry}
										onClick={() => void restore(entry)}
									>
										<ArrowCounterClockwise aria-hidden="true" size={16} />
										<span>{t(restoring === entry ? "Restoring…" : "Restore")}</span>
									</button>
									<button
										aria-label={t("Delete {{conversation}}", { conversation: name })}
										title={t("Delete")}
										className="archived-conversation-delete"
										type="button"
										disabled={
											!serverReady || busy || (entry.kind === "session" ? !onDeleteSession : !onDeleteAgent)
										}
										onClick={() => {
											setPendingDelete(entry);
											setDeleteError(null);
										}}
									>
										<Trash aria-hidden="true" size={16} />
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			) : (
				<div className="archived-conversations-empty">
					<Archive aria-hidden="true" size={28} />
					<h3>{t("No archived conversations")}</h3>
					<p>{t("Conversations you archive will appear here.")}</p>
				</div>
			)}
			{cursors.length > 1 || page?.nextCursor ? (
				<nav className="archived-conversations-pagination" aria-label={t("Archived conversation pages")}>
					<span>{t("Page {{page}}", { page: cursors.length })}</span>
					<div>
						<button
							className="settings-secondary-button"
							type="button"
							disabled={loading || busy || cursors.length <= 1}
							onClick={() => setCursors((current) => current.slice(0, -1))}
						>
							<CaretLeft aria-hidden="true" size={14} />
							{t("Previous page")}
						</button>
						<button
							className="settings-secondary-button"
							type="button"
							disabled={loading || busy || !page?.nextCursor}
							onClick={() => {
								if (page?.nextCursor) setCursors((current) => [...current, page.nextCursor!]);
							}}
						>
							{t("Next page")}
							<CaretRight aria-hidden="true" size={14} />
						</button>
					</div>
				</nav>
			) : null}
			{pendingDelete ? (
				<MemoryDialog
					title={t("Delete archived conversation?")}
					onClose={() => {
						if (!deleting) setPendingDelete(null);
					}}
					busy={deleting}
					className="archived-conversation-delete-dialog"
					footer={
						<div className="settings-form-actions">
							<button
								type="button"
								className="settings-secondary-button"
								disabled={deleting}
								onClick={() => setPendingDelete(null)}
							>
								{t("Cancel")}
							</button>
							<button
								type="button"
								className="settings-danger-button"
								disabled={deleting || !serverReady}
								onClick={() => void remove()}
							>
								{t(deleting ? "Deleting…" : "Delete conversation")}
							</button>
						</div>
					}
				>
					<p className="archived-conversation-confirm-name">{nameOf(pendingDelete)}</p>
					<p>
						{t(
							pendingDelete.kind === "session"
								? "This deletes this conversation and all of its subagent conversations, including their history and generated files."
								: "This deletes this subagent conversation and its child conversations, including their history and generated files.",
						)}
					</p>
					{deleteError ? (
						<p className="settings-inline-error" role="alert">
							{deleteError}
						</p>
					) : null}
				</MemoryDialog>
			) : null}
		</section>
	);
}
