// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HtmlViewer } from "../src/renderer/components/preview/HtmlViewer.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const HTML = [
	"<!doctype html><html><head><title>Artifact</title></head>",
	'<body><h1>Hello artifact</h1><script>document.title = "ran";</script></body></html>',
].join("");
const bytes = new TextEncoder().encode(HTML);

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	document.documentElement.dataset.theme = "dark";
});

async function mount(element: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(element));
	return { container, root };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

describe("HtmlViewer", () => {
	it("renders model HTML in a script-only sandbox", async () => {
		const { container } = await mount(<HtmlViewer bytes={bytes} fileName="artifact.html" />);
		const frame = container.querySelector<HTMLIFrameElement>("iframe.preview-html-frame");
		expect(frame).not.toBeNull();
		expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
		expect(frame?.getAttribute("srcdoc") ?? "").toContain("<h1>Hello artifact</h1>");
		expect(frame?.getAttribute("srcdoc") ?? "").toContain("metis-preview-theme");
	});

	it("switches between rendered output and source", async () => {
		const { container } = await mount(<HtmlViewer bytes={bytes} fileName="artifact.html" />);
		await act(async () => button(container, "Source code").click());
		const source = container.querySelector("pre.preview-html-source");
		expect(source?.textContent).toContain("Hello artifact");
		expect(container.querySelector("iframe.preview-html-frame")).toBeNull();
		await act(async () => button(container, "Rendered").click());
		expect(container.querySelector("iframe.preview-html-frame")).not.toBeNull();
	});

	it("offers open-in-default-app and reveal actions", async () => {
		const { container } = await mount(
			<HtmlViewer
				bytes={bytes}
				fileName="artifact.html"
				onOpenDefault={() => undefined}
				onReveal={() => undefined}
			/>,
		);
		expect(container.querySelector('button[aria-label="Open in default app"]')).not.toBeNull();
		expect(container.querySelector('button[aria-label="Show in folder"]')).not.toBeNull();
	});
});
