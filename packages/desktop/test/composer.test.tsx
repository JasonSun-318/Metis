// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/components/Composer.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

afterEach(() => document.body.replaceChildren());

function type(editor: HTMLElement, value: string) {
	const tokens = [...editor.querySelectorAll<HTMLElement>(".composer-skill-token")];
	const text = value ? document.createTextNode(value) : null;
	editor.replaceChildren(...tokens, ...(text ? [text] : []));
	if (text) {
		const range = document.createRange();
		range.selectNodeContents(text);
		range.collapse(false);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}
	editor.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const onSubmit = overrides.onSubmit ?? vi.fn(async () => undefined);
	await act(async () =>
		root.render(
			<Composer
				disabled={false}
				onInterrupt={async () => undefined}
				running={false}
				{...overrides}
				onSubmit={onSubmit}
			/>,
		),
	);
	return {
		container,
		root,
		form: container.querySelector<HTMLFormElement>("form")!,
		editor: container.querySelector<HTMLElement>("#composer-input")!,
		onSubmit,
	};
}

async function pickFiles(container: HTMLElement) {
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add files or photos"]')!.click());
	await act(async () => Promise.resolve());
}

function pickerAttachments(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		path: `/tmp/file-${index + 1}.pdf`,
		name: `file-${index + 1}.pdf`,
	}));
}

function droppedFiles(count: number) {
	return Array.from(
		{ length: count },
		(_, index) => new File(["x"], `file-${index + 1}.pdf`, { type: "application/pdf" }),
	);
}

function droppedAttachment(file: File) {
	return { path: `/tmp/${file.name}`, name: file.name };
}

function overflowWarning(container: HTMLElement) {
	return container.querySelector<HTMLElement>('.system-notice[data-tone="warning"]');
}

