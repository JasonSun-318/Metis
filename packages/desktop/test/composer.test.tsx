// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/components/Composer.tsx";

afterEach(() => document.body.replaceChildren());

function type(textarea: HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Composer slash commands", () => {
	it("executes a selected built-in without sending it to the model", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSlashCommand = vi.fn();
		const onSubmit = vi.fn(async () => undefined);
		await act(async () => root.render(
			<Composer disabled={false} onInterrupt={async () => undefined} onSlashCommand={onSlashCommand} onSubmit={onSubmit} running={false} />,
		));
		const textarea = container.querySelector("textarea")!;
		await act(async () => type(textarea, "/com"));
		expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(onSlashCommand).toHaveBeenCalledWith("compact");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(textarea.value).toBe("");
		await act(async () => root.unmount());
	});

	it("inserts a removable Skill chip and sends unknown slash text normally", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSubmit = vi.fn(async () => undefined);
		const props = {
			disabled: false,
			onInterrupt: async () => undefined,
			onSubmit,
			running: false,
			skills: [{ name: "codebase-design", description: "Design deep modules" }],
		};
		await act(async () => root.render(<Composer {...props} />));
		const textarea = container.querySelector("textarea")!;
		await act(async () => type(textarea, "/skill:code"));
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(container.querySelector(".composer-input-line .composer-skill-token")?.textContent).toContain("codebase-design");
		await act(async () => type(textarea, "review this"));
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
			text: "review this",
			skill: expect.objectContaining({ name: "codebase-design" }),
		}));

		await act(async () => type(textarea, "/unknown"));
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "/unknown" }));
		await act(async () => root.unmount());
	});

	it("removes the selected Skill with Backspace only when the message is empty", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = {
			disabled: false,
			onInterrupt: async () => undefined,
			onSubmit: async () => undefined,
			running: false,
			skills: [{ name: "codebase-design", description: "Design deep modules" }],
		};
		await act(async () => root.render(<Composer {...props} />));
		const textarea = container.querySelector("textarea")!;
		await act(async () => type(textarea, "/skill:code"));
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());

		await act(async () => type(textarea, "review this"));
		await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" })));
		expect(container.querySelector(".composer-skill-token")).not.toBeNull();

		await act(async () => type(textarea, ""));
		await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" })));
		expect(container.querySelector(".composer-skill-token")).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows image thumbnails and typed file cards above the input", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onPickFiles = async () => [
			{ path: "/tmp/photo.png", name: "photo.png", previewDataUrl: "data:image/png;base64,cHJldmlldw==" },
			{ path: "/tmp/report.pdf", name: "report.pdf" },
		];
		await act(async () => root.render(
			<Composer disabled={false} onInterrupt={async () => undefined} onPickFiles={onPickFiles} onSubmit={async () => undefined} running={false} />,
		));
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add files or photos"]')!.click());
		await act(async () => Promise.resolve());

		expect(container.querySelector('.composer-image-preview img[alt="photo.png"]')).not.toBeNull();
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("report.pdf");
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("PDF");
		expect(container.querySelector(".composer-file-card .file-kind-icon.is-pdf")).not.toBeNull();

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove file photo.png"]')!.click());
		expect(container.querySelector('.composer-image-preview img[alt="photo.png"]')).toBeNull();
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("report.pdf");
		await act(async () => root.unmount());
	});
});

describe("Composer cache hit rate", () => {
	it("renders a compact cache hit indicator only when usage is available", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = {
			disabled: false,
			onInterrupt: async () => undefined,
			onSubmit: async () => undefined,
			running: false,
		};

		await act(async () => root.render(<Composer {...props} cacheHitPercent={null} />));
		expect(container.querySelector(".composer-cache-hit")).toBeNull();
		await act(async () => root.render(<Composer {...props} cacheHitPercent={87.4} />));
		expect(container.querySelector(".composer-cache-hit")?.textContent).toBe("Cache87%");
		expect(container.querySelector(".composer-cache-hit")?.getAttribute("aria-label")).toBe("Cache hit rate 87%");
		await act(async () => root.unmount());
	});
});
