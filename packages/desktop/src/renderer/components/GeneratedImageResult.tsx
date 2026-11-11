import type { GeneratedImageView } from "@metis/app-protocol";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	ArrowLeft,
	ArrowRight,
	ArrowsOut,
	DownloadSimple,
	FolderOpen,
	ImageSquare,
	Minus,
	Plus,
	X,
} from "../icons.tsx";
import { useConversationScope } from "./ConversationScope.tsx";
import { ImageGenerationContext } from "./ImageGenerationContext.tsx";
import type { ToolCallBlock, ToolResultBlock } from "./transcript-turn-model.ts";
import "../styles/generated-images.css";
import { iconSize } from "../ui/icon-size.ts";

/** Input previews can be incomplete while the model streams tool arguments. */
function generationInput(call?: ToolCallBlock): { count?: number; aspect_ratio?: string; prompt?: string } {
	try {
		const input: unknown = JSON.parse(call?.inputPreview ?? "{}");
		if (!input || typeof input !== "object") return {};
		const value = input as Record<string, unknown>;
		return {
			count: typeof value.count === "number" ? Math.max(1, Math.min(4, Math.trunc(value.count))) : undefined,
			aspect_ratio: typeof value.aspect_ratio === "string" ? value.aspect_ratio : undefined,
			prompt: typeof value.prompt === "string" ? value.prompt : undefined,
		};
	} catch {
		return {};
	}
}

function imageAspectRatio(image?: GeneratedImageView, value?: string): number {
	const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value ?? "");
	const ratio =
		image?.width && image.height ? image.width / image.height : match ? Number(match[1]) / Number(match[2]) : 1;
	return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

async function thumbnail(blob: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(blob);
	try {
		const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Generated image unavailable");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(value) => (value ? resolve(value) : reject(new Error("Generated image unavailable"))),
				"image/webp",
				0.86,
			),
		);
	} finally {
		bitmap.close();
	}
}

