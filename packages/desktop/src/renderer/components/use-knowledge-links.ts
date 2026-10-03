import type { KnowledgeLibrary } from "@metis/app-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

export const KNOWLEDGE_CHANGED_EVENT = "metis:knowledge-changed";
export function notifyKnowledgeChanged() {
	window.dispatchEvent(new Event(KNOWLEDGE_CHANGED_EVENT));
}

export function useKnowledgeLinks(
	api: MetisDesktopApi,
	sessionId: string | undefined,
	active = true,
	prepareSession?: () => Promise<string | null>,
) {
	const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
	const [linked, setLinked] = useState<KnowledgeLibrary[]>([]);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(active);
	const [error, setError] = useState<string>();
	const revision = useRef(0);
	const reload = useCallback(async () => {
		const request = ++revision.current;
		try {
			const [catalog, links] = await Promise.all([
				api.listKnowledgeLibraries(),
				sessionId ? api.getSessionKnowledge({ sessionId }) : Promise.resolve({ libraries: [] }),
			]);
			if (request !== revision.current) return;
			setLibraries(catalog.libraries);
			setLinked(links.libraries);
			setError(undefined);
		} catch (cause) {
			if (request === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (request === revision.current) setLoading(false);
		}
	}, [api, sessionId]);
	useEffect(() => {
		setLibraries([]);
		setLinked([]);
		setError(undefined);
		setLoading(active);
		if (!active) return;
		void reload();
		const refresh = () => {
			void reload();
		};
		window.addEventListener(KNOWLEDGE_CHANGED_EVENT, refresh);
		window.addEventListener("focus", refresh);
		return () => {
			++revision.current;
			window.removeEventListener(KNOWLEDGE_CHANGED_EVENT, refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [active, reload]);
	const toggle = async (library: KnowledgeLibrary) => {
		if (busy) return;
		const request = revision.current;
		setBusy(true);
		try {
			const id = sessionId ?? (await prepareSession?.());
			if (!id) return;
			// Read the current links before mutation so another panel's change is retained.
			const current = await api.getSessionKnowledge({ sessionId: id });
			const ids = current.libraries.map((item) => item.id);
			const result = await api.setSessionKnowledge({
				sessionId: id,
				requestId: crypto.randomUUID(),
				libraryIds: ids.includes(library.id) ? ids.filter((id) => id !== library.id) : [...ids, library.id],
			});
			if (request === revision.current) {
				setLinked(result.libraries);
				setError(undefined);
			}
			notifyKnowledgeChanged();
		} catch (cause) {
			if (request === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	return { libraries, linked, busy, loading, error, reload, toggle };
}