describe("Composer slash commands", () => {
	it("preserves line breaks from Chromium block markup", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSubmit = vi.fn(async () => undefined);
		await act(async () =>
			root.render(
				<Composer disabled={false} onInterrupt={async () => undefined} onSubmit={onSubmit} running={false} />,
			),
		);
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		editor.innerHTML = "<div>first line</div><div>second<br>continued</div><p>third line</p>";
		await act(async () => editor.dispatchEvent(new Event("input", { bubbles: true })));
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "first line\nsecond\ncontinued\nthird line",
			}),
		);
		await act(async () => root.unmount());
	});

	it("inserts multiline clipboard text without browser-generated block nodes", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSubmit = vi.fn(async () => undefined);
		await act(async () =>
			root.render(
				<Composer disabled={false} onInterrupt={async () => undefined} onSubmit={onSubmit} running={false} />,
			),
		);
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		const range = document.createRange();
		range.selectNodeContents(editor);
		range.collapse(false);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { files: [], getData: (type: string) => (type === "text/plain" ? "alpha\nbeta\ngamma" : "") },
		});
		await act(async () => editor.dispatchEvent(paste));

		expect(paste.defaultPrevented).toBe(true);
		expect(editor.querySelector("div, p")).toBeNull();
		expect(editor.textContent).toBe("alpha\nbeta\ngamma");
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: "alpha\nbeta\ngamma" }));
		await act(async () => root.unmount());
	});

	it("executes a selected built-in without sending it to the model", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSlashCommand = vi.fn();
		const onSubmit = vi.fn(async () => undefined);
		await act(async () =>
			root.render(
				<Composer
					disabled={false}
					onInterrupt={async () => undefined}
					onSlashCommand={onSlashCommand}
					onSubmit={onSubmit}
					running={false}
				/>,
			),
		);
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "/com"));
		expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(onSlashCommand).toHaveBeenCalledWith("compact");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.textContent).toBe("");
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
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "/skill:codebase-design"));
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((option) => option.querySelector("strong")?.textContent === "skill:codebase-design")!
				.click(),
		);
		expect(container.querySelector(".composer-input-line .composer-skill-token")?.textContent).toContain(
			"codebase-design",
		);
		await act(async () => type(editor, "review this"));
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: "review this",
				skill: expect.objectContaining({ name: "codebase-design" }),
			}),
		);

		await act(async () => type(editor, "/unknown"));
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
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "/skill:codebase-design"));
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((option) => option.querySelector("strong")?.textContent === "skill:codebase-design")!
				.click(),
		);
		expect(container.querySelector(".composer-skill-token")).not.toBeNull();

		await act(async () => type(editor, "review this"));
		await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" })));
		expect(container.querySelector(".composer-skill-token")).not.toBeNull();

		await act(async () => type(editor, ""));
		await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" })));
		expect(container.querySelector(".composer-skill-token")).toBeNull();
		await act(async () => root.unmount());
	});

	it("inserts a Skill selected from the add menu at the current text position", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSubmit = vi.fn(async () => undefined);
		await act(async () =>
			root.render(
				<Composer
					disabled={false}
					onInterrupt={async () => undefined}
					onSubmit={onSubmit}
					running={false}
					skills={[{ name: "codebase-design", description: "Design deep modules" }]}
				/>,
			),
		);
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "Plan carefully"));

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
				.find((item) => item.textContent?.trim() === "Skills")!
				.click(),
		);
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
				.find((item) => item.textContent?.trim() === "codebase-design")!
				.click(),
		);

		expect(container.querySelector(".composer-skill-token")).not.toBeNull();
		expect(container.querySelector(".composer-skill-token")?.textContent).toContain("codebase-design");

		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Plan carefully",
				skill: expect.objectContaining({ name: "codebase-design" }),
			}),
		);
		await act(async () => root.unmount());
	});

	it("inserts a Goal token when /goal is selected and submits goal command", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onGoalCommand = vi.fn(async () => undefined);
		await act(async () =>
			root.render(
				<Composer
					disabled={false}
					onGoalCommand={onGoalCommand}
					onInterrupt={async () => undefined}
					onSubmit={async () => undefined}
					running={false}
				/>,
			),
		);
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "/goal"));
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((option) => option.querySelector("strong")?.textContent === "/goal")!
				.click(),
		);
		await act(async () => type(editor, "Build desktop features"));
		expect(container.querySelector(".composer-goal-token")).not.toBeNull();

		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onGoalCommand).toHaveBeenCalledWith({
			kind: "set",
			objective: "Build desktop features",
		});
		await act(async () => root.unmount());
	});

	it("prefills once, replaces an untouched template, and preserves an edited draft", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSubmit = vi.fn(async () => undefined);
		const render = (id: number, text: string) =>
			root.render(
				<Composer
					disabled={false}
					running={false}
					onInterrupt={async () => undefined}
					onSubmit={onSubmit}
					prefillRequest={{ id, text }}
				/>,
			);
		await act(async () => render(1, "Prepare a report"));
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		expect(editor.textContent).toBe("Prepare a report");
		expect(document.activeElement).toBe(editor);
		await act(async () => render(1, "Prepare a report"));
		expect(editor.textContent).toBe("Prepare a report");
		await act(async () => render(2, "Create slides"));
		expect(editor.textContent).toBe("Create slides");
		await act(async () => type(editor, "My existing notes"));
		await act(async () => render(3, "Analyze a table"));
		expect(editor.textContent).toBe("My existing notes\n\nAnalyze a table");
		expect(onSubmit).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("keeps a goal chip and its text while appending a starter", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = {
			disabled: false,
			running: false,
			onInterrupt: async () => undefined,
			onSubmit: vi.fn(async () => undefined),
		};
		await act(async () => root.render(<Composer {...props} />));
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "/goal"));
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((option) => option.querySelector("strong")?.textContent === "/goal")!
				.click(),
		);
		await act(async () => type(editor, "Keep original goal"));
		const goal = editor.querySelector('[data-token-kind="goal"]');
		await act(async () =>
			root.render(<Composer {...props} prefillRequest={{ id: 1, text: "Add a report outline" }} />),
		);
		expect(editor.querySelector('[data-token-kind="goal"]')).toBe(goal);
		expect(editor.textContent).toContain("Keep original goal");
		expect(editor.textContent).toContain("Add a report outline");
		expect(props.onSubmit).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("submits a prefilled prompt with the existing attachment", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const attachment = { path: "/tmp/report.pdf", name: "report.pdf" };
		const onSubmit = vi.fn(async () => undefined);
		const props = {
			disabled: false,
			running: false,
			onInterrupt: async () => undefined,
			onSubmit,
			onPickFiles: async () => [attachment],
		};
		await act(async () => root.render(<Composer {...props} />));
		const form = container.querySelector<HTMLFormElement>("form")!;
		const file = new File(["report"], "report.pdf", { type: "application/pdf" });
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
		await act(async () => root.render(<Composer {...props} onResolveDroppedFiles={() => [attachment]} />));
		await act(async () => form.dispatchEvent(drop));
		await act(async () =>
			root.render(
				<Composer
					{...props}
					onResolveDroppedFiles={() => [attachment]}
					prefillRequest={{ id: 1, text: "Summarize this report" }}
				/>,
			),
		);
		await act(async () => form.requestSubmit());
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Summarize this report",
				attachments: [expect.objectContaining(attachment)],
			}),
		);
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
		await act(async () =>
			root.render(
				<Composer
					disabled={false}
					onInterrupt={async () => undefined}
					onPickFiles={onPickFiles}
					onSubmit={async () => undefined}
					running={false}
				/>,
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add files or photos"]')!.click());
		await act(async () => Promise.resolve());

		expect(container.querySelector('.composer-image-preview img[alt="photo.png"]')).not.toBeNull();
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("report.pdf");
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("PDF");
		expect(container.querySelector(".composer-file-card .file-kind-icon.is-pdf")).not.toBeNull();

		await act(async () =>
			container.querySelector<HTMLButtonElement>('[aria-label="Remove file photo.png"]')!.click(),
		);
		expect(container.querySelector('.composer-image-preview img[alt="photo.png"]')).toBeNull();
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("report.pdf");
		await act(async () => root.unmount());
	});
});

