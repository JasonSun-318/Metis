import { lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { DialogFrame } from "./DialogFrame.tsx";
import { type MarkdownDocumentState, useMarkdownDocument } from "./MarkdownDocumentContext.tsx";
import { selectMarkdownFragment } from "./markdown-fragments.ts";
import type { MarkdownReference } from "./markdown-references.ts";
import {
	embeddedMediaType,
	type MarkdownResource,
	markdownSourceKey,
	readMarkdownResource,
	resolveMarkdownResource,
} from "./markdown-resources.ts";
import { ImageViewer } from "./preview/ImageViewer.tsx";
import { decodePreviewText } from "./preview/preview-bytes.ts";

export type RenderEmbeddedNote = (text: string, state: MarkdownDocumentState) => ReactNode;

const InlinePdfPreview = lazy(() =>
	import("./preview/InlinePdfPreview.tsx").then((module) => ({ default: module.InlinePdfPreview })),
);
const PdfViewer = lazy(() => import("./preview/PdfViewer.tsx").then((module) => ({ default: module.PdfViewer })));

interface LoadedEmbed {
	readonly resource: MarkdownResource;
	readonly bytes: Uint8Array;
	readonly content?: string;
	readonly state: MarkdownDocumentState;
}

export function pdfEmbedPage(fragment?: string): number {
	if (!fragment) return 1;
	const match = /^page=([1-9]\d*)$/u.exec(fragment);
	if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid PDF page number");
	return Number(match[1]);
}

function ResourcePreview({
	loaded,
	onClose,
	renderNote,
}: {
	readonly loaded: LoadedEmbed;
	readonly onClose: () => void;
	readonly renderNote: RenderEmbeddedNote;
}) {
	const { t } = useTranslation();
	const close = useRef<HTMLButtonElement>(null);
	const id = useId();
	const { resource, bytes, state } = loaded;
	return createPortal(
		<DialogFrame
			cancellable
			className="markdown-resource-dialog"
			descriptionId={`${id}-description`}
			initialFocus={close}
			onCancel={onClose}
			titleId={`${id}-title`}
		>
			<header className="markdown-resource-dialog-header">
				<strong id={`${id}-title`}>{resource.path}</strong>
				<span id={`${id}-description`} className="visually-hidden">
					{t("Resource preview")}
				</span>
				<button ref={close} type="button" onClick={onClose}>
					{t("Close")}
				</button>
			</header>
			{resource.kind === "pdf" ? (
				<Suspense fallback={<span>{t("Loading…")}</span>}>
					<PdfViewer bytes={bytes} fileName={resource.path} initialPage={pdfEmbedPage(resource.fragment)} />
				</Suspense>
			) : resource.kind === "image" ? (
				<ImageViewer bytes={bytes} fileName={resource.path} mediaType={resource.mediaType} />
			) : (
				<article className="markdown-resource-document turn-answer">
					{renderNote(selectMarkdownFragment(decodePreviewText(bytes)), {
						document: state.document,
						trail: [markdownSourceKey(resource.owner)],
						budget: { entries: new Map() },
					})}
				</article>
			)}
		</DialogFrame>,
		document.body,
	);
}

export function MarkdownEmbed({
	reference,
	renderNote,
	embed = true,
}: {
	readonly reference: MarkdownReference;
	readonly renderNote: RenderEmbeddedNote;
	readonly embed?: boolean;
}) {
	const { t } = useTranslation();
	const context = useMarkdownDocument();
	const document = context?.document;
	const id = useId();
	const host = useRef<HTMLDivElement>(null);
	const [nearby, setNearby] = useState(typeof IntersectionObserver === "undefined");
	const [requested, setRequested] = useState(0);
	const [loaded, setLoaded] = useState<LoadedEmbed>();
	const [error, setError] = useState("");
	const [open, setOpen] = useState(false);
	const [imageUrl, setImageUrl] = useState("");
	const [imageError, setImageError] = useState(false);
	const previousEpoch = useRef(context?.epoch);
	const { reference: target, kind, label, width, height } = reference;

	useEffect(() => {
		if (!embed || !host.current || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setNearby(true);
				observer.disconnect();
			},
			{ rootMargin: "240px" },
		);
		observer.observe(host.current);
		return () => observer.disconnect();
	}, [embed]);

	useEffect(() => {
		setImageError(false);
		if (!loaded || loaded.resource.kind !== "image") return;
		const url = URL.createObjectURL(new Blob([Uint8Array.from(loaded.bytes)], { type: loaded.resource.mediaType }));
		setImageUrl(url);
		return () => {
			URL.revokeObjectURL(url);
			setImageUrl("");
		};
	}, [loaded]);

	useEffect(() => {
		if (previousEpoch.current !== context?.epoch) setLoaded(undefined);
		previousEpoch.current = context?.epoch;
		setError("");
		setOpen(false);
		if (!context || !(embed ? nearby : requested)) return;
		const { budget, trail } = context;
		const displayEmbed = embed && !requested;
		let cancelled = false;
		if (displayEmbed && (trail.length > 3 || budget.entries.size >= 32)) {
			setError(t("Embed limit reached. Open the original document to continue."));
			return;
		}
		if (displayEmbed) budget.entries.set(id, 0);
		void (async () => {
			const resource = await resolveMarkdownResource(context.document, { reference: target, kind, label });
			if (cancelled) return;
			if (!displayEmbed && resource.kind === "note" && context.document.onOpenNote) {
				context.document.onOpenNote(resource.path, resource.fragment);
				return;
			}
			const key = `${markdownSourceKey(resource.owner)}#${resource.fragment ?? ""}`;
			if (
				displayEmbed &&
				(trail.includes(key) || (!resource.fragment && trail.includes(markdownSourceKey(resource.owner))))
			)
				throw new Error("Circular note embed. Open the original document to continue.");
			if (resource.kind === "pdf") pdfEmbedPage(resource.fragment);
			const bytes = await readMarkdownResource(context.document, resource);
			if (cancelled) return;
			let content: string | undefined;
			if (resource.kind === "note") {
				if (displayEmbed) {
					const total = [...budget.entries.values()].reduce((sum, value) => sum + value, 0);
					if (total + bytes.byteLength > 1024 * 1024)
						throw new Error("Embedded notes exceed the 1 MiB reading limit");
					budget.entries.set(id, bytes.byteLength);
				}
				content = selectMarkdownFragment(decodePreviewText(bytes), displayEmbed ? resource.fragment : undefined);
			}
			const value: LoadedEmbed = {
				resource: { ...resource, mediaType: embeddedMediaType(bytes) ?? resource.mediaType },
				bytes,
				content,
				state: {
					document: { ...context.document, owner: resource.owner, revision: resource.revision },
					trail: [...trail, key],
					budget,
					epoch: context.epoch,
				},
			};
			setLoaded(value);
			if (!displayEmbed) {
				if (resource.kind === "note" && context.document.onOpenNote)
					context.document.onOpenNote(resource.path, resource.fragment);
				else setOpen(true);
			}
		})().catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => {
			cancelled = true;
			budget.entries.delete(id);
		};
	}, [context, embed, nearby, requested, target, kind, label, id, t]);

	const openOriginal = () => {
		if (!loaded) {
			setRequested((value) => value + 1);
			return;
		}
		if (loaded.resource.kind === "note" && document?.onOpenNote)
			document.onOpenNote(loaded.resource.path, loaded.resource.fragment);
		else setOpen(true);
	};
	if (!context)
		return embed && kind === "wiki" ? (
			<span className="markdown-resource-unavailable">{`![[${target}]]`}</span>
		) : (
			<a className={embed ? "markdown-image-link" : undefined} href={target.startsWith("#") ? target : undefined}>
				{embed ? t("[Image: {{name}}]", { name: label || t("image") }) : label}
			</a>
		);
	if (!embed)
		return (
			<>
				<a
					href={`#${encodeURIComponent(target)}`}
					onClick={(event) => {
						event.preventDefault();
						if (loaded) openOriginal();
						else setRequested((value) => value + 1);
					}}
				>
					{label}
				</a>
				{error && (
					<span className="markdown-embed-error" role="alert">
						{t(error)}
					</span>
				)}
				{open && loaded && (
					<ResourcePreview loaded={loaded} onClose={() => setOpen(false)} renderNote={renderNote} />
				)}
			</>
		);
	return (
		<div
			ref={host}
			className={`markdown-embed${loaded?.resource.kind === "image" ? " markdown-image-embed" : ""}`}
			data-markdown-embed="true"
		>
			{loaded?.resource.kind !== "image" && (
				<header className="markdown-embed-header">
					<span>{label}</span>
					<button type="button" onClick={openOriginal}>
						{t("Open original")}
					</button>
				</header>
			)}
			{error ? (
				<p className="markdown-embed-error" role="alert">
					{t(error)}
				</p>
			) : !loaded ? (
				<span className="status-paragraph">{t("Loading…")}</span>
			) : loaded.resource.kind === "note" ? (
				renderNote(loaded.content ?? "", loaded.state)
			) : loaded.resource.kind === "pdf" ? (
				<Suspense fallback={<span>{t("Loading…")}</span>}>
					<InlinePdfPreview
						bytes={loaded.bytes}
						fileName={loaded.resource.path}
						page={pdfEmbedPage(loaded.resource.fragment)}
						onOpen={openOriginal}
					/>
				</Suspense>
			) : imageError ? (
				<span className="markdown-embed-error" role="alert">
					{t("File could not be opened")}
				</span>
			) : (
				imageUrl && (
					<button
						type="button"
						className="markdown-image-button"
						onClick={openOriginal}
						aria-label={t("Open original")}
					>
						<img
							src={imageUrl}
							alt={label}
							width={width}
							height={height}
							style={height ? { maxHeight: height } : undefined}
							onError={() => setImageError(true)}
							onLoad={(event) => {
								const image = event.currentTarget;
								if (image.naturalWidth * image.naturalHeight > 40_000_000) setImageError(true);
							}}
						/>
					</button>
				)
			)}
			{open && loaded && <ResourcePreview loaded={loaded} onClose={() => setOpen(false)} renderNote={renderNote} />}
		</div>
	);
}
