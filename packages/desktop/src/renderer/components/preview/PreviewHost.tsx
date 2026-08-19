import { File, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopPreviewFileInput, MetisDesktopApi } from "../../../shared/desktop-api.ts";
import { Markdown } from "../Markdown.tsx";
import { DocxViewer } from "./DocxViewer.tsx";
import { ExcelViewer } from "./ExcelViewer.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { PptxViewer } from "./PptxViewer.tsx";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import { previewBytesCache, previewCacheKey } from "./preview-bytes-cache.ts";
import { classifyPreviewKind, fileExtension } from "./preview-kinds.ts";

export interface UniversalPreviewTarget {
	readonly source: "delivered" | "workspace";
	readonly sessionId: string;
	readonly fileId?: string;
	readonly relativePath?: string;
	readonly name: string;
	readonly byteLength?: number;
}

export interface PreviewHostProps {
	readonly file: UniversalPreviewTarget;
	readonly api: MetisDesktopApi;
	readonly active: boolean;
	readonly onClose?: () => void;
	readonly onError: (cause: unknown) => void;
}

interface LoadedPreview {
	readonly name: string;
	readonly byteLength: number;
	readonly mediaType: string;
	readonly bytes: Uint8Array;
}

function previewInput(file: UniversalPreviewTarget): DesktopPreviewFileInput | null {
	if (file.source === "delivered" && file.fileId) {
		return { source: "delivered", sessionId: file.sessionId, fileId: file.fileId };
	}
	if (file.source === "workspace" && file.relativePath) {
		return { source: "workspace", sessionId: file.sessionId, relativePath: file.relativePath };
	}
	return null;
}

function PreviewShell({
	byteLength,
	children,
	fileName,
	onClose,
	onOpenDefault,
	onReveal,
}: {
	readonly byteLength?: number;
	readonly children: ReactNode;
	readonly fileName: string;
	readonly onClose?: () => void;
	readonly onOpenDefault: () => void;
	readonly onReveal: () => void;
}) {
	return (
		<div className="universal-previewer preview-status-container">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			{children}
		</div>
	);
}

