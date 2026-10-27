import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type MarkdownDocument, markdownSourceKey } from "./markdown-resources.ts";
import { previewBytesCache } from "./preview/preview-bytes-cache.ts";
import { KNOWLEDGE_CHANGED_EVENT } from "./use-knowledge-links.ts";

export interface MarkdownEmbedBudget {
	readonly entries: Map<string, number>;
}

export interface MarkdownDocumentState {
	readonly document: MarkdownDocument;
	readonly trail: readonly string[];
	readonly budget: MarkdownEmbedBudget;
	readonly epoch?: number;
}

const Context = createContext<MarkdownDocumentState | null>(null);

export function useMarkdownDocument() {
	return useContext(Context);
}

export function MarkdownDocumentProvider({
	document,
	state,
	children,
}: {
	readonly document?: MarkdownDocument;
	readonly state?: MarkdownDocumentState;
	readonly children: ReactNode;
}) {
	const [epoch, setEpoch] = useState(0);
	useEffect(() => {
		if (!document || document.owner.source !== "knowledge") return;
		const { libraryId } = document.owner;
		const invalidate = () => {
			previewBytesCache.deleteLibrary(libraryId);
			setEpoch((value) => value + 1);
		};
		window.addEventListener(KNOWLEDGE_CHANGED_EVENT, invalidate);
		window.addEventListener("focus", invalidate);
		const unsubscribe = document.api.subscribe?.((event) => {
			if (event.type === "knowledge-libraries") invalidate();
		});
		return () => {
			window.removeEventListener(KNOWLEDGE_CHANGED_EVENT, invalidate);
			window.removeEventListener("focus", invalidate);
			unsubscribe?.();
		};
	}, [document]);
	const key = document ? markdownSourceKey(document.owner) : "";
	const contentRevision = document?.revision;
	// biome-ignore lint/correctness/useExhaustiveDependencies(key): A new source identity or content revision owns a fresh page budget.
	// biome-ignore lint/correctness/useExhaustiveDependencies(epoch): Invalidation cancels the old resource tree and its reservations.
	// biome-ignore lint/correctness/useExhaustiveDependencies(contentRevision): Changed source content owns a fresh page budget.
	const budget = useMemo<MarkdownEmbedBudget>(() => ({ entries: new Map() }), [key, contentRevision, epoch]);
	const value = useMemo(
		() => state ?? (document ? { document, trail: [markdownSourceKey(document.owner)], budget, epoch } : null),
		[state, document, budget, epoch],
	);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
