import {
	ArrowSquareOut,
	FolderOpen,
	MagnifyingGlassMinus,
	MagnifyingGlassPlus,
	Moon,
	Sun,
	X,
} from "@phosphor-icons/react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceFileIcon } from "../WorkspaceFileIcon.tsx";

export interface PreviewToolbarProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly mediaType?: string;
	readonly zoom?: number;
	readonly onZoomIn?: () => void;
	readonly onZoomOut?: () => void;
	readonly onZoomReset?: () => void;
	readonly isInverted?: boolean;
	readonly onToggleInvert?: () => void;
	readonly showInvertToggle?: boolean;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
	readonly onClose?: () => void;
	readonly extraActions?: React.ReactNode;
}

function formatBytes(bytes?: number): string {
	if (bytes === undefined || Number.isNaN(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PreviewToolbar({
	fileName,
	byteLength,
	zoom,
	onZoomIn,
	onZoomOut,
	onZoomReset,
	isInverted,
	onToggleInvert,
	showInvertToggle = false,
	onOpenDefault,
	onReveal,
	onClose,
	extraActions,
}: PreviewToolbarProps) {
	const { t } = useTranslation();

	return (
		<header className="file-preview-toolbar preview-toolbar">
			<div className="preview-toolbar-meta">
				<WorkspaceFileIcon path={fileName} size={15} />
				<strong className="preview-toolbar-title" title={fileName}>
					{fileName}
				</strong>
				{byteLength !== undefined && (
					<span className="preview-toolbar-size">{formatBytes(byteLength)}</span>
				)}
			</div>

			<div className="preview-toolbar-center">{extraActions}</div>

			<div className="preview-toolbar-actions">
				{showInvertToggle && onToggleInvert && (
					<button
						aria-label={t(isInverted ? "Disable dark reading mode" : "Enable dark reading mode")}
						className={`preview-toolbar-btn${isInverted ? " is-active" : ""}`}
						onClick={onToggleInvert}
						title={t(isInverted ? "Light background" : "Dark background")}
						type="button"
					>
						{isInverted ? <Sun aria-hidden="true" size={14} /> : <Moon aria-hidden="true" size={14} />}
					</button>
				)}

				{zoom !== undefined && onZoomIn && onZoomOut && onZoomReset && (
					<div className="preview-zoom-controls">
						<button
							aria-label={t("Zoom out")}
							className="preview-toolbar-btn"
							disabled={zoom <= 50}
							onClick={onZoomOut}
							title={t("Zoom out")}
							type="button"
						>
							<MagnifyingGlassMinus aria-hidden="true" size={14} />
						</button>
						<button
							aria-label={t("Reset zoom")}
							className="preview-zoom-label"
							onClick={onZoomReset}
							title={t("Reset zoom (100%)")}
							type="button"
						>
							{zoom}%
						</button>
						<button
							aria-label={t("Zoom in")}
							className="preview-toolbar-btn"
							disabled={zoom >= 300}
							onClick={onZoomIn}
							title={t("Zoom in")}
							type="button"
						>
							<MagnifyingGlassPlus aria-hidden="true" size={14} />
						</button>
					</div>
				)}

				{onOpenDefault && (
					<button
						aria-label={t("Open in default app")}
						className="preview-toolbar-btn"
						onClick={onOpenDefault}
						title={t("Open in default app")}
						type="button"
					>
						<ArrowSquareOut aria-hidden="true" size={14} />
					</button>
				)}

				{onReveal && (
					<button
						aria-label={t("Show in folder")}
						className="preview-toolbar-btn"
						onClick={onReveal}
						title={t("Show in folder")}
						type="button"
					>
						<FolderOpen aria-hidden="true" size={14} />
					</button>
				)}

				{onClose && (
					<button
						aria-label={t("Close preview")}
						className="preview-toolbar-btn preview-close-btn"
						onClick={onClose}
						title={t("Close preview")}
						type="button"
					>
						<X aria-hidden="true" size={14} />
					</button>
				)}
			</div>
		</header>
	);
}