export function PreviewHost({ file, api, active, onClose, onError }: PreviewHostProps) {
	const { t } = useTranslation();
	const kind = classifyPreviewKind(file.name);
	const [data, setData] = useState<LoadedPreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useMemo(() => previewInput(file), [file]);

	const handleOpenDefault = () => {
		if (file.source === "delivered" && file.fileId) {
			void api.openDeliveredFile({ sessionId: file.sessionId, fileId: file.fileId, action: "default" }).catch(onError);
		} else if (file.source === "workspace" && file.relativePath) {
			void api
				.openWorkspaceFile({ sessionId: file.sessionId, relativePath: file.relativePath, action: "default" })
				.catch(onError);
		}
	};

	const handleReveal = () => {
		if (file.source === "delivered" && file.fileId) {
			void api.openDeliveredFile({ sessionId: file.sessionId, fileId: file.fileId, action: "reveal" }).catch(onError);
		} else if (file.source === "workspace" && file.relativePath) {
			void api
				.openWorkspaceFile({ sessionId: file.sessionId, relativePath: file.relativePath, action: "reveal" })
				.catch(onError);
		}
	};

	useEffect(() => {
		if (!active || kind === "unsupported") {
			setLoading(false);
			setError(null);
			if (!active) setData(null);
			return;
		}
		if (!input) {
			setLoading(false);
			setError(t("Failed to load file"));
			return;
		}
		const key = previewCacheKey(input);
		const cached = previewBytesCache.get(key);
		if (cached) {
			setData({
				name: file.name,
				byteLength: cached.byteLength,
				mediaType: "application/octet-stream",
				bytes: cached,
			});
			setLoading(false);
			setError(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		setData(null);
		void api.readPreviewFile(input).then(
			(result) => {
				if (cancelled) return;
				if (!result.ok) {
					setData(null);
					setError(
						result.reason === "too-large" ? t("File is too large to preview") : t("File could not be opened"),
					);
					setLoading(false);
					return;
				}
				previewBytesCache.set(key, result.bytes);
				setData({
					name: result.name || file.name,
					byteLength: result.byteLength,
					mediaType: result.mediaType,
					bytes: result.bytes,
				});
				setLoading(false);
			},
			(cause) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : t("Failed to load file"));
				setLoading(false);
				onError(cause);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [active, api, file.name, input, kind, onError, t]);

	if (!active) {
		return <div className="universal-previewer preview-inactive" hidden />;
	}

	if (kind === "unsupported") {
		return (
			<PreviewShell fileName={file.name} onClose={onClose} onOpenDefault={handleOpenDefault} onReveal={handleReveal}>
				<div className="preview-empty-state">
					<File aria-hidden="true" size={32} />
					<strong>{t("This file format cannot be previewed")}</strong>
					<span>{t("Open it in the default app to inspect it")}</span>
				</div>
			</PreviewShell>
		);
	}

	if (loading) {
		return (
			<PreviewShell fileName={file.name} onClose={onClose} onOpenDefault={handleOpenDefault} onReveal={handleReveal}>
				<div className="preview-loading-state">
					<SpinnerGap aria-hidden="true" className="is-spinning" size={32} />
					<span>{t("Opening file…")}</span>
				</div>
			</PreviewShell>
		);
	}

	if (error || !data) {
		return (
			<PreviewShell fileName={file.name} onClose={onClose} onOpenDefault={handleOpenDefault} onReveal={handleReveal}>
				<div className="preview-error-state">
					<File aria-hidden="true" size={36} />
					<strong>{t("File could not be opened")}</strong>
					<span>{error}</span>
				</div>
			</PreviewShell>
		);
	}

	const viewerProps = {
		byteLength: data.byteLength,
		bytes: data.bytes,
		fileName: data.name,
		onClose,
		onOpenDefault: handleOpenDefault,
		onReveal: handleReveal,
	};

	if (kind === "pdf") return <PdfViewer {...viewerProps} />;
	if (kind === "docx") return <DocxViewer {...viewerProps} />;
	if (kind === "pptx") return <PptxViewer {...viewerProps} />;
	if (kind === "xlsx" || kind === "csv") return <ExcelViewer {...viewerProps} />;
	if (kind === "image") {
		return <ImagePreview mediaType={imageMediaType(data.name, data.mediaType)} {...viewerProps} />;
	}
	if (kind === "markdown" || kind === "text") {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
		return (
			<div className="universal-previewer text-previewer">
				<PreviewToolbar
					byteLength={data.byteLength}
					fileName={data.name}
					onClose={onClose}
					onOpenDefault={handleOpenDefault}
					onReveal={handleReveal}
				/>
				<div className="preview-viewport text-viewport code-turn-answer">
					{kind === "markdown" ? (
						<article className="file-markdown">
							<Markdown text={text} />
						</article>
					) : (
						<pre className="preview-plain-text">{text}</pre>
					)}
				</div>
			</div>
		);
	}

	return (
		<PreviewShell
			byteLength={data.byteLength}
			fileName={data.name}
			onClose={onClose}
			onOpenDefault={handleOpenDefault}
			onReveal={handleReveal}
		>
			<div className="preview-empty-state">
				<File aria-hidden="true" size={32} />
				<strong>{t("This file format cannot be previewed")}</strong>
				<span>{t("Open it in the default app to inspect it")}</span>
			</div>
		</PreviewShell>
	);
}

function ImagePreview({
	byteLength,
	bytes,
	fileName,
	mediaType,
	onClose,
	onOpenDefault,
	onReveal,
}: {
	readonly byteLength: number;
	readonly bytes: Uint8Array;
	readonly fileName: string;
	readonly mediaType: string;
	readonly onClose?: () => void;
	readonly onOpenDefault: () => void;
	readonly onReveal: () => void;
}) {
	const [src, setSrc] = useState<string | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(
			new Blob([Uint8Array.from(bytes).buffer], {
				type: mediaType || "application/octet-stream",
			}),
		);
		setSrc(url);
		return () => {
			URL.revokeObjectURL(url);
		};
	}, [bytes, mediaType]);
	return (
		<div className="universal-previewer image-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			<div className="preview-viewport image-viewport">
				{src ? <img alt={fileName} className="preview-image-element" src={src} /> : null}
			</div>
		</div>
	);
}

function imageMediaType(fileName: string, mediaType: string): string {
	if (mediaType && mediaType !== "application/octet-stream") return mediaType;
	const ext = fileExtension(fileName);
	if (ext === "svg") return "image/svg+xml";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "png" || ext === "gif" || ext === "webp") return `image/${ext}`;
	return mediaType || "application/octet-stream";
}

export type { PreviewKind } from "./preview-kinds.ts";
