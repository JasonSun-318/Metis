import { describe, expect, it } from "vitest";
import {
	bytesToDataUrl,
	decodePreviewText,
	formatPreviewText,
	previewImageMediaType,
} from "../src/renderer/components/preview/preview-bytes.ts";

describe("preview-bytes", () => {
	it("encodes image bytes as a data URL for the file type", () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		expect(bytesToDataUrl(png, "image/png")).toBe("data:image/png;base64,iVBORw==");
		expect(previewImageMediaType("photo.PNG", "application/octet-stream")).toBe("image/png");
		expect(previewImageMediaType("vector.svg")).toBe("image/svg+xml");
		expect(previewImageMediaType("shot.jpeg")).toBe("image/jpeg");
		expect(previewImageMediaType("anim.gif")).toBe("image/gif");
		expect(previewImageMediaType("art.webp")).toBe("image/webp");
	});

	it("strips a UTF-8 BOM and pretty-prints JSON", () => {
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
		expect(decodePreviewText(bom)).toBe('{"a":1}');
		expect(formatPreviewText("data.json", '{"a":1}')).toBe('{\n  "a": 1\n}\n');
		expect(formatPreviewText("notes.txt", "keep")).toBe("keep");
		expect(formatPreviewText("broken.json", "{not json")).toBe("{not json");
	});
});
