import type { SessionDeliveredFileView } from "@metis/app-protocol";
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
} from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { fileBaseName, fileTypeLabel } from "../file-type-label.ts";
import { actionMenuPosition } from "./action-menu-position.ts";

interface DeliveredFileCardProps {
	readonly file: SessionDeliveredFileView;
	readonly onOpen: (action: "default" | "reveal") => void;
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

export function DeliveredFileCard({ file, onOpen }: DeliveredFileCardProps) {
	const { t } = useTranslation();
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const updateMenuPosition = useCallback(() => {
		if (triggerRef.current) setMenuPosition(actionMenuPosition(triggerRef.current.getBoundingClientRect(), 176, 1));
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
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setMenuOpen(false);
			queueMicrotask(() => triggerRef.current?.focus());
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
	}, [menuOpen, updateMenuPosition]);

	return (
		<article className="transcript-delivered-file-card">
			<div className="transcript-delivered-file-icon">
				<DeliveredFileIcon name={file.name} />
			</div>
			<div className="transcript-delivered-file-copy">
				<strong title={file.name}>{fileBaseName(file.name)}</strong>
				<small>{fileTypeLabel(file.name, t)}</small>
				{file.message ? <p title={file.message}>{file.message}</p> : null}
			</div>
			<div className="transcript-delivered-file-actions">
				<button className="transcript-delivered-file-open" onClick={() => onOpen("default")} type="button">
					{t("Open")}
				</button>
				<button
					aria-expanded={menuOpen}
					aria-haspopup="menu"
					aria-label={t("More file actions")}
					className="transcript-delivered-file-menu-trigger"
					onClick={() => setMenuOpen((current) => !current)}
					ref={triggerRef}
					type="button"
				>
					<CaretDown aria-hidden="true" size={12} />
				</button>
			</div>
			{menuOpen
				? createPortal(
						<div className="transcript-delivered-file-menu" ref={menuRef} role="menu" style={menuPosition}>
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
