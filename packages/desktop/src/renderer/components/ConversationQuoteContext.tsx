import type { ClientParams } from "@metis/app-protocol";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatText, X } from "../icons.tsx";
import { DrawerDetails } from "./DrawerDetails.tsx";

export type ConversationQuoteInput = NonNullable<ClientParams<"turn/start">["conversationQuotes"]>[number];
export interface DraftConversationQuote {
	readonly id: string;
	readonly sessionId: string;
	readonly input: ConversationQuoteInput;
}

interface QuoteActions {
	readonly enabled: boolean;
	readonly drafts: readonly DraftConversationQuote[];
	readonly lastAccepted: { readonly sessionId: string; readonly sequence: number } | null;
	add(draft: DraftConversationQuote): void;
	remove(ids: readonly string[]): void;
	accepted(sessionId: string): void;
}
const ConversationQuotes = createContext<QuoteActions | null>(null);
export const useConversationQuotes = () => useContext(ConversationQuotes);

export function ConversationQuoteProvider({
	enabled,
	children,
}: {
	readonly enabled: boolean;
	readonly children: ReactNode;
}) {
	const { t } = useTranslation();
	const [drafts, setDrafts] = useState<readonly DraftConversationQuote[]>([]);
	const [lastAccepted, setLastAccepted] = useState<QuoteActions["lastAccepted"]>(null);
	const current = useRef({ enabled, drafts });
	current.current = { enabled, drafts };
	const mounted = useRef(true);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const value = useMemo<QuoteActions>(
		() => ({
			enabled,
			drafts,
			lastAccepted,
			accepted(sessionId) {
				if (mounted.current)
					setLastAccepted((previous) => ({ sessionId, sequence: (previous?.sequence ?? 0) + 1 }));
			},
			add(draft) {
				if (!mounted.current || !current.current.enabled)
					throw new Error(t("This conversation is not ready to send"));
				if (
					current.current.drafts.some(
						(item) =>
							item.id === draft.id ||
							(item.sessionId === draft.sessionId &&
								item.input.sourceItemId === draft.input.sourceItemId &&
								item.input.selectedText === draft.input.selectedText),
					)
				)
					return;
				const next = [...current.current.drafts, draft];
				const own = next.filter((item) => item.sessionId === draft.sessionId);
				if (own.length > 8) throw new Error(t("Select at most 8 conversation fragments"));
				if (!draft.input.selectedText.trim() || Array.from(draft.input.selectedText).length > 8000)
					throw new Error(t("Select a smaller conversation fragment"));
				if (
					own.reduce((bytes, item) => bytes + new TextEncoder().encode(item.input.selectedText).byteLength, 0) >
					32768
				)
					throw new Error(t("Conversation references exceed 32 KiB; select fewer or smaller fragments"));
				current.current = { ...current.current, drafts: next };
				setDrafts(next);
			},
			remove(ids) {
				if (!mounted.current) return;
				const next = current.current.drafts.filter((item) => !ids.includes(item.id));
				current.current = { ...current.current, drafts: next };
				setDrafts(next);
			},
		}),
		[enabled, drafts, lastAccepted, t],
	);
	return <ConversationQuotes.Provider value={value}>{children}</ConversationQuotes.Provider>;
}

export function ConversationQuoteChips({ sessionId }: { readonly sessionId?: string | null }) {
	const context = useConversationQuotes();
	const { t } = useTranslation();
	const drafts = sessionId ? (context?.drafts.filter((item) => item.sessionId === sessionId) ?? []) : [];
	if (!drafts.length) return null;
	return (
		<DrawerDetails
			className="composer-selections composer-conversation-quotes"
			summary={
				<>
					<ChatText aria-hidden="true" size={13} />
					{t("{{count}} conversation quotes", { count: drafts.length })}
				</>
			}
		>
			<div className="composer-selection-list">
				{drafts.map((draft) => (
					<div className="composer-selection" key={draft.id}>
						<div>
							<strong>{t(draft.input.sourceRole === "assistant" ? "From Metis" : "From you")}</strong>
							<button
								type="button"
								aria-label={t("Remove conversation quote")}
								onClick={() => context?.remove([draft.id])}
							>
								<X aria-hidden="true" size={13} />
							</button>
						</div>
						<blockquote>{draft.input.selectedText}</blockquote>
					</div>
				))}
			</div>
		</DrawerDetails>
	);
}
