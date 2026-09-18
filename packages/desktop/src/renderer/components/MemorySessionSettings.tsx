import { CaretRight, ChatCircle, Code, MagnifyingGlass } from "@phosphor-icons/react";
import type { SessionSummary } from "@metis/app-protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

import { MemoryDialog } from "./MemoryDialog.tsx";

type MemorySessionApi = Pick<MetisDesktopApi, "listSessions" | "setSessionMemoryFlags">;

/** Explicit per-session exceptions; global preferences remain in the parent panel. */
export function MemorySessionSettings({
	api,
	serverReady,
	currentSessionId,
}: {
	readonly api: MemorySessionApi;
	readonly serverReady: boolean;
	readonly currentSessionId?: string;
}) {
	const { t } = useTranslation();
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [open, setOpen] = useState(false);
	const [exceptionsOnly, setExceptionsOnly] = useState(false);
	const [query, setQuery] = useState("");
	const [visibleCount, setVisibleCount] = useState(50);
	const [revision, setRevision] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const generation = useRef(0);

	useEffect(() => {
		const requestGeneration = ++generation.current;
		setSessions(null);
		setBusy(null);
		setError(null);
		if (!serverReady) return;
		void (async () => {
			const all = new Map<string, SessionSummary>();
			let afterSessionId: string | null = null;
			const cursors = new Set<string>();
			do {
				const result = await api.listSessions({
					includeArchived: true,
					limit: 200,
					...(afterSessionId ? { afterSessionId } : {}),
				});
				if (generation.current !== requestGeneration) return;
				for (const session of result.sessions) {
					if (!session.scheduled) all.set(session.sessionId, session);
				}
				afterSessionId = result.nextAfterSessionId;
				if (afterSessionId && cursors.has(afterSessionId)) throw new Error("Repeated session cursor");
				if (afterSessionId) cursors.add(afterSessionId);
			} while (afterSessionId);
			setSessions([...all.values()]);
		})().catch(() => {
			if (generation.current === requestGeneration) setError(t("Couldn’t load conversations. Try again."));
		});
		return () => {
			generation.current += 1;
		};
	}, [api, serverReady, revision, t]);

	const change = async (sessionId: string, flag: "useMemory" | "contributeMemory", enabled: boolean) => {
		const requestGeneration = generation.current;
		setBusy(sessionId);
		setError(null);
		try {
			const next = await api.setSessionMemoryFlags({ sessionId, requestId: crypto.randomUUID(), [flag]: enabled });
			if (generation.current === requestGeneration)
				setSessions(
					(current) =>
						current?.map((session) => (session.sessionId === sessionId ? { ...session, ...next } : session)) ?? null,
				);
		} catch {
			if (generation.current === requestGeneration)
				setError(t("Couldn’t update this conversation. Its settings were not changed here."));
		} finally {
			if (generation.current === requestGeneration) setBusy(null);
		}
	};
	const nameOf = (session: SessionSummary) => session.name?.trim() || t("Untitled conversation");
	const search = query.trim().toLocaleLowerCase();
	const filtered =
		sessions
			?.filter((session) => !exceptionsOnly || session.useMemory === false || session.contributeMemory === false)
			.filter((session) =>
				`${nameOf(session)} ${session.cwdOrigin === "managed" ? "" : (session.cwd ?? "")} ${session.sessionId}`
					.toLocaleLowerCase()
					.includes(search),
			) ?? [];
	const excludedCount =
		sessions?.filter((session) => session.useMemory === false || session.contributeMemory === false).length ?? 0;

	return (
		<>
			<button
				className="memory-manage-row"
				onClick={() => {
					setOpen(true);
					setQuery("");
					setVisibleCount(50);
				}}
				type="button"
			>
				<ChatCircle aria-hidden="true" size={19} />
				<span className="memory-manage-copy">
					<strong>{t("Conversation memory")}</strong>
					<span>{t("Choose which conversations can use and save memories.")}</span>
				</span>
				<span className="memory-section-caption">
					{sessions ? t("{{count}} with exceptions", { count: excludedCount }) : t("Loading…")}
				</span>
				<CaretRight aria-hidden="true" size={14} />
			</button>
			{open && (
				<MemoryDialog
					title={t("Conversation memory")}
					description={t(
						"Switches apply to each conversation immediately. Turning off saving also excludes it from background consolidation.",
					)}
					onClose={() => setOpen(false)}
					busy={busy !== null}
					className="memory-session-dialog"
				>
					<div className="memory-session-toolbar">
						<label className="memory-notes-search">
							<MagnifyingGlass aria-hidden="true" size={15} />
							<input
								aria-label={t("Search conversations by name or project")}
								type="search"
								placeholder={t("Search conversations by name or project")}
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setVisibleCount(50);
								}}
							/>
						</label>
						<div className="memory-scope-tabs" role="group" aria-label={t("Filter conversations")}>
							<button
								className={!exceptionsOnly ? "is-active" : ""}
								aria-pressed={!exceptionsOnly}
								onClick={() => setExceptionsOnly(false)}
								type="button"
							>
								{t("All conversations")}
							</button>
							<button
								className={exceptionsOnly ? "is-active" : ""}
								aria-pressed={exceptionsOnly}
								onClick={() => setExceptionsOnly(true)}
								type="button"
							>
								{t("With exceptions")}
							</button>
						</div>
					</div>
					{error && (
						<div className="memory-info-banner" role="alert">
							<span>{error}</span>
							{sessions === null && (
								<button
									className="settings-secondary-button"
									disabled={!serverReady}
									onClick={() => setRevision((value) => value + 1)}
									type="button"
								>
									{t("Retry")}
								</button>
							)}
						</div>
					)}
					{sessions === null ? (
						!error && <p role="status">{t(serverReady ? "Loading…" : "Waiting for connection…")}</p>
					) : filtered.length === 0 ? (
						<div className="memory-empty-state">
							<ChatCircle size={24} aria-hidden="true" />
							<strong>{t("No matching conversations")}</strong>
						</div>
					) : (
						<ul className="memory-session-list">
							{filtered.slice(0, visibleCount).map((session) => {
								const name = nameOf(session);
								const Icon = session.mode === "code" ? Code : ChatCircle;
								return (
									<li className="memory-session-row" key={session.sessionId}>
										<header className="memory-session-heading">
											<span className="memory-session-icon">
												<Icon size={19} aria-hidden="true" />
											</span>
											<div className="memory-session-identity">
												<strong>{name}</strong>
												<span title={session.cwd ?? undefined}>
													{session.cwdOrigin === "managed" || !session.cwd ? t("No project") : session.cwd}
												</span>
											</div>
											<div className="memory-session-badges">
												{session.sessionId === currentSessionId && <span>{t("Current conversation")}</span>}
												{session.archived && <span>{t("Archived")}</span>}
											</div>
										</header>
										<div className="memory-session-options">
											{(
												[
													{ flag: "useMemory", label: "Use saved memories" },
													{ flag: "contributeMemory", label: "Save new memories" },
												] as const
											).map(({ flag, label }) => (
												<div className="memory-session-option" key={flag}>
													<span>{t(label)}</span>
													<label className="web-search-toggle">
														<input
															aria-label={t(
																flag === "useMemory" ? "Use saved memories: {{name}}" : "Save new memories: {{name}}",
																{ name },
															)}
															role="switch"
															checked={session[flag] !== false}
															disabled={!serverReady || busy !== null}
															onChange={(event) => void change(session.sessionId, flag, event.target.checked)}
															type="checkbox"
														/>
														<span aria-hidden="true" className="web-search-toggle-track" />
													</label>
												</div>
											))}
										</div>
										<footer className="memory-session-meta">
											<span>{new Date(session.createdAt).toLocaleString()}</span>
											{busy === session.sessionId && <span role="status">{t("Saving…")}</span>}
										</footer>
									</li>
								);
							})}
						</ul>
					)}
					{filtered.length > visibleCount && (
						<button
							className="settings-secondary-button"
							onClick={() => setVisibleCount((count) => count + 50)}
							type="button"
						>
							{t("Show more")}
						</button>
					)}
				</MemoryDialog>
			)}
		</>
	);
}
