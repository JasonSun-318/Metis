import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopPreviewFileInput, MetisDesktopApi } from "../../../shared/desktop-api.ts";
import { File, SpinnerGap } from "../../icons.tsx";
import { DocxViewer } from "./DocxViewer.tsx";
import { ExcelViewer } from "./ExcelViewer.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { PptxViewer } from "./PptxViewer.tsx";
import { PreviewFrame } from "./PreviewFrame.tsx";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import { previewBytesCache, previewCacheKey } from "./preview-bytes-cache.ts";
import { classifyPreviewKind, type UniversalPreviewTarget } from "./preview-kinds.ts";
import { TextViewer } from "./TextViewer.tsx";

export type { UniversalPreviewTarget } from "./preview-kinds.ts";

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

function previewInput(
	file: Pick<
		UniversalPreviewTarget,
		"source" | "sessionId" | "rootSessionId" | "fileId" | "relativePath" | "libraryId" | "revision"
	>,
): DesktopPreviewFileInput | null {
	if (file.source === "knowledge" && file.libraryId && file.relativePath)
		return {
			source: "knowledge",
			libraryId: file.libraryId,
			relativePath: file.relativePath,
			revision: file.revision,
		};
	if (file.source === "delivered" && file.fileId) {
		return {
			source: "delivered",
			sessionId: file.sessionId,
			...(file.rootSessionId ? { rootSessionId: file.rootSessionId } : {}),
			fileId: file.fileId,
		};
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

export function PreviewHost(props: PreviewHostProps) {
	return (
		<PreviewFrame active={props.active}>
			<PreviewContent {...props} />
		</PreviewFrame>
	);
}

function PreviewContent({ file, api, active, onClose, onError }: PreviewHostProps) {
	const { t } = useTranslation();
	const kind = classifyPreviewKind(file.name);
	const [data, setData] = useState<LoadedPreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { source, sessionId, rootSessionId, fileId, relativePath, libraryId, revision: resourceRevision } = file;
	const input = useMemo(
		() =>
			previewInput({
				source,
				sessionId,
				rootSessionId,
				fileId,
				relativePath,
				libraryId,
				revision: resourceRevision,
			}),
		[source, sessionId, rootSessionId, fileId, relativePath, libraryId, resourceRevision],
	);
	const loadedKey = useRef<string | null>(null);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!active) return;
		return api.subscribe?.((event) => {
			if (file.source === "knowledge" && event.type === "knowledge-libraries") {
				if (file.libraryId) previewBytesCache.deleteLibrary(file.libraryId);
				setData(null);
				setRevision((value) => value + 1);
				return;
			}
			if (event.type !== "app-server" || event.envelope.method !== "connection/events") return;
			if (
				event.envelope.params.events.some(
					(event) =>
						(event.type === "turn/completed" || event.type === "turn/interrupted") &&
						event.turn.sessionId === file.sessionId,
				)
			)
				setRevision((value) => value + 1);
		});
	}, [active, api, file.sessionId, file.source, file.libraryId]);

	const handleOpenDefault = () => {
		if (file.source === "delivered" && file.fileId) {
			void api
				.openDeliveredFile({
					sessionId: file.sessionId,
					...(file.rootSessionId ? { rootSessionId: file.rootSessionId } : {}),
					fileId: file.fileId,
					action: "default",
				})
				.catch(onError);
		} else if (file.source === "workspace" && file.relativePath) {
			void api
				.openWorkspaceFile({ sessionId: file.sessionId, relativePath: file.relativePath, action: "default" })
				.catch(onError);
		}
	};

	const handleReveal = () => {
		if (file.source === "delivered" && file.fileId) {
			void api
				.openDeliveredFile({
					sessionId: file.sessionId,
					...(file.rootSessionId ? { rootSessionId: file.rootSessionId } : {}),
					fileId: file.fileId,
					action: "reveal",
				})
				.catch(onError);
		} else if (file.source === "workspace" && file.relativePath) {
			void api
				.openWorkspaceFile({ sessionId: file.sessionId, relativePath: file.relativePath, action: "reveal" })
				.catch(onError);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies(revision): Turn completion events refresh live preview bytes.
	useEffect(() => {
		if (!active || kind === "unsupported") {
			setLoading(false);
			setError(null);
			if (!active) {
				setData(null);
				loadedKey.current = null;
			}
			return;
		}
		if (!input) {
			setLoading(false);
			setError(t("Failed to load file"));
			return;
		}
		const key = previewCacheKey(input);

		let cancelled = false;
		const refreshing = loadedKey.current === key;
		setLoading(!refreshing);
		setError(null);
		if (!refreshing) setData(null);
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
				loadedKey.current = key;
				setData((previous) =>
					refreshing &&
					previous?.bytes.length === result.bytes.length &&
					previous.bytes.every((byte, index) => byte === result.bytes[index])
						? previous
						: {
								name: result.name || file.name,
								byteLength: result.byteLength,
								mediaType: result.mediaType,
								bytes: result.bytes,
							},
				);
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
	}, [active, api, file.name, input, kind, onError, t, revision]);

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
		file,
		byteLength: data.byteLength,
		bytes: data.bytes,
		fileName: data.name,
		onClose,
		onOpenDefault: handleOpenDefault,
		onReveal: handleReveal,
	};

	if (kind === "pdf") return <PdfViewer {...viewerProps} initialPage={file.initialPage} />;
	if (kind === "docx") return <DocxViewer {...viewerProps} />;
	if (kind === "pptx") return <PptxViewer {...viewerProps} />;
	if (kind === "xlsx" || kind === "csv") return <ExcelViewer {...viewerProps} />;
	if (kind === "image") return <ImageViewer mediaType={data.mediaType} {...viewerProps} />;
	if (kind === "markdown" || kind === "text")
		return <TextViewer key={JSON.stringify(input)} api={api} kind={kind} {...viewerProps} />;

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

export type { PreviewKind } from "./preview-kinds.ts";
