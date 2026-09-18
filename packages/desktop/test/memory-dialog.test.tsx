// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryDialog } from "../src/renderer/components/MemoryDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});
afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

it("opens separately, handles Escape, and restores focus to its trigger", async () => {
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<>
				<button onClick={() => setOpen(true)}>Manage</button>
				{open && (
					<MemoryDialog title="Memories" onClose={() => setOpen(false)}>
						<input aria-label="Search" />
					</MemoryDialog>
				)}
			</>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(<Harness />));
		const trigger = container.querySelector<HTMLButtonElement>("button")!;
		trigger.focus();
		await act(async () => trigger.click());
		const dialog = container.querySelector("dialog")!;
		expect(dialog.open).toBe(true);
		expect(dialog.contains(document.activeElement)).toBe(true);
		await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(container.querySelector("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	} finally {
		await act(async () => root.unmount());
	}
});

it("protects dirty edits on Escape and only discards after an explicit choice", async () => {
	const onClose = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MemoryDialog title="Edit note" dirty onClose={onClose}>
					<textarea defaultValue="unsaved text" />
				</MemoryDialog>,
			),
		);
		const dialog = container.querySelector("dialog")!;
		await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Discard unsaved changes?");
		await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector("textarea")?.value).toBe("unsaved text");
		await act(async () => container.querySelector<HTMLButtonElement>(".memory-dialog-close")!.click());
		await act(async () => container.querySelector<HTMLButtonElement>(".settings-danger-button")!.click());
		expect(onClose).toHaveBeenCalledOnce();
	} finally {
		await act(async () => root.unmount());
	}
});

it("does not dismiss while a save is pending", async () => {
	const onClose = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<MemoryDialog title="Memories" busy onClose={onClose}>
					<p>Saving</p>
				</MemoryDialog>,
			),
		);
		expect(container.querySelector<HTMLButtonElement>(".memory-dialog-close")!.disabled).toBe(true);
		await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(onClose).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
	}
});
