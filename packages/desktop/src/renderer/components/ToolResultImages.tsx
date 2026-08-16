import type { DurableImageRefView } from "@metis/app-protocol";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

function desktopApi(): MetisDesktopApi {
	return (globalThis as unknown as { metis: MetisDesktopApi }).metis;
}

export function ToolResultImages({
	sessionId,
	images,
}: {
	readonly sessionId: string;
	readonly images: readonly DurableImageRefView[];
}) {
	const { t } = useTranslation();
	const imageKey = useMemo(() => images.map((image) => image.hash).join(","), [images]);
	const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
	const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

	useEffect(() => {
		let current = true;
		const seen = new Set<string>();
		for (const image of images) {
			if (seen.has(image.hash)) continue;
			seen.add(image.hash);
			desktopApi()
				.readSessionImage({ sessionId, image })
				.then((result) => {
					if (!current) return;
					setUrls((prev) => new Map(prev).set(image.hash, `data:${result.mediaType};base64,${result.data}`));
				})
				.catch(() => {
					if (current) setFailed((prev) => new Set(prev).add(image.hash));
				});
		}
		return () => {
			current = false;
		};
	}, [sessionId, imageKey, images]);

	if (images.length === 0) return null;
	return (
		<div className="tool-result-images">
			{images.map((image, index) => {
				const url = urls.get(image.hash);
				if (failed.has(image.hash)) {
					return (
						<p className="tool-result-image-missing" key={`${image.hash}-${index}`}>
							{t("Image unavailable")}
						</p>
					);
				}
				return url ? (
					<img alt="" className="tool-result-image" key={`${image.hash}-${index}`} src={url} />
				) : (
					<span className="tool-result-image-loading" key={`${image.hash}-${index}`}>
						{t("Loading image…")}
					</span>
				);
			})}
		</div>
	);
}
