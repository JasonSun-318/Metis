import { type DeliverFileDetails, parseDeliverFileDetails } from "../deliver-file.ts";

export type GeneratedImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface GeneratedImageDetails extends DeliverFileDetails {
	readonly mediaType: GeneratedImageMediaType;
	readonly width?: number;
	readonly height?: number;
	readonly continuation?: {
		readonly api: "google-interactions";
		readonly modelId: string;
		readonly baseUrl: string;
		readonly interactionId: string;
	};
}

export interface ImageGenerationDetails {
	readonly kind: "image_generation";
	readonly status: "generating" | "completed" | "partial";
	readonly requestedCount: number;
	readonly images: GeneratedImageDetails[];
	readonly aspectRatio?: string;
	readonly message?: string;
}

/** Journal metadata is an external boundary; never authorize paths from arbitrary tool details. */
export function parseImageGenerationDetails(value: unknown): ImageGenerationDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (
		raw.kind !== "image_generation" ||
		!["generating", "completed", "partial"].includes(String(raw.status)) ||
		!Number.isInteger(raw.requestedCount) ||
		(raw.requestedCount as number) < 1 ||
		(raw.requestedCount as number) > 4 ||
		!Array.isArray(raw.images) ||
		raw.images.length > 4
	)
		return undefined;
	const images: GeneratedImageDetails[] = [];
	for (const image of raw.images) {
		const file = parseDeliverFileDetails(image);
		if (!file || file.sourcePath || !["image/png", "image/jpeg", "image/webp"].includes(image.mediaType))
			return undefined;
		for (const dimension of [image.width, image.height]) {
			if (dimension !== undefined && (!Number.isInteger(dimension) || dimension < 1 || dimension > 65_535))
				return undefined;
		}
		const continuation = image.continuation;
		if (
			continuation !== undefined &&
			(!continuation ||
				continuation.api !== "google-interactions" ||
				![continuation.modelId, continuation.baseUrl, continuation.interactionId].every(
					(part) => typeof part === "string" && part.length > 0 && part.length <= 2048,
				))
		)
			return undefined;
		images.push({
			...file,
			mediaType: image.mediaType,
			...(image.width === undefined ? {} : { width: image.width }),
			...(image.height === undefined ? {} : { height: image.height }),
			...(continuation === undefined
				? {}
				: {
						continuation: {
							api: "google-interactions",
							modelId: continuation.modelId,
							baseUrl: continuation.baseUrl,
							interactionId: continuation.interactionId,
						},
					}),
		});
	}
	if (
		raw.aspectRatio !== undefined &&
		(typeof raw.aspectRatio !== "string" || !/^(auto|\d{1,2}:\d{1,2})$/.test(raw.aspectRatio))
	)
		return undefined;
	if (raw.message !== undefined && (typeof raw.message !== "string" || raw.message.length > 2048)) return undefined;
	return {
		kind: "image_generation",
		status: raw.status as ImageGenerationDetails["status"],
		requestedCount: raw.requestedCount as number,
		images,
		...(raw.aspectRatio === undefined ? {} : { aspectRatio: raw.aspectRatio as string }),
		...(raw.message === undefined ? {} : { message: raw.message as string }),
	};
}
