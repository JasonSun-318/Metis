import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const ExpansionContext = createContext<{ expanded: boolean; resizing: boolean; toggle: () => void } | null>(null);
export const usePreviewExpansion = () => useContext(ExpansionContext);

export function PreviewFrame({ children, active }: { children: ReactNode; active: boolean }) {
	const { t } = useTranslation();
	const ref = useRef<HTMLDialogElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [resizing, setResizing] = useState(false);
	useLayoutEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		// Switch the same dialog between inline and the native top layer; keep the viewer mounted.
		setResizing(true);
		dialog.close();
		if (expanded && active) dialog.showModal();
		else if (active) dialog.setAttribute("open", "");
		// Let ResizeObserver and the viewer's layout effects settle before tracking scroll again.
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => setResizing(false));
		});
		return () => cancelAnimationFrame(frame);
	}, [expanded, active]);
	useLayoutEffect(() => {
		if (!active) setExpanded(false);
	}, [active]);
	return (
		<ExpansionContext.Provider
			value={{ expanded: expanded && active, resizing, toggle: () => setExpanded((value) => !value) }}
		>
			<dialog
				ref={ref}
				className="preview-frame"
				aria-label={t("File preview")}
				role={expanded ? "dialog" : "region"}
				onCancel={(event) => {
					event.preventDefault();
					setExpanded(false);
				}}
			>
				{children}
			</dialog>
		</ExpansionContext.Provider>
	);
}
