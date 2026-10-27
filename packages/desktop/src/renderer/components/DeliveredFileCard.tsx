import type { SessionDeliveredFileView } from "@metis/app-protocol";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { fileBaseName, fileTypeLabel } from "../file-type-label.ts";
import {
	Archive,
	CaretDown,
	File,
	FileCode,
	FileCss,
	FileCsv,
	FileDoc,
	FileHtml,
	FileImage,
	FileMd,
	FilePdf,
	FilePpt,
	FilePy,
	FileText,
	FileTs,
	FileXls,
	FileZip,
	FolderOpen,
	type Icon,
} from "../icons.tsx";
import { actionMenuPosition } from "./action-menu-position.ts";

interface DeliveredFileCardProps {
	readonly file: SessionDeliveredFileView;
	readonly onOpen: (action: "default" | "reveal") => void;
	readonly onPreview?: (file: SessionDeliveredFileView) => void;
}

const FILE_ICON_BY_EXTENSION: Record<string, Icon> = {
	csv: FileCsv,
	xls: FileXls,
	xlsx: FileXls,
	doc: FileDoc,
	docx: FileDoc,
	ppt: FilePpt,
	pptx: FilePpt,
	md: FileMd,
	markdown: FileMd,
	pdf: FilePdf,
	png: FileImage,
	jpg: FileImage,
	jpeg: FileImage,
	gif: FileImage,
	webp: FileImage,
	svg: FileImage,
	txt: FileText,
	json: FileCode,
	ts: FileTs,
	tsx: FileTs,
	js: FileCode,
	jsx: FileCode,
	py: FilePy,
	html: FileHtml,
	css: FileCss,
	zip: FileZip,
	tar: Archive,
	gz: Archive,
	tgz: Archive,
	"7z": Archive,
	rar: Archive,
};

function DeliveredFileIcon({ name }: { readonly name: string }) {
	const extension = name.match(/\.([^.]+)$/u)?.[1]?.toLowerCase();
	const IconComponent = (extension && FILE_ICON_BY_EXTENSION[extension]) || File;
	return <IconComponent aria-hidden="true" size={26} weight="duotone" />;
}

export function DeliveredFileCard({ file, onOpen, onPreview }: DeliveredFileCardProps) {
	const { t } = useTranslation();
	const available = file.availability === "available";
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const updateMenuPosition = useCallback(() => {
		if (triggerRef.current) setMenuPosition(actionMenuPosition(triggerRef.current.getBoundingClientRect(), 180, 1));
	}, []);

	useLayoutEffect(() => {
		if (menuOpen) updateMenuPosition();
	}, [menuOpen, updateMenuPosition]);

	useEffect(() => {
		if (!menuOpen) return;
		queueMicrotask(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
		const close = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenuOpen(false);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setMenuOpen(false);
			queueMicrotask(() => triggerRef.current?.focus());
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", handleEscape);
		window.addEventListener("resize", updateMenuPosition);
		window.addEventListener("scroll", updateMenuPosition, true);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", handleEscape);
			window.removeEventListener("resize", updateMenuPosition);
			window.removeEventListener("scroll", updateMenuPosition, true);
		};
	}, [menuOpen, updateMenuPosition]);

	const handleMainAction = () => {
		if (!available) return;
		if (onPreview) {
			onPreview(file);
		} else {
			onOpen("default");
		}
	};

	return (
		/* biome-ignore lint/a11y/useKeyWithClickEvents: The card forwards clicks to its native Preview button, which supplies the same keyboard action. */
		<article
			aria-disabled={!available}
			className={`transcript-delivered-file-card${available ? "" : " is-unavailable"}`}
			onClick={(e) => {
				if (!available) return;
				const target = e.target as HTMLElement;
				if (
					!target.closest(".transcript-delivered-file-actions") &&
					!target.closest(".transcript-delivered-file-menu")
				) {
					handleMainAction();
				}
			}}
		>
			<div className="transcript-delivered-file-icon">
				<DeliveredFileIcon name={file.name} />
			</div>
			<div className="transcript-delivered-file-copy">
				<strong title={file.name}>{fileBaseName(file.name)}</strong>
				<small>{fileTypeLabel(file.name, t)}</small>
				{file.message ? <p title={file.message}>{file.message}</p> : null}
				{available ? null : <p className="transcript-delivered-file-unavailable">{t("File unavailable")}</p>}
			</div>
			<div className="transcript-delivered-file-actions">
				<button
					className="transcript-delivered-file-open"
					disabled={!available}
					onClick={handleMainAction}
					type="button"
				>
					{t("Preview")}
				</button>
				<button
					aria-expanded={menuOpen}
					aria-haspopup="menu"
					aria-label={t("More file actions")}
					className="transcript-delivered-file-menu-trigger"
					disabled={!available}
					onClick={() => setMenuOpen((current) => !current)}
					ref={triggerRef}
					type="button"
				>
					<CaretDown aria-hidden="true" size={12} />
				</button>
			</div>
			{available && menuOpen
				? createPortal(
						<div className="transcript-delivered-file-menu" ref={menuRef} role="menu" style={menuPosition}>
							<button
								onClick={() => {
									setMenuOpen(false);
									onOpen("default");
								}}
								role="menuitem"
								type="button"
							>
								{t("Open in default app")}
							</button>
							<button
								onClick={() => {
									setMenuOpen(false);
									onOpen("reveal");
								}}
								role="menuitem"
								type="button"
							>
								<FolderOpen aria-hidden="true" size={14} />
								{t("Show in folder")}
							</button>
						</div>,
						document.body,
					)
				: null}
		</article>
	);
}
