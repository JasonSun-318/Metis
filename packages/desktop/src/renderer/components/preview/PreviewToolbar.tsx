import { type ReactNode, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	ArrowsIn,
	ArrowsOut,
	CaretLeft,
	CaretRight,
	DotsThree,
	MagnifyingGlassMinus,
	MagnifyingGlassPlus,
	X,
} from "../../icons.tsx";
import { WorkspaceFileIcon } from "../WorkspaceFileIcon.tsx";
import { usePreviewExpansion } from "./PreviewFrame.tsx";
import type { PreviewZoom } from "./preview-layout.ts";

export interface PreviewToolbarProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly mediaType?: string;
	readonly zoom?: number;
	readonly zoomMode?: PreviewZoom;
	readonly onZoomModeChange?: (mode: PreviewZoom) => void;
	readonly onZoomIn?: () => void;
	readonly onZoomOut?: () => void;
	readonly onZoomReset?: () => void;
	readonly isInverted?: boolean;
	readonly onToggleInvert?: () => void;
	readonly showInvertToggle?: boolean;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
	readonly onClose?: () => void;
	readonly extraActions?: ReactNode;
}

function formatBytes(bytes?: number): string {
	if (bytes === undefined || Number.isNaN(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PreviewPageControls({
	current,
	total,
	onChange,
}: {
	current: number;
	total: number;
	onChange: (page: number) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="preview-page-navigator">
			<button
				aria-label={t("Previous page")}
				className="preview-toolbar-btn"
				disabled={current <= 1}
				onClick={() => onChange(current - 1)}
				type="button"
			>
				<CaretLeft size={13} />
			</button>
			<span className="preview-page-info" title={`${current} / ${total}`}>
				{current} / {total}
			</span>
			<button
				aria-label={t("Next page")}
				className="preview-toolbar-btn"
				disabled={current >= total}
				onClick={() => onChange(current + 1)}
				type="button"
			>
				<CaretRight size={13} />
			</button>
		</div>
	);
}

export function PreviewToolbar({
	fileName,
	byteLength,
	zoom,
	zoomMode,
	onZoomModeChange,
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
	const expansion = usePreviewExpansion();
	const menuId = useId();
	const menuButton = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const secondary = onOpenDefault || onReveal || (showInvertToggle && onToggleInvert) || byteLength !== undefined;
	const presetZooms = [25, 50, 75, 100, 125, 150, 200, 300];
	return (
		<header className="file-preview-toolbar preview-toolbar">
			<div className="preview-toolbar-meta">
				<WorkspaceFileIcon path={fileName} size={15} />
				<strong className="preview-toolbar-title" title={fileName}>
					{fileName}
				</strong>
			</div>
			<div className="preview-toolbar-center">{extraActions}</div>
			<div className="preview-toolbar-zoom">
				{zoom !== undefined && onZoomIn && onZoomOut && (onZoomReset || onZoomModeChange) && (
					<div className="preview-zoom-controls">
						<button
							aria-label={t("Zoom out")}
							className="preview-toolbar-btn"
							disabled={zoom <= (onZoomModeChange ? 10 : 50)}
							onClick={onZoomOut}
							type="button"
						>
							<MagnifyingGlassMinus size={14} />
						</button>
						{onZoomModeChange ? (
							<select
								aria-label={t("Zoom")}
								className="preview-zoom-label"
								data-mode={typeof zoomMode === "number" ? "manual" : zoomMode}
								value={zoomMode}
								title={`${t(zoomMode === "width" ? "Fit width" : zoomMode === "page" ? "Fit page" : "Zoom")}: ${Math.round(zoom)}%`}
								onChange={(event) =>
									onZoomModeChange(
										event.target.value === "width" || event.target.value === "page"
											? event.target.value
											: Number(event.target.value),
									)
								}
							>
								<option value="width">{t("Fit width")}</option>
								<option value="page">{t("Fit page")}</option>
								{typeof zoomMode === "number" && !presetZooms.includes(zoomMode) && (
									<option value={zoomMode}>{Math.round(zoomMode)}%</option>
								)}
								{presetZooms.map((value) => (
									<option key={value} value={value}>
										{value === 100 ? t("Actual size") : `${value}%`}
									</option>
								))}
							</select>
						) : (
							<button
								aria-label={t("Reset zoom")}
								className="preview-zoom-label"
								onClick={onZoomReset}
								title={t("Reset zoom (100%)")}
								type="button"
							>
								{zoom}%
							</button>
						)}
						<button
							aria-label={t("Zoom in")}
							className="preview-toolbar-btn"
							disabled={zoom >= 300}
							onClick={onZoomIn}
							type="button"
						>
							<MagnifyingGlassPlus size={14} />
						</button>
					</div>
				)}
			</div>
			<div className="preview-toolbar-actions">
				{secondary && (
					<>
						<button
							ref={menuButton}
							aria-label={t("More preview actions")}
							className="preview-toolbar-btn"
							popoverTarget={menuId}
							type="button"
						>
							<DotsThree size={18} />
						</button>
						<div
							ref={menu}
							id={menuId}
							popover="auto"
							className="preview-actions-menu"
							onToggle={(event) => {
								if (event.newState !== "open") return;
								const rect = menuButton.current?.getBoundingClientRect();
								if (rect) {
									event.currentTarget.style.top = `${rect.bottom + 4}px`;
									event.currentTarget.style.left = `${Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208))}px`;
								}
							}}
						>
							{byteLength !== undefined && (
								<span className="preview-toolbar-size">{formatBytes(byteLength)}</span>
							)}
							{onOpenDefault && (
								<button
									aria-label={t("Open in default app")}
									type="button"
									onClick={() => {
										menu.current?.hidePopover();
										onOpenDefault();
									}}
								>
									{t("Open in default app")}
								</button>
							)}
							{onReveal && (
								<button
									aria-label={t("Show in folder")}
									type="button"
									onClick={() => {
										menu.current?.hidePopover();
										onReveal();
									}}
								>
									{t("Show in folder")}
								</button>
							)}
							{showInvertToggle && onToggleInvert && (
								<button
									aria-label={t(isInverted ? "Disable dark reading mode" : "Enable dark reading mode")}
									type="button"
									onClick={() => {
										menu.current?.hidePopover();
										onToggleInvert();
									}}
								>
									{t(isInverted ? "Disable dark reading mode" : "Enable dark reading mode")}
								</button>
							)}
						</div>
					</>
				)}
				{expansion && (
					<button
						aria-label={t(expansion.expanded ? "Collapse preview" : "Expand preview")}
						className="preview-toolbar-btn"
						onClick={expansion.toggle}
						type="button"
					>
						{expansion.expanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
					</button>
				)}
				{onClose && (
					<button
						aria-label={t("Close preview")}
						className="preview-toolbar-btn preview-close-btn"
						onClick={onClose}
						type="button"
					>
						<X size={14} />
					</button>
				)}
			</div>
		</header>
	);
}
