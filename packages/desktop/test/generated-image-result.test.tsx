import type { GeneratedImageView } from "@metis/app-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GeneratedImageResult } from "../src/renderer/components/GeneratedImageResult.tsx";

const images: GeneratedImageView[] = ["0000000000000001", "0000000000000002"].map((fileId) => ({
	fileId,
	name: `${fileId}.png`,
	mediaType: "image/png",
	byteLength: 100,
	deliveredAt: "2026-11-05T00:00:00Z",
	availability: "available",
}));

describe("generated image result", () => {
	it.each(["generating", "completed"] as const)(
		"lays out all provider images when %s returns more than requested",
		(status) => {
			const html = renderToStaticMarkup(
				<GeneratedImageResult
					sessionId="11111111-1111-4111-8111-111111111111"
					running={status === "generating"}
					result={{
						type: "tool_result",
						toolCallId: "image-call",
						name: "image_generate",
						isError: false,
						output: "",
						imageGeneration: { status, requestedCount: 1, images },
					}}
				/>,
			);
			expect(html).toContain('data-count="2"');
			expect(html.match(/class="generated-image-tile"/g)).toHaveLength(2);
			expect(html).not.toContain('class="generated-image-placeholder"');
			expect(html).not.toContain("generated-image-caption");
		},
	);
});
