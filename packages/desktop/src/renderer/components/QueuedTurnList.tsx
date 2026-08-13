import type { QueuedTurnView } from "@metis/app-protocol";
import { ArrowBendUpLeft, DotsThree, Paperclip, PencilSimple, Trash } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { actionMenuPosition } from "./action-menu-position.ts";

interface QueuedTurnListProps {
	readonly disabled: boolean;
	readonly running: boolean;
	readonly turns: readonly QueuedTurnView[];
	readonly onDelete: (turn: QueuedTurnView) => Promise<void>;
	readonly onSend: (turn: QueuedTurnView, delivery: "steer" | "start") => Promise<void>;
	readonly onUpdate: (turn: QueuedTurnView, text: string) => Promise<void>;
}

export function QueuedTurnList({ disabled, running, turns, onDelete, onSend, onUpdate }: QueuedTurnListProps) {
	const { t } = useTranslation();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [menuId, setMenuId] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const menuTrigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const updateMenuPosition = useCallback(() => {
		if (menuTrigger.current) setMenuPosition(actionMenuPosition(menuTrigger.current.getBoundingClientRect(), 112, 1));
	}, []);

	useEffect(() => {
		if (editingId && !turns.some(({ queueItemId }) => queueItemId === editingId)) setEditingId(null);
		if (menuId && !turns.some(({ queueItemId }) => queueItemId === menuId)) setMenuId(null);
	}, [editingId, menuId, turns]);

	useEffect(() => {
		if (!menuId) return;
		queueMicrotask(() => menu.current?.querySelector<HTMLButtonElement>("button")?.focus());
		const close = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!menuTrigger.current?.contains(target) && !menu.current?.contains(target)) {
				setMenuId(null);
			}
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenuId(null);
				queueMicrotask(() => menuTrigger.current?.focus());
			}
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", escape);
		window.addEventListener("resize", updateMenuPosition);
		window.addEventListener("scroll", updateMenuPosition, true);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", escape);
			window.removeEventListener("resize", updateMenuPosition);
			window.removeEventListener("scroll", updateMenuPosition, true);
		};
	}, [menuId, updateMenuPosition]);
	useLayoutEffect(() => {
		if (menuId) updateMenuPosition();
	}, [menuId, updateMenuPosition]);

	if (turns.length === 0) return null;

	const run = async (queueItemId: string, action: () => Promise<void>) => {
		setPendingId(queueItemId);
		try {
			await action();
		} finally {
			setPendingId(null);
		}
	};

	const menuTurn = turns.find(({ queueItemId }) => queueItemId === menuId);
	return (
		<section aria-label={t("Queued messages")} className="queued-turn-list">
			{turns.map((turn, index) => {
				const editing = editingId === turn.queueItemId;
				const pending = pendingId === turn.queueItemId;
				const sending = turn.state === "sending";
				const unavailable = disabled || pending || sending;
				const canStart = index === 0;
				const attachmentNames = turn.attachments.map(({ name }) => name).join(", ");
				return (
					<div aria-label={t("Queued message {{index}}", { index: index + 1 })} className={`queued-turn-row is-${turn.state}`} key={turn.queueItemId} role="group">
						{editing ? (
							<form
								className="queued-turn-editor"
								onSubmit={(event) => {
									event.preventDefault();
									void run(turn.queueItemId, async () => {
										await onUpdate(turn, draft.trim());
										setEditingId(null);
									}).catch(() => undefined);
								}}
							>
								<label className="sr-only" htmlFor={`queued-turn-${turn.queueItemId}`}>{t("Edit queued message")}</label>
								<textarea
									autoFocus
									disabled={unavailable}
									id={`queued-turn-${turn.queueItemId}`}
									onChange={(event) => setDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Escape") setEditingId(null);
									}}
									rows={2}
									value={draft}
								/>
								{turn.attachments.length > 0 && (
									<span className="queued-turn-editor-attachments"><Paperclip aria-hidden="true" size={12} />{attachmentNames}</span>
								)}
								<div className="queued-turn-editor-actions">
									<button disabled={pending} onClick={() => setEditingId(null)} type="button">{t("Cancel")}</button>
									<button disabled={unavailable || (!draft.trim() && turn.attachments.length === 0)} type="submit">{t("Save")}</button>
								</div>
							</form>
						) : (
							<>
								<div className="queued-turn-copy">
									<span className="queued-turn-state">{t(turn.state === "sending" ? "Sending…" : turn.state === "paused" ? "Paused" : "Queued")}</span>
									<span className="queued-turn-text" title={turn.text || attachmentNames}>{turn.text || attachmentNames}</span>
									{turn.attachments.length > 0 && turn.text && (
										<span className="queued-turn-attachments" title={attachmentNames}><Paperclip aria-hidden="true" size={12} />{attachmentNames}</span>
									)}
								</div>
								<div className="queued-turn-actions">
									<button
										aria-label={t(running ? "Guide with queued message" : "Send queued message")}
										className="queued-turn-send"
										disabled={unavailable || (!running && !canStart)}
										onClick={() => void run(turn.queueItemId, () => onSend(turn, running ? "steer" : "start")).catch(() => undefined)}
										title={!running && !canStart ? t("Queued messages are sent in order") : undefined}
										type="button"
									>
										<ArrowBendUpLeft aria-hidden="true" size={14} />{t(running ? "Guide" : "Send")}
									</button>
									<button aria-label={t("Delete queued message")} disabled={unavailable} onClick={() => void run(turn.queueItemId, () => onDelete(turn)).catch(() => undefined)} type="button"><Trash aria-hidden="true" size={14} /></button>
									<div className="queued-turn-menu">
										<button aria-expanded={menuId === turn.queueItemId} aria-haspopup="menu" aria-label={t("Queued message actions")} disabled={unavailable} onClick={(event) => { menuTrigger.current = event.currentTarget; setMenuId((current) => current === turn.queueItemId ? null : turn.queueItemId); }} type="button"><DotsThree aria-hidden="true" size={16} weight="bold" /></button>
									</div>
								</div>
							</>
						)}
					</div>
				);
			})}
			{menuTurn && createPortal(
				<div className="queued-turn-popover" ref={menu} role="menu" style={menuPosition}>
					<button onClick={() => { setDraft(menuTurn.text); setEditingId(menuTurn.queueItemId); setMenuId(null); }} role="menuitem" type="button"><PencilSimple aria-hidden="true" size={14} />{t("Edit")}</button>
				</div>,
				document.body,
			)}
		</section>
	);
}
