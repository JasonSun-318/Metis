// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const renderAsync = vi.fn().mockResolvedValue(undefined);
vi.mock("docx-preview", () => ({ renderAsync: (...args: unknown[]) => renderAsync(...args) }));

describe("DocxViewer", () => {
	it("renders from an ArrayBuffer without atob", async () => {
		const { DocxViewer } = await import("../src/renderer/components/preview/DocxViewer.tsx");
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<DocxViewer bytes={bytes} byteLength={4} fileName="a.docx" onOpenDefault={() => {}} onReveal={() => {}} />,
			);
			await Promise.resolve();
		});
		expect(renderAsync).toHaveBeenCalled();
		const [buffer, host, , options] = renderAsync.mock.calls[0]!;
		expect(buffer).toBeInstanceOf(ArrayBuffer);
		expect(host).toBeInstanceOf(HTMLElement);
		expect(options).toMatchObject({ useBase64URL: false });
	});
});
