// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FileSelectionPopover } from "../src/renderer/components/preview/FileSelectionPopover.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("offers only the two requested actions and keeps a failed inline request for retry", async () => {
	await setLocale("en");
	const node = document.createElement("div");
	const text = document.createTextNode("selected");
	document.body.append(text, node);
	const range = document.createRange();
	range.selectNodeContents(text);
	const root = createRoot(node);
	const onRequestChange = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
	const onDismiss = vi.fn();
	try {
		await act(async () =>
			root.render(
				<FileSelectionPopover
					selection={{
						id: "one",
						sessionId: "session",
						name: "notes.md",
						input: { source: "workspace", relativePath: "notes.md", basis: "source", selectedText: "selected" },
					}}
					range={range}
					open
					enabled
					onAdd={vi.fn()}
					onRequestChange={onRequestChange}
					onDismiss={onDismiss}
					onAccepted={vi.fn()}
				/>,
			),
		);
		expect(Array.from(node.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
			"Request changes",
			"Add to conversation",
		]);
		act(() => node.querySelector("button")!.click());
		const input = node.querySelector("textarea")!;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "make shorter");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
		expect(onRequestChange).not.toHaveBeenCalled();
		await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(node.querySelector('[role="alert"]')?.textContent).toBe("offline");
		expect(input.value).toBe("make shorter");
		expect(onDismiss).not.toHaveBeenCalled();
		await act(async () => node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
		expect(onRequestChange).toHaveBeenCalledTimes(2);
		expect(onDismiss).toHaveBeenCalledOnce();
	} finally {
		await act(async () => root.unmount());
		node.remove();
		text.remove();
	}
});
