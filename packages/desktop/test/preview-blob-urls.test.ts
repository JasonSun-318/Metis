// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { materializePreviewBlobUrls } from "../src/renderer/components/preview/preview-blob-urls.ts";

describe("materializePreviewBlobUrls", () => {
	const urls: string[] = [];
	afterEach(() => {
		for (const url of urls.splice(0, urls.length)) URL.revokeObjectURL(url);
	});

	it("rewrites blob image sources to data URLs so CSP can display them", async () => {
		const url = URL.createObjectURL(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
		urls.push(url);
		const img = document.createElement("img");
		img.src = url;
		document.body.append(img);
		await materializePreviewBlobUrls(document.body);
		expect(img.src.startsWith("data:image/png")).toBe(true);
		img.remove();
	});
});
