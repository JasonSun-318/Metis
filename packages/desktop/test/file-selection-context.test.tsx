// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Composer, type ComposerSubmission } from "../src/renderer/components/Composer.tsx";
import { FileSelectionProvider, useFileSelections } from "../src/renderer/components/preview/FileSelectionContext.tsx";
import type { DraftFileSelection } from "../src/renderer/components/preview/file-selection.ts";
import { composerPayload, composerRequestKey } from "../src/renderer/composer-submission.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const selection: DraftFileSelection = {
	id: "first",
	sessionId: "one",
	name: "notes.md",
	input: {
		source: "workspace",
		relativePath: "notes.md",
		basis: "markdown",
		selectedText: "selected",
		startLine: 3,
		endLine: 3,
	},
};
it("stages references per session, preserves drafts on failure, and routes change requests", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const submit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
	let actions!: NonNullable<ReturnType<typeof useFileSelections>>;
	function Capture() {
		actions = useFileSelections()!;
		return (
			<>
				<div data-composer="one">
					<Composer
						disabled={false}
						inputId="composer-one"
						running={false}
						selectionSessionId="one"
						onInterrupt={async () => {}}
						onSubmit={vi.fn()}
					/>
				</div>
				<div data-composer="two">
					<Composer
						disabled={false}
						inputId="composer-two"
						running={false}
						selectionSessionId="two"
						onInterrupt={async () => {}}
						onSubmit={vi.fn()}
					/>
				</div>
			</>
		);
	}
	const render = (enabled: boolean) =>
		root.render(
			<FileSelectionProvider enabled={enabled} onSubmit={submit}>
				<Capture />
			</FileSelectionProvider>,
		);
	try {
		await act(async () => render(true));
		const other = {
			...selection,
			id: "second",
			sessionId: "two",
			name: "code.ts",
			input: { ...selection.input, relativePath: "code.ts" },
		};
		act(() => {
			actions.add(selection);
			actions.add(selection);
			actions.add(other);
		});
		expect(actions.selections).toHaveLength(2);
		const chips = (session: string) =>
			node.querySelector(`[data-composer="${session}"] .composer-selection-list`)?.textContent ?? "";
		expect(chips("one")).toContain("notes.md");
		expect(chips("one")).not.toContain("code.ts");
		expect(chips("two")).toContain("code.ts");
		expect(chips("two")).not.toContain("notes.md");
		const editor = node.querySelector<HTMLElement>("#composer-one")!;
		act(() => {
			editor.textContent = "unsent chat draft";
			editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await expect(act(async () => actions.requestChange(selection, "shorter"))).rejects.toThrow("offline");
		expect(actions.selections).toHaveLength(2);
		expect(editor.textContent).toBe("unsent chat draft");
		await act(async () => actions.requestChange(selection, "shorter"));
		expect(submit.mock.lastCall?.[0]).toBe("one");
		expect(submit.mock.lastCall?.[1]).toMatchObject({ fileSelections: [selection.input], attachments: [] });
		expect(editor.textContent).toBe("unsent chat draft");
		await act(async () => actions.requestChange(other, "longer"));
		expect(submit.mock.lastCall?.[0]).toBe("two");
		act(() => actions.remove(["second"]));
		expect(actions.selections.map((item) => item.id)).toEqual(["first"]);
		expect(chips("two")).toBe("");
		await act(async () => render(false));
		expect(() => actions.add(selection)).toThrow();
		await expect(actions.requestChange(selection, "old task")).rejects.toThrow();
		const stale = actions;
		await act(async () => root.unmount());
		expect(() => stale.add(selection)).toThrow();
		await expect(stale.requestChange(selection, "old task")).rejects.toThrow();
	} finally {
		node.remove();
	}
});
it("includes file context in the payload and mutation identity", () => {
	const input = { text: "edit", attachments: [], fileSelections: [selection.input] };
	expect(composerPayload(input).fileSelections).toEqual([selection.input]);
	expect(composerRequestKey(input)).not.toBe(
		composerRequestKey({ ...input, fileSelections: [{ ...selection.input, selectedText: "different" }] }),
	);
});

it("clears only the submitted reference snapshot after the composer is accepted", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	let accept!: () => void;
	const pending = new Promise<void>((resolve) => {
		accept = resolve;
	});
	const submit = vi.fn<(input: ComposerSubmission) => Promise<void>>(() => pending);
	let actions!: NonNullable<ReturnType<typeof useFileSelections>>;
	function Capture() {
		actions = useFileSelections()!;
		return <Composer disabled={false} running={false} onInterrupt={async () => {}} onSubmit={submit} />;
	}
	try {
		await act(async () =>
			root.render(
				<FileSelectionProvider enabled onSubmit={vi.fn()}>
					<Capture />
				</FileSelectionProvider>,
			),
		);
		act(() => actions.add(selection));
		const editor = node.querySelector<HTMLElement>("#composer-input")!;
		act(() => {
			editor.textContent = "edit first";
			editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		act(() => editor.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		expect(submit).toHaveBeenCalledOnce();
		expect(submit.mock.calls[0]?.[0]).toMatchObject({ fileSelections: [selection.input] });
		act(() =>
			actions.add({ ...selection, id: "new", input: { ...selection.input, selectedText: "another section" } }),
		);
		await act(async () => accept());
		expect(actions.selections.map((item) => item.id)).toEqual(["new"]);
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
});
