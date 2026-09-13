import type { QueuedTurnView } from "@metis/app-protocol";
import { ArrowBendUpLeft, Paperclip, PencilSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface QueuedTurnListProps {
	readonly disabled: boolean;
	readonly running: boolean;
	readonly turns: readonly QueuedTurnView[];
	readonly onDelete: (turn: QueuedTurnView) => Promise<void>;
	readonly onEdit: (turn: QueuedTurnView) => Promise<void>;
	readonly onSend: (turn: QueuedTurnView, delivery: "steer" | "start") => Promise<void>;
}

export function QueuedTurnList({ disabled, running, turns, onDelete, onEdit, onSend }: QueuedTurnListProps) {
	const { t } = useTranslation();
	const [pendingId, setPendingId] = useState<string | null>(null);

	if (turns.length === 0) return null;

	const run = async (queueItemId: string, action: () => Promise<void>) => {
		setPendingId(queueItemId);
		try {
			await action();
		} finally {
			setPendingId(null);
		}
	};

	return (
		<section aria-label={t("Queued messages")} className="queued-turn-list">
			{turns.map((turn, index) => {
				const pending = pendingId === turn.queueItemId;
				const sending = turn.state === "sending";
				const unavailable = disabled || pending || sending;
				const canStart = index === 0;
				const attachmentNames = turn.attachments.map(({ name }) => name).join(", ");
				return (
					<div aria-label={t("Queued message {{index}}", { index: index + 1 })} className={`queued-turn-row is-${turn.state}`} key={turn.queueItemId} role="group">
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
							<button aria-label={t("Edit queued message")} className="queued-turn-edit" disabled={unavailable} onClick={() => void run(turn.queueItemId, () => onEdit(turn)).catch(() => undefined)} type="button"><PencilSimple aria-hidden="true" size={14} />{t("Edit")}</button>
							<button aria-label={t("Delete queued message")} disabled={unavailable} onClick={() => void run(turn.queueItemId, () => onDelete(turn)).catch(() => undefined)} type="button"><Trash aria-hidden="true" size={14} /></button>
						</div>
					</div>
				);
			})}
		</section>
	);
}
