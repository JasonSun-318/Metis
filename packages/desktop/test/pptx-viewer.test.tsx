// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const destroy = vi.fn();
const setZoom = vi.fn().mockResolvedValue(undefined);
const goToSlide = vi.fn().mockResolvedValue(undefined);
const open = vi.fn().mockResolvedValue({
	destroy,
	setZoom,
	goToSlide,
	slideWidth: 960,
	slideHeight: 540,
	slideCount: 5,
	currentSlideIndex: 0,
});
vi.mock("@aiden0z/pptx-renderer", () => ({
	RECOMMENDED_ZIP_LIMITS: { maxTotalSize: 1, maxFileSize: 1, maxEntryCount: 1 },
	PptxViewer: { open: (...args: unknown[]) => open(...args) },
}));

describe("PptxViewer", () => {
	it("opens the deck from bytes with windowed rendering and destroys on unmount", async () => {
		const { PptxViewer } = await import("../src/renderer/components/preview/PptxViewer.tsx");
		const bytes = new Uint8Array([0x50, 0x4b]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<PptxViewer bytes={bytes} byteLength={2} fileName="a.pptx" onOpenDefault={() => {}} onReveal={() => {}} />,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(open).toHaveBeenCalled();
		const [buffer, host, options] = open.mock.calls[0]!;
		expect(buffer).toBeInstanceOf(ArrayBuffer);
		expect(host).toBeInstanceOf(HTMLElement);
		expect(options).toEqual(expect.objectContaining({ listOptions: expect.objectContaining({ windowed: true }) }));
		await act(async () => {
			root.unmount();
		});
		expect(destroy).toHaveBeenCalled();
	}, 15000);
});
