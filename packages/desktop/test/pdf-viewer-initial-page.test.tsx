// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const numPages = 4;

function makeDoc() {
	return {
		numPages,
		getPage: async () => ({
			getViewport: ({ scale }: { scale: number }) => ({ width: 960 * scale, height: 540 * scale }),
			streamTextContent: () => ({}),
			render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
		}),
		destroy,
	};
}

describe("PdfViewer initialPage", () => {
	let root: Root;
	let container: HTMLElement;
	let PdfViewer: typeof import("../src/renderer/components/preview/PdfViewer.tsx")["PdfViewer"];

	beforeEach(async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
		getDocument.mockReset();
		destroy.mockReset();
		getDocument.mockReturnValue({ promise: Promise.resolve(makeDoc()), destroy });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		({ PdfViewer } = await import("../src/renderer/components/preview/PdfViewer.tsx"));
	});
	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	async function renderViewer(initialPage?: number) {
		await act(async () => {
			root.render(
				<PdfViewer bytes={new Uint8Array([1, 2])} byteLength={2} fileName="a.pdf" initialPage={initialPage} />,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("defaults to page 1 without initialPage", async () => {
		await renderViewer();
		expect(container.querySelector(".preview-page-info")?.textContent).toBe(`1 / ${numPages}`);
		expect(container.querySelectorAll(".pdf-page-wrapper")).toHaveLength(numPages);
	});

	it("selects the requested page once the document loads", async () => {
		await renderViewer(3);
		expect(container.querySelector(".preview-page-info")?.textContent).toBe(`3 / ${numPages}`);
	});

	it("clamps out-of-range initialPage to the last page", async () => {
		await renderViewer(99);
		expect(container.querySelector(".preview-page-info")?.textContent).toBe(`${numPages} / ${numPages}`);
	});

	it("page controls navigate away from the initial page", async () => {
		await renderViewer(2);
		const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!;
		await act(async () => {
			next.click();
		});
		expect(container.querySelector(".preview-page-info")?.textContent).toBe(`3 / ${numPages}`);
	});
});
