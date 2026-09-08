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
it("stages removable references, preserves drafts on failure, and rejects stale task callbacks", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const submit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
	let actions!: NonNullable<ReturnType<typeof useFileSelections>>;
	function Capture() {
		actions = useFileSelections()!;
		return <Composer disabled={false} running={false} onInterrupt={async () => {}} onSubmit={submit} />;
	}
	const render = (sessionId: string) =>
		root.render(
			<FileSelectionProvider sessionId={sessionId} enabled onSubmit={submit}>
				<Capture key={sessionId} />
			</FileSelectionProvider>,
		);
	try {
		await act(async () => render("one"));
		act(() => {
			actions.add(selection);
			actions.add(selection);
		});
		expect(actions.selections).toHaveLength(1);
		const editor = node.querySelector<HTMLElement>("#composer-input")!;
		act(() => {
			editor.textContent = "unsent chat draft";
			editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});
		await expect(act(async () => actions.requestChange(selection, "shorter"))).rejects.toThrow("offline");
		expect(actions.selections).toHaveLength(1);
		expect(editor.textContent).toBe("unsent chat draft");
		await act(async () => actions.requestChange(selection, "shorter"));
		expect(submit.mock.lastCall?.[0]).toMatchObject({ fileSelections: [selection.input], attachments: [] });
		expect(editor.textContent).toBe("unsent chat draft");
		const stale = actions;
		await act(async () => render("two"));
		expect(actions.selections).toHaveLength(0);
		expect(() => stale.add(selection)).toThrow();
		await expect(stale.requestChange(selection, "old task")).rejects.toThrow();
		act(() => actions.add({ ...selection, id: "second", sessionId: "two" }));
		expect(actions.selections).toHaveLength(1);
		act(() => stale.remove(["second"]));
		expect(actions.selections).toHaveLength(1);
		act(() => actions.remove(["second"]));
		expect(actions.selections).toHaveLength(0);
		await act(async () => render("one"));
		act(() => actions.add(selection));
		expect(() => stale.add(selection)).toThrow();
		act(() => stale.remove(["first"]));
		expect(actions.selections).toHaveLength(1);
	} finally {
		await act(async () => root.unmount());
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
				<FileSelectionProvider sessionId="one" enabled onSubmit={submit}>
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
