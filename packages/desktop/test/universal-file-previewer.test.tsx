// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { DeliveredFileCard } from "../src/renderer/components/DeliveredFileCard.tsx";
import { PreviewToolbar } from "../src/renderer/components/preview/PreviewToolbar.tsx";
import { UniversalFilePreviewer } from "../src/renderer/components/preview/UniversalFilePreviewer.tsx";
import { previewBytesCache } from "../src/renderer/components/preview/preview-bytes-cache.ts";
import { setLocale } from "../src/renderer/i18n.ts";

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	previewBytesCache.clear();
});

function mount(element: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => root.render(element));
	return { container, root };
}

describe("PreviewToolbar", () => {
	it("renders title, size badge, and triggers zoom and action buttons", () => {
		const onZoomIn = vi.fn();
		const onZoomOut = vi.fn();
		const onZoomReset = vi.fn();
		const onToggleInvert = vi.fn();
		const onOpenDefault = vi.fn();
		const onReveal = vi.fn();
		const onClose = vi.fn();

		const { container } = mount(
			<PreviewToolbar
				byteLength={1024 * 50}
				fileName="quarterly_report.pdf"
				isInverted={false}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
				onToggleInvert={onToggleInvert}
				onZoomIn={onZoomIn}
				onZoomOut={onZoomOut}
				onZoomReset={onZoomReset}
				showInvertToggle
				zoom={100}
			/>,
		);

		expect(container.textContent).toContain("quarterly_report.pdf");
		expect(container.textContent).toContain("50.0 KB");
		expect(container.textContent).toContain("100%");

		const buttons = container.querySelectorAll("button");
		const zoomOutBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]');
		const zoomInBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');
		const zoomResetBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Reset zoom"]');
		const invertBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Enable dark reading mode"]');
		const openDefaultBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Open in default app"]');
		const revealBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Show in folder"]');
		const closeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]');

		act(() => zoomInBtn?.click());
		expect(onZoomIn).toHaveBeenCalledTimes(1);

		act(() => zoomOutBtn?.click());
		expect(onZoomOut).toHaveBeenCalledTimes(1);

		act(() => zoomResetBtn?.click());
		expect(onZoomReset).toHaveBeenCalledTimes(1);

		act(() => invertBtn?.click());
		expect(onToggleInvert).toHaveBeenCalledTimes(1);

		act(() => openDefaultBtn?.click());
		expect(onOpenDefault).toHaveBeenCalledTimes(1);

		act(() => revealBtn?.click());
		expect(onReveal).toHaveBeenCalledTimes(1);

		act(() => closeBtn?.click());
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("DeliveredFileCard", () => {
	it("triggers onPreview when the preview button or card is clicked", () => {
		const onPreview = vi.fn();
		const onOpen = vi.fn();

		const { container } = mount(
			<DeliveredFileCard
				file={{
					fileId: "1234567890abcdef",
					name: "financial_model.xlsx",
					message: "Here is the completed model.",
				}}
				onOpen={onOpen}
				onPreview={onPreview}
			/>,
		);

		expect(container.textContent).toContain("financial_model");
		expect(container.textContent).toContain("Spreadsheet · XLSX");
		expect(container.textContent).toContain("Here is the completed model.");

		const previewBtn = container.querySelector<HTMLButtonElement>(".transcript-delivered-file-open");
		expect(previewBtn?.textContent?.trim()).toBe("Preview");

		act(() => previewBtn?.click());
		expect(onPreview).toHaveBeenCalledTimes(1);
		expect(onPreview).toHaveBeenCalledWith({
			fileId: "1234567890abcdef",
			name: "financial_model.xlsx",
			message: "Here is the completed model.",
		});
	});
});

describe("UniversalFilePreviewer", () => {
	it("does not reference legacy dark-only theme aliases", () => {
		const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");
		const previewCss = css.slice(css.indexOf("Universal File Previewer"));
		for (const token of [
			"--surface-main",
			"--surface-card",
			"--surface-nested",
			"--surface-hover",
			"--surface-inset",
			"--text-secondary",
			"--text-tertiary",
			"--accent-subtle",
			"--accent-text",
			"--accent-border",
			"--danger-text",
		]) expect(previewCss).not.toContain(token);
	});

	it("loads delivered file and renders text content", async () => {
		const readPreviewFile = vi.fn().mockResolvedValue({
			ok: true,
			name: "notes.txt",
			byteLength: 20,
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("Hello from delivered text"),
		});

		const api = {
			readPreviewFile,
			openDeliveredFile: vi.fn(),
		} as unknown as MetisDesktopApi;

		const { container } = mount(
			<UniversalFilePreviewer
				api={api}
				file={{
					source: "delivered",
					sessionId: "test-session",
					fileId: "1234567890abcdef",
					name: "notes.txt",
				}}
				onError={vi.fn()}
			/>,
		);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		expect(container.textContent).toContain("Hello from delivered text");
	});

	it("loads markdown workspace file and renders formatted markdown", async () => {
		const readPreviewFile = vi.fn().mockResolvedValue({
			ok: true,
			name: "README.md",
			byteLength: 42,
			mediaType: "text/markdown",
			bytes: new TextEncoder().encode("# Title\n\nThis is a test description."),
		});

		const api = {
			readPreviewFile,
			openWorkspaceFile: vi.fn(),
		} as unknown as MetisDesktopApi;

		const { container } = mount(
			<UniversalFilePreviewer
				api={api}
				file={{
					source: "workspace",
					sessionId: "test-session",
					relativePath: "README.md",
					name: "README.md",
				}}
				onError={vi.fn()}
			/>,
		);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		expect(container.textContent).toContain("Title");
		expect(container.textContent).toContain("This is a test description.");
	});

	it("does not fetch while inactive and fetches once when activated", async () => {
		const readPreviewFile = vi.fn().mockResolvedValue({
			ok: true,
			name: "notes.txt",
			byteLength: 5,
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("hello"),
		});
		const api = { readPreviewFile, openDeliveredFile: vi.fn() } as unknown as MetisDesktopApi;
		const file = {
			source: "delivered" as const,
			sessionId: "11111111-1111-4111-8111-111111111111",
			fileId: "aaaaaaaaaaaaaaaa",
			name: "notes.txt",
		};
		const { container, root } = mount(
			<UniversalFilePreviewer active={false} api={api} file={file} onError={vi.fn()} />,
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(readPreviewFile).not.toHaveBeenCalled();
		await act(async () => {
			root.render(<UniversalFilePreviewer active api={api} file={file} onError={vi.fn()} />);
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(readPreviewFile).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("hello");
	});

	it("renders images from a data URL", async () => {
		const readPreviewFile = vi.fn().mockResolvedValue({
			ok: true,
			name: "photo.png",
			byteLength: 4,
			mediaType: "image/png",
			bytes: new Uint8Array([137, 80, 78, 71]),
		});
		const api = { readPreviewFile, openDeliveredFile: vi.fn() } as unknown as MetisDesktopApi;
		const { container } = mount(
			<UniversalFilePreviewer
				active
				api={api}
				file={{
					source: "delivered",
					sessionId: "session-1",
					fileId: "aaaaaaaaaaaaaaaa",
					name: "photo.png",
				}}
				onError={vi.fn()}
			/>,
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		const image = container.querySelector("img.file-image");
		expect(image?.getAttribute("src")?.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("renders svg and pretty-prints json", async () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
		const json = new TextEncoder().encode('{"ok":true}');
		const readPreviewFile = vi.fn().mockImplementation(async (input: { readonly relativePath?: string }) => {
			if (input.relativePath === "icon.svg") {
				return { ok: true, name: "icon.svg", byteLength: svg.byteLength, mediaType: "image/svg+xml", bytes: svg };
			}
			return { ok: true, name: "data.json", byteLength: json.byteLength, mediaType: "application/json", bytes: json };
		});
		const api = { readPreviewFile, openWorkspaceFile: vi.fn() } as unknown as MetisDesktopApi;
		const { container, root } = mount(
			<UniversalFilePreviewer
				active
				api={api}
				file={{
					source: "workspace",
					sessionId: "session-1",
					relativePath: "icon.svg",
					name: "icon.svg",
				}}
				onError={vi.fn()}
			/>,
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(container.querySelector("img.file-image")?.getAttribute("src")?.startsWith("data:image/svg+xml;base64,")).toBe(
			true,
		);
		await act(async () => {
			root.render(
				<UniversalFilePreviewer
					active
					api={api}
					file={{
						source: "workspace",
						sessionId: "session-1",
						relativePath: "data.json",
						name: "data.json",
					}}
					onError={vi.fn()}
				/>,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(container.querySelector("pre.preview-plain-text")?.textContent).toContain('"ok": true');
	});

	it("tells the user legacy Office files cannot be previewed", async () => {
		const api = {
			readPreviewFile: vi.fn(),
			openDeliveredFile: vi.fn(),
		} as unknown as MetisDesktopApi;
		const { container } = mount(
			<UniversalFilePreviewer
				active
				api={api}
				file={{
					source: "delivered",
					sessionId: "11111111-1111-4111-8111-111111111111",
					fileId: "aaaaaaaaaaaaaaaa",
					name: "legacy.ppt",
				}}
				onError={vi.fn()}
			/>,
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(api.readPreviewFile).not.toHaveBeenCalled();
		expect(container.textContent).toMatch(/cannot be previewed/i);
	});
});
