// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
const destroy = vi.fn();
const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const textLayerCancel = vi.fn();

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	getDocument: (...args: unknown[]) => getDocument(...args),
	TextLayer: class {
		render() {
			return Promise.resolve();
		}
		cancel() {
			textLayerCancel();
		}
	},
}));

vi.mock("../src/renderer/components/preview/pdf-assets.ts", () => ({
	pdfWorkerSrc: () => "app://renderer/pdf.worker.min.mjs",
	pdfCMapUrl: () => "app://renderer/pdfjs/cmaps/",
	pdfStandardFontDataUrl: () => "app://renderer/pdfjs/standard_fonts/",
}));

function makeDoc(numPages: number) {
	return {
		numPages,
		getPage: vi.fn(async (_pageNumber: number) => ({
			getViewport: ({ scale }: { scale: number }) => ({
				width: 960 * scale,
				height: 540 * scale,
				clone() {
					return this;
				},
			}),
			streamTextContent: () => ({}),
			render: renderPage,
		})),
		destroy,
	};
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("InlinePdfPreview", () => {
	let root: Root;
	let container: HTMLElement;
	let InlinePdfPreview: typeof import("../src/renderer/components/preview/InlinePdfPreview.tsx")["InlinePdfPreview"];

	async function renderPreview(props: { bytes: Uint8Array; page: number; fileName?: string; onOpen?: () => void }) {
		await act(async () => {
			root.render(
				<InlinePdfPreview
					bytes={props.bytes}
					page={props.page}
					fileName={props.fileName ?? "a.pdf"}
					onOpen={props.onOpen}
				/>,
			);
		});
		await flush();
	}

	async function updatePreview(props: { bytes: Uint8Array; page: number; fileName?: string }) {
		await act(async () => {
			root.render(<InlinePdfPreview bytes={props.bytes} page={props.page} fileName={props.fileName ?? "a.pdf"} />);
		});
		await flush();
	}

	beforeEach(async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
		getDocument.mockReset();
		destroy.mockReset();
		renderPage.mockClear();
		textLayerCancel.mockClear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		({ InlinePdfPreview } = await import("../src/renderer/components/preview/InlinePdfPreview.tsx"));
	});
	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	it("renders only the requested page, copies bytes, and destroys the document on unmount", async () => {
		getDocument.mockReturnValue({ promise: Promise.resolve(makeDoc(5)), destroy });
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await renderPreview({ bytes, page: 3 });
		expect(getDocument.mock.calls[0]![0].data.buffer).not.toBe(bytes.buffer);
		const pages = container.querySelectorAll<HTMLElement>(".pdf-page-wrapper");
		expect(pages).toHaveLength(1);
		expect(pages[0]!.dataset.page).toBe("3");
		expect(container.textContent).toContain("3 / 5");
		expect(container.querySelector(".preview-page-navigator")).toBeNull();
		expect(renderPage).toHaveBeenCalled();
		await act(async () => {
			root.unmount();
		});
		expect(destroy).toHaveBeenCalled();
	});

	it("switching bytes unloads the old page before the new document resolves", async () => {
		let resolveSecond: (doc: unknown) => void = () => {};
		getDocument.mockReturnValueOnce({ promise: Promise.resolve(makeDoc(2)), destroy });
		getDocument.mockReturnValueOnce({
			promise: new Promise((resolve) => {
				resolveSecond = resolve;
			}),
			destroy,
		});
		await renderPreview({ bytes: new Uint8Array([1]), page: 1 });
		expect(container.querySelectorAll<HTMLElement>(".pdf-page-wrapper")).toHaveLength(1);
		await updatePreview({ bytes: new Uint8Array([2]), page: 1 });
		expect(container.querySelector<HTMLElement>(".pdf-page-wrapper")).toBeNull();
		expect(container.querySelector(".preview-loading-state")).not.toBeNull();
		await act(async () => {
			resolveSecond(makeDoc(2));
		});
		await flush();
		expect(container.querySelectorAll<HTMLElement>(".pdf-page-wrapper")).toHaveLength(1);
	});

	it("shows a clear error for out-of-range pages", async () => {
		getDocument.mockReturnValue({ promise: Promise.resolve(makeDoc(3)), destroy });
		await renderPreview({ bytes: new Uint8Array([1]), page: 4 });
		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("PDF page out of range");
		expect(alert?.textContent).toContain("4 / 3");
		expect(container.querySelector<HTMLElement>(".pdf-page-wrapper")).toBeNull();
	});

	it("shows a clear error for encrypted or corrupted documents", async () => {
		getDocument.mockReturnValue({
			promise: Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" })),
			destroy,
		});
		await renderPreview({ bytes: new Uint8Array([1]), page: 1 });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("No password given");
		await act(async () => {
			root.render(<div />);
		});
		getDocument.mockReturnValue({
			promise: Promise.reject(Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" })),
			destroy,
		});
		await renderPreview({ bytes: new Uint8Array([1]), page: 1 });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid PDF structure");
	});

	it("rerendering the same instance from page 1 to page 3 replaces the rendered page", async () => {
		const doc = makeDoc(5);
		getDocument.mockReturnValue({ promise: Promise.resolve(doc), destroy });
		await renderPreview({ bytes: new Uint8Array([1]), page: 1 });
		expect(container.querySelector<HTMLElement>(".pdf-page-wrapper")?.dataset.page).toBe("1");
		await updatePreview({ bytes: new Uint8Array([1]), page: 3 });
		const wrappers = container.querySelectorAll<HTMLElement>(".pdf-page-wrapper");
		expect(wrappers).toHaveLength(1);
		expect(wrappers[0]!.dataset.page).toBe("3");
		expect(doc.getPage).toHaveBeenLastCalledWith(3);
		expect(container.textContent).toContain("3 / 5");
	});

	it("never exposes the previous document during the first render of new bytes", async () => {
		const { usePdfDocument } = await import("../src/renderer/components/preview/use-pdf-document.ts");
		const seen: { doc: unknown; error: string | null }[] = [];
		function Probe({ bytes }: { bytes: Uint8Array }) {
			const state = usePdfDocument(bytes);
			seen.push({ doc: state.doc, error: state.error });
			return null;
		}
		getDocument.mockReturnValue({ promise: Promise.resolve(makeDoc(2)), destroy });
		const first = new Uint8Array([1]);
		await act(async () => {
			root.render(<Probe bytes={first} />);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(seen.some((entry) => entry.doc !== null)).toBe(true);
		const passesForFirst = seen.length;
		getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy });
		await act(async () => {
			root.render(<Probe bytes={new Uint8Array([2])} />);
		});
		// The first render pass of the new payload must not expose the old document.
		expect(seen[passesForFirst]!.doc).toBeNull();
		expect(seen.slice(passesForFirst).every((entry) => entry.doc === null)).toBe(true);
	});

	it("cancels in-flight page render on unmount", async () => {
		const cancelRender = vi.fn();
		getDocument.mockReturnValue({
			promise: Promise.resolve({
				numPages: 1,
				getPage: async () => ({
					getViewport: ({ scale }: { scale: number }) => ({ width: 960 * scale, height: 540 * scale }),
					streamTextContent: () => ({}),
					render: () => ({ promise: new Promise<void>(() => {}), cancel: cancelRender }),
				}),
				destroy,
			}),
			destroy,
		});
		await renderPreview({ bytes: new Uint8Array([1]), page: 1 });
		await act(async () => {
			root.unmount();
		});
		expect(cancelRender).toHaveBeenCalled();
	});
});