function useImageSource(sessionId: string, image: GeneratedImageView, active: boolean, small: boolean) {
	const api = useContext(ImageGenerationContext)?.api;
	const { rootSessionId } = useConversationScope();
	const sourceKey = `${sessionId}:${rootSessionId ?? ""}:${image.fileId}:${small}`;
	const [state, setState] = useState<{ key?: string; src?: string; error?: string }>({});
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies(attempt): Retrying starts a fresh read and decode even though the file identity is unchanged.
	useEffect(() => {
		let disposed = false;
		let objectUrl: string | undefined;
		setState({});
		if (!active) return;
		if (!api) {
			setState({ key: sourceKey, error: "Generated image unavailable" });
			return;
		}
		if (image.availability !== "available") {
			setState({ key: sourceKey, error: "Generated image unavailable" });
			return;
		}
		// IPC or Chromium's async image conversion can remain unsettled after a
		// background/renderer interruption. A retry must start a fresh attempt;
		// late completion from the abandoned attempt cannot replace its result.
		const timeout = window.setTimeout(() => {
			disposed = true;
			setState({ key: sourceKey, error: "Image loading timed out" });
		}, 30_000);
		void Promise.resolve()
			.then(() =>
				api.readPreviewFile({
					source: "delivered",
					sessionId,
					fileId: image.fileId,
					...(rootSessionId ? { rootSessionId } : {}),
				}),
			)
			.then(async (file) => {
				if (disposed) return;
				if (!file.ok)
					throw new Error(
						file.reason === "too-large" ? "Image is too large to preview" : "Generated image unavailable",
					);
				const blob = new Blob([new Uint8Array(file.bytes)], { type: image.mediaType });
				const display = small ? await thumbnail(blob) : blob;
				if (disposed) return;
				objectUrl = URL.createObjectURL(display);
				window.clearTimeout(timeout);
				setState({ key: sourceKey, src: objectUrl });
			})
			.catch((error: unknown) => {
				window.clearTimeout(timeout);
				if (!disposed)
					setState({
						key: sourceKey,
						error: error instanceof Error ? error.message : "Generated image unavailable",
					});
			});
		return () => {
			disposed = true;
			window.clearTimeout(timeout);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [
		api,
		sessionId,
		rootSessionId,
		image.fileId,
		image.availability,
		image.mediaType,
		active,
		small,
		sourceKey,
		attempt,
	]);
	return {
		...(active && state.key === sourceKey ? state : {}),
		retry: () => setAttempt((value) => value + 1),
		fail: () => setState({ key: sourceKey, error: "Generated image unavailable" }),
	};
}

function ImageThumbnail({
	image,
	sessionId,
	aspectRatio,
	onOpen,
}: {
	readonly image: GeneratedImageView;
	readonly sessionId: string;
	readonly aspectRatio?: string;
	readonly onOpen: () => void;
}) {
	const { t } = useTranslation();
	const ref = useRef<HTMLButtonElement>(null);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		// Release thumbnails outside the conversation viewport; full image bytes are never retained here.
		// One delivery can contain several visibility changes for this tile.
		// Using the first entry can leave a visible tile permanently marked offscreen.
		const observer = new IntersectionObserver((entries) => setVisible(Boolean(entries.at(-1)?.isIntersecting)), {
			rootMargin: "240px",
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	const { src, error, retry, fail } = useImageSource(sessionId, image, visible, true);
	return (
		<div className="generated-image-item">
			<button
				ref={ref}
				className={`generated-image-tile${error ? " has-error" : ""}`}
				type="button"
				style={{ aspectRatio: imageAspectRatio(image, aspectRatio) }}
				onClick={onOpen}
				aria-label={t("View generated image {{name}}", { name: image.name })}
			>
				{src ? (
					<img src={src} alt={image.name} decoding="async" onError={fail} />
				) : (
					<span className="generated-image-preview-state">
						<ImageSquare size={iconSize.xl} aria-hidden="true" />
						<span>{t(error ?? "Loading image")}</span>
					</span>
				)}
				{src && (
					<span className="generated-image-expand">
						<ArrowsOut size={iconSize.lg} aria-hidden="true" />
					</span>
				)}
			</button>
			{error && (
				<button className="generated-image-retry" type="button" onClick={retry}>
					{t("Retry")}
				</button>
			)}
		</div>
	);
}

function GeneratedImageDialog({
	images,
	sessionId,
	initialIndex,
	prompt,
	onClose,
}: {
	readonly images: readonly GeneratedImageView[];
	readonly sessionId: string;
	readonly initialIndex: number;
	readonly prompt?: string;
	readonly onClose: () => void;
}) {
	const { t } = useTranslation();
	const actions = useContext(ImageGenerationContext);
	const dialog = useRef<HTMLDialogElement>(null);
	const [index, setIndex] = useState(initialIndex);
	const [zoom, setZoom] = useState(100);
	const [actionError, setActionError] = useState<string>();
	const image = images[index]!;
	const { src, error, retry, fail } = useImageSource(sessionId, image, true, false);
	useEffect(() => {
		const node = dialog.current;
		if (!node) return;
		node.showModal();
		return () => node.close();
	}, []);
	const close = () => {
		dialog.current?.close();
		onClose();
	};
	const navigate = (next: number) => {
		setIndex((next + images.length) % images.length);
		setZoom(100);
		setActionError(undefined);
	};
	return createPortal(
		<dialog
			ref={dialog}
			className="generated-image-dialog"
			aria-label={t("Generated image viewer")}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onKeyDown={(event) => {
				if (event.key === "ArrowRight") {
					event.preventDefault();
					navigate(index + 1);
				}
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					navigate(index - 1);
				}
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="generated-image-dialog-shell">
				<header className="generated-image-toolbar">
					<span className="generated-image-filename" title={image.name}>
						{image.name}
					</span>
					<div className="generated-image-controls">
						<button
							type="button"
							onClick={() => setZoom((value) => Math.max(50, value - 25))}
							disabled={zoom <= 50}
							aria-label={t("Zoom out")}
							title={t("Zoom out")}
						>
							<Minus size={iconSize.lg} />
						</button>
						<button type="button" onClick={() => setZoom(100)} aria-label={t("Fit image")} title={t("Fit image")}>
							{zoom}%
						</button>
						<button
							type="button"
							onClick={() => setZoom((value) => Math.min(300, value + 25))}
							disabled={zoom >= 300}
							aria-label={t("Zoom in")}
							title={t("Zoom in")}
						>
							<Plus size={iconSize.lg} />
						</button>
						{src && (
							<a href={src} download={image.name} aria-label={t("Save image")} title={t("Save image")}>
								<DownloadSimple size={iconSize.xl} />
							</a>
						)}
						{actions?.onReveal && (
							<button
								type="button"
								onClick={() => {
									void Promise.resolve(actions.onReveal!(sessionId, image.fileId)).catch((cause: unknown) =>
										setActionError(cause instanceof Error ? cause.message : t("Could not reveal image")),
									);
								}}
								aria-label={t("Reveal in folder")}
								title={t("Reveal in folder")}
							>
								<FolderOpen size={iconSize.xl} />
							</button>
						)}
						<button
							type="button"
							onClick={close}
							aria-label={t("Close image viewer")}
							title={t("Close image viewer")}
						>
							<X size={iconSize.xl} />
						</button>
					</div>
				</header>
				<div className="generated-image-viewport">
					{src ? (
						<img src={src} alt={image.name} onError={fail} style={{ width: `${zoom}%`, height: `${zoom}%` }} />
					) : (
						<output>
							{t(error ?? "Loading image")}
							{error && (
								<button className="generated-image-retry" type="button" onClick={retry}>
									{t("Retry")}
								</button>
							)}
						</output>
					)}
				</div>
				<footer className="generated-image-footer">
					<div className="generated-image-controls">
						{images.length > 1 && (
							<>
								<button type="button" onClick={() => navigate(index - 1)} aria-label={t("Previous image")}>
									<ArrowLeft size={iconSize.xl} />
								</button>
								<span>
									{index + 1} / {images.length}
								</span>
								<button type="button" onClick={() => navigate(index + 1)} aria-label={t("Next image")}>
									<ArrowRight size={iconSize.xl} />
								</button>
							</>
						)}
					</div>
					{actions?.onEdit && image.availability === "available" && (
						<button
							className="generated-image-edit"
							type="button"
							onClick={() => {
								close();
								actions.onEdit!(sessionId, image, prompt);
							}}
						>
							{t("Continue editing image")}
						</button>
					)}
				</footer>
				{actionError && (
					<p className="generated-image-action-error" role="alert">
						{actionError}
					</p>
				)}
			</div>
		</dialog>,
		document.body,
	);
}

export function GeneratedImageResult({
	call,
	result,
	sessionId,
	running,
}: {
	readonly call?: ToolCallBlock;
	readonly result?: ToolResultBlock;
	readonly sessionId: string;
	readonly running: boolean;
}) {
	const { t } = useTranslation();
	const actions = useContext(ImageGenerationContext);
	const [viewing, setViewing] = useState<number | null>(null);
	const input = generationInput(call);
	const generation = result?.imageGeneration;
	const reportedStatus =
		generation?.status ??
		(result?.isError
			? "failed"
			: result
				? "completed"
				: call?.state === "interrupted" || !running
					? "cancelled"
					: "generating");
	const status = reportedStatus === "generating" && !running ? "cancelled" : reportedStatus;
	const images = generation?.images ?? [];
	const count = generation?.requestedCount ?? input.count ?? 1;
	const displayCount = Math.max(count, images.length);
	const aspectRatio = generation?.aspectRatio ?? input.aspect_ratio;
	const generating = status === "generating";
	const columns = displayCount > 1 ? 2 : 1;
	const failure = status === "failed" || status === "unconfigured" || status === "cancelled" || status === "partial";
	const failureLabel =
		status === "cancelled"
			? "Image generation cancelled"
			: status === "unconfigured"
				? "Image model not configured"
				: status === "partial"
					? "Some images could not be generated"
					: "Image generation failed";
	return (
		<section className="generated-images" data-generation-status={status} aria-label={t("Image generation")}>
			{(generating || images.length > 0) && (
				<div
					className="generated-image-grid"
					data-count={displayCount}
					aria-busy={generating}
					style={
						generating
							? undefined
							: {
									maxWidth: Math.min(
										560,
										420 * imageAspectRatio(images[0], aspectRatio) * columns + (columns - 1) * 10,
									),
								}
					}
				>
					{images.map((image, index) => (
						<ImageThumbnail
							key={image.fileId}
							image={image}
							sessionId={sessionId}
							aspectRatio={aspectRatio}
							onOpen={() => setViewing(index)}
						/>
					))}
					{generating &&
						Array.from({ length: Math.max(0, count - images.length) }, (_, index) => (
							<div key={`pending-${index + images.length}`} className="generated-image-placeholder">
								<span className="generated-image-placeholder-glow" />
								<ImageSquare size={iconSize.xl} aria-hidden="true" />
								<span>{t("Creating your image")}</span>
							</div>
						))}
				</div>
			)}
			{failure && (
				<div className="generated-image-caption is-error" role="alert">
					<span>{t(failureLabel)}</span>
					{status === "unconfigured" && actions?.onConfigure && (
						<button type="button" onClick={actions.onConfigure}>
							{t("Configure image model")}
						</button>
					)}
				</div>
			)}
			{failure && (generation?.message || result?.output) && (
				<p className="generated-image-error">{generation?.message || result?.output}</p>
			)}
			{viewing !== null && images[viewing] && (
				<GeneratedImageDialog
					images={images}
					initialIndex={viewing}
					sessionId={sessionId}
					prompt={input.prompt}
					onClose={() => setViewing(null)}
				/>
			)}
		</section>
	);
}
