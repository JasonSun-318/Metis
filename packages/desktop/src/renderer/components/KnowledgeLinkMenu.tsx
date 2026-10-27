import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { Books, Check, SidebarSimple } from "../icons.tsx";
import { useKnowledgeLinks } from "./use-knowledge-links.ts";

export interface KnowledgeLinkMenuProps {
	readonly api: MetisDesktopApi;
	readonly sessionId?: string;
	readonly disabled?: boolean;
	readonly onPrepare?: () => Promise<string | null>;
	readonly onOpen: (sessionId: string) => void;
	readonly sidebarLabel?: string;
}

export function KnowledgeLinkMenu({
	api,
	sessionId,
	onPrepare,
	onOpen,
	sidebarLabel,
	onClose,
}: KnowledgeLinkMenuProps & { readonly onClose: () => void }) {
	const { t } = useTranslation();
	const { libraries, linked, busy, loading, error, toggle, reload } = useKnowledgeLinks(
		api,
		sessionId,
		true,
		onPrepare,
	);
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState<string>();
	const firstLibrary = useRef<HTMLButtonElement>(null);
	const sidebarButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!loading) (firstLibrary.current ?? sidebarButton.current)?.focus({ preventScroll: true });
	}, [loading]);
	const openSidebar = async () => {
		setOpening(true);
		try {
			const id = sessionId ?? (await onPrepare?.());
			if (!id) return;
			onOpen(id);
			onClose();
		} catch (cause) {
			setOpenError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setOpening(false);
		}
	};
	return (
		<>
			<div className="knowledge-menu-heading">
				<span>{t("Link knowledge libraries")}</span>
				<span>{t("{{count}} linked", { count: linked.length })}</span>
			</div>
			{loading && <output className="knowledge-menu-empty">{t("Loading…")}</output>}
			{libraries.map((library, index) => {
				const selected = linked.some((item) => item.id === library.id);
				return (
					<button
						aria-checked={selected}
						aria-label={library.name}
						aria-description={library.path}
						className="knowledge-menu-library"
						disabled={busy || opening}
						key={library.id}
						onClick={() => void toggle(library)}
						role="menuitemcheckbox"
						ref={index === 0 ? firstLibrary : undefined}
						title={library.path}
						type="button"
					>
						<Books aria-hidden="true" size={16} />
						<span className="knowledge-menu-library-label">
							<span>{library.name}</span>
							<small>{library.path}</small>
						</span>
						<span className="knowledge-menu-check">
							{selected && <Check aria-hidden="true" size={14} weight="bold" />}
						</span>
					</button>
				);
			})}
			{!loading && !libraries.length && !error && (
				<p className="knowledge-menu-empty">{t("Choose a directory in the Knowledge sidebar first.")}</p>
			)}
			{(error || openError) && (
				<div className="knowledge-menu-error" role="alert">
					{error || openError}
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setOpenError(undefined);
							void reload();
						}}
					>
						{t("Retry")}
					</button>
				</div>
			)}
			<hr className="composer-menu-separator" style={{ border: 0 }} />
			<button
				type="button"
				disabled={busy || opening}
				onClick={() => void openSidebar()}
				role="menuitem"
				ref={sidebarButton}
			>
				<SidebarSimple aria-hidden="true" size={16} />
				<span>{t(sidebarLabel ?? "Open knowledge sidebar")}</span>
			</button>
		</>
	);
}
