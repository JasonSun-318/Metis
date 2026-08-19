// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
const destroy = vi.fn();

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	getDocument: (...args: unknown[]) => getDocument(...args),
	TextLayer: class {
		render() {
			return Promise.resolve();
		}
		cancel() {}
	},
}));

vi.mock("../src/renderer/components/preview/pdf-assets.ts", () => ({
	pdfWorkerSrc: () => "app://renderer/pdf.worker.min.mjs",
	pdfCMapUrl: () => "app://renderer/pdfjs/cmaps/",
	pdfStandardFontDataUrl: () => "app://renderer/pdfjs/standard_fonts/",
}));

describe("PdfViewer", () => {
	beforeEach(() => {
		getDocument.mockReset();
		destroy.mockReset();
		getDocument.mockReturnValue({
			promise: Promise.resolve({
				numPages: 2,
				getPage: async () => ({
					getViewport: () => ({
						width: 100,
						height: 140,
						clone() {
							return this;
						},
					}),
					streamTextContent: () => ({}),
					render: () => ({ promise: Promise.resolve() }),
				}),
				destroy,
			}),
		});
	});

	it("opens the document from raw bytes and destroys it on unmount", async () => {
		const { PdfViewer } = await import("../src/renderer/components/preview/PdfViewer.tsx");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await act(async () => {
			root.render(
				<PdfViewer bytes={bytes} byteLength={4} fileName="a.pdf" onOpenDefault={() => {}} onReveal={() => {}} />,
			);
			await Promise.resolve();
		});
		expect(getDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				data: bytes,
				cMapPacked: true,
				cMapUrl: "app://renderer/pdfjs/cmaps/",
				standardFontDataUrl: "app://renderer/pdfjs/standard_fonts/",
			}),
		);
		await act(async () => {
			root.unmount();
		});
		expect(destroy).toHaveBeenCalled();
	});
});