describe("Composer attachment merging", () => {
	it("keeps 16 picker attachments and shows a dismissible warning for unique overflow", async () => {
		const { container, root } = await mountComposer({ onPickFiles: async () => pickerAttachments(17) });
		await pickFiles(container);

		const names = [...container.querySelectorAll(".composer-file-card strong")].map((name) => name.textContent);
		expect(names).toEqual(pickerAttachments(16).map((attachment) => attachment.name));

		const warning = overflowWarning(container);
		expect(warning).not.toBeNull();
		expect(warning?.getAttribute("role")).toBe("alert");
		expect(warning?.textContent).toContain("Some files were not added");
		expect(warning?.textContent).toContain("Only 16 attachments can be added.");

		await act(async () => warning!.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click());
		expect(overflowWarning(container)).toBeNull();
		expect(container.querySelectorAll(".composer-file-card")).toHaveLength(16);
		await act(async () => root.unmount());
	});

	it("does not warn when a later selection only repeats accepted paths", async () => {
		const selected = pickerAttachments(16);
		const onPickFiles = vi.fn(async () => selected);
		const { container, root } = await mountComposer({ onPickFiles });
		await pickFiles(container);
		await pickFiles(container);

		expect(onPickFiles).toHaveBeenCalledTimes(2);
		expect(overflowWarning(container)).toBeNull();
		expect([...container.querySelectorAll(".composer-file-card strong")].map((name) => name.textContent)).toEqual(
			selected.map((attachment) => attachment.name),
		);
		await act(async () => root.unmount());
	});

	it("shows the same overflow warning for pasted files", async () => {
		const { container, root, editor } = await mountComposer({
			onResolveDroppedFiles: (files) => files.map(droppedAttachment),
		});
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { files: droppedFiles(17), getData: () => "" },
		});
		await act(async () => editor.dispatchEvent(paste));

		expect(paste.defaultPrevented).toBe(true);
		expect(container.querySelectorAll(".composer-file-card")).toHaveLength(16);
		expect(overflowWarning(container)?.textContent).toContain("Some files were not added");
		await act(async () => root.unmount());
	});

	it("shows the same overflow warning for dropped files", async () => {
		const { container, root, form } = await mountComposer({
			onResolveDroppedFiles: (files) => files.map(droppedAttachment),
		});
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(drop, "dataTransfer", { value: { files: droppedFiles(17) } });
		await act(async () => form.dispatchEvent(drop));

		expect(drop.defaultPrevented).toBe(true);
		expect(container.querySelectorAll(".composer-file-card")).toHaveLength(16);
		expect(overflowWarning(container)?.textContent).toContain("Some files were not added");
		await act(async () => root.unmount());
	});

	it("keeps the draft text and accepted attachments when submit fails", async () => {
		const onSubmit = vi.fn(async () => {
			throw new Error("offline");
		});
		const { container, root, editor, form } = await mountComposer({
			onPickFiles: async () => pickerAttachments(2),
			onSubmit,
		});
		await pickFiles(container);
		await act(async () => type(editor, "Keep this draft"));
		await act(async () => form.requestSubmit());

		expect(onSubmit).toHaveBeenCalledOnce();
		expect(editor.textContent).toBe("Keep this draft");
		expect(container.querySelectorAll(".composer-file-card")).toHaveLength(2);
		await act(async () => root.unmount());
	});

	it("localizes the code composer placeholder in Chinese", async () => {
		await setLocale("zh-CN");
		try {
			const { container, root } = await mountComposer();
			expect(container.querySelector("#composer-input")?.getAttribute("data-placeholder")).toBe(
				"描述任务或提出问题",
			);
			await act(async () => root.unmount());
		} finally {
			await setLocale("en");
		}
	});
});

describe("Composer context usage ring", () => {
	it("renders the ring only when a handler is provided", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onOpenContextUsage = vi.fn();
		const props = {
			disabled: false,
			onInterrupt: async () => undefined,
			onSubmit: async () => undefined,
			running: false,
		};
		await act(async () => root.render(<Composer {...props} />));
		expect(container.querySelector(".context-usage-ring")).toBeNull();
		await act(async () =>
			root.render(
				<Composer
					{...props}
					contextUsageExpanded
					contextUsagePercent={40}
					onOpenContextUsage={onOpenContextUsage}
				/>,
			),
		);
		const ring = container.querySelector<HTMLButtonElement>(".context-usage-ring");
		expect(ring).not.toBeNull();
		expect(ring?.getAttribute("aria-expanded")).toBe("true");
		await act(async () => ring?.click());
		expect(onOpenContextUsage).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});
});
