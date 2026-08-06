// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "../src/renderer/components/CodeEditor.tsx";

afterEach(() => document.body.replaceChildren());

function mountedView(container: HTMLElement): EditorView {
	const editor = container.querySelector<HTMLElement>(".cm-editor");
	const view = editor ? EditorView.findFromDOM(editor) : null;
	if (!view) throw new Error("CodeMirror editor not mounted");
	return view;
}

describe("CodeEditor", () => {
	it("reports edits, saves with Mod-S, and accepts controlled replacements", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		const onSave = vi.fn();

		await act(async () => root.render(
			<CodeEditor
				label="Edit App.tsx"
				onChange={onChange}
				onSave={onSave}
				path="src/App.tsx"
				value="export const App = 1;"
			/>,
		));
		const view = mountedView(container);
		act(() => view.dispatch({ changes: { from: 19, to: 20, insert: "2" } }));
		expect(onChange).toHaveBeenLastCalledWith("export const App = 2;");

		const save = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
		act(() => view.contentDOM.dispatchEvent(save));
		expect(save.defaultPrevented).toBe(true);
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => root.render(
			<CodeEditor
				label="Edit App.tsx"
				onChange={onChange}
				onSave={onSave}
				path="src/App.tsx"
				value="external value"
			/>,
		));
		expect(view.state.doc.toString()).toBe("external value");
		await act(async () => root.unmount());
	});

	it("loads supported languages and keeps unknown text editable", async () => {
		for (const path of ["src/App.tsx", "README.md", "notes.unknown"]) {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			await act(async () => root.render(
				<CodeEditor label={`Edit ${path}`} onChange={() => undefined} onSave={() => undefined} path={path} value="value" />,
			));
			expect(mountedView(container).state.doc.toString()).toBe("value");
			await act(async () => root.unmount());
		}
	});

	it("uses a high-contrast dark syntax palette", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<CodeEditor
				label="Edit palette.ts"
				onChange={() => undefined}
				onSave={() => undefined}
				path="palette.ts"
				value={'export const answer = "visible";'}
			/>,
		));
		const spans = [...container.querySelectorAll<HTMLElement>(".cm-line span")];
		const token = (text: string) => spans.find((span) => span.textContent === text)!;
		expect(getComputedStyle(token("export")).color).toBe("rgb(255, 123, 114)");
		expect(getComputedStyle(token('"visible"')).color).toBe("rgb(165, 214, 255)");
		await act(async () => root.unmount());
	});
});
