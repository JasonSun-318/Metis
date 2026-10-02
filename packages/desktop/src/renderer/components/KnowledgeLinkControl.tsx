import { Books, Link, LinkBreak } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { useKnowledgeLinks } from "./use-knowledge-links.ts";

export function KnowledgeLinkControl({
	api,
	sessionId,
	onOpen,
}: {
	readonly api: MetisDesktopApi;
	readonly sessionId: string;
	readonly onOpen: () => void;
}) {
	const { t } = useTranslation();
	const { libraries, linked, busy, error, toggle } = useKnowledgeLinks(api, sessionId);
	const picker = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (picker.current && !picker.current.contains(event.target as Node)) picker.current.open = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && picker.current?.open) {
				picker.current.open = false;
				picker.current.querySelector("summary")?.focus();
			}
		};
		window.addEventListener("pointerdown", outside);
		window.addEventListener("keydown", escape);
		return () => {
			window.removeEventListener("pointerdown", outside);
			window.removeEventListener("keydown", escape);
		};
	}, []);
	return (
		<div className="composer-knowledge">
			<details className="composer-knowledge-picker" ref={picker}>
				<summary>
					<Books size={15} />
					{t("Knowledge")}
					{linked.length > 0 && <span>{linked.length}</span>}
				</summary>
				<div className="composer-knowledge-menu">
					{!libraries.length && <p>{t("Choose a directory in the Knowledge sidebar first.")}</p>}
					{libraries.map((library) => (
						<button
							key={library.id}
							type="button"
							disabled={busy}
							aria-pressed={linked.some((item) => item.id === library.id)}
							title={library.path}
							onClick={() => void toggle(library)}
						>
							<Link size={14} />
							<span>{library.name}</span>
						</button>
					))}
					<button
						type="button"
						onClick={() => {
							if (picker.current) picker.current.open = false;
							onOpen();
						}}
					>
						{t("Open knowledge sidebar")}
					</button>
				</div>
			</details>
			{linked.map((library) => (
				<button
					className="composer-knowledge-chip"
					key={library.id}
					type="button"
					disabled={busy}
					title={library.path}
					aria-label={t("Unlink knowledge library: {{name}}", { name: library.name })}
					onClick={() => void toggle(library)}
				>
					<LinkBreak size={13} />
					{library.name}
				</button>
			))}
			{error && (
				<span className="knowledge-error" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}
