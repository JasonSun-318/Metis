// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { DialogFrame } from "../src/renderer/components/DialogFrame.tsx";
import { DialogFrame as LegacyDialogFrame } from "../src/renderer/components/ProjectActions.tsx";
import type { UniversalPreviewTarget as LegacyPreviewTarget } from "../src/renderer/components/preview/PreviewHost.tsx";
import type { UniversalPreviewTarget } from "../src/renderer/components/preview/preview-kinds.ts";
import type { UniversalPreviewTarget as LegacyUniversalPreviewTarget } from "../src/renderer/components/preview/UniversalFilePreviewer.tsx";
import type { ProjectSessionGroup as LegacyProjectSessionGroup } from "../src/renderer/components/SessionSidebar.tsx";
import type { ProjectSessionGroup } from "../src/renderer/session-groups.ts";

const roots: Root[] = [];

interface FixtureProps {
	readonly cancellable: boolean;
	readonly expandedMenu: boolean;
	readonly onCancel: () => void;
}

function Fixture({ cancellable, expandedMenu, onCancel }: FixtureProps) {
	const initialFocus = useRef<HTMLButtonElement>(null);
	return (
		<DialogFrame
			cancellable={cancellable}
			descriptionId="description"
			initialFocus={initialFocus}
			onCancel={onCancel}
			titleId="title"
		>
			<h2 id="title">Edit item</h2>
			<p id="description">Change the name.</p>
			<button aria-label="Name" ref={initialFocus} type="button">
				Rename
			</button>
			<button aria-expanded={expandedMenu} aria-haspopup="menu" type="button">
				Options
			</button>
			<button type="button">Confirm</button>
			<button hidden type="button">
				Hidden action
			</button>
		</DialogFrame>
	);
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onCancel = vi.fn();
	const render = async (props: Partial<FixtureProps> = {}) => {
		await act(async () => root.render(<Fixture cancellable expandedMenu={false} onCancel={onCancel} {...props} />));
	};
	await render();
	return { container, render, onCancel, root };
}

function press(target: Element, key: string, shiftKey = false): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
	act(() => target.dispatchEvent(event));
	return event;
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
});

describe("DialogFrame", () => {
	it("restores the opening control when the dialog unmounts", async () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		trigger.focus();
		const { root } = await mount();
		expect(document.activeElement).not.toBe(trigger);
		await act(async () => root.render(null));
		expect(document.activeElement).toBe(trigger);
	});

	it("does not handle Escape already consumed by a child", async () => {
		const { container, onCancel } = await mount();
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		event.preventDefault();
		act(() => container.querySelector("button")!.dispatchEvent(event));
		expect(onCancel).not.toHaveBeenCalled();
	});
	it("preserves the component and type exports at their previous entry points", () => {
		expect(LegacyDialogFrame).toBe(DialogFrame);
		expectTypeOf<LegacyPreviewTarget>().toEqualTypeOf<UniversalPreviewTarget>();
		expectTypeOf<LegacyUniversalPreviewTarget>().toEqualTypeOf<UniversalPreviewTarget>();
		expectTypeOf<LegacyProjectSessionGroup>().toEqualTypeOf<ProjectSessionGroup>();
	});

	it("focuses the requested control and wraps keyboard focus in both directions", async () => {
		const { container } = await mount();
		const first = container.querySelector<HTMLButtonElement>('[aria-label="Name"]')!;
		const last = container.querySelectorAll("button")[2];
		expect(document.activeElement).toBe(first);
		last.focus();
		expect(document.activeElement).toBe(last);

		expect(press(last, "Tab").defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		expect(press(first, "Tab", true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
	});

	it("uses the current cancellation callback and leaves Escape to expanded menus", async () => {
		const { container, render, onCancel } = await mount();
		const first = container.querySelector<HTMLButtonElement>('[aria-label="Name"]')!;
		await render({ expandedMenu: true });
		expect(press(first, "Escape").defaultPrevented).toBe(false);
		expect(onCancel).not.toHaveBeenCalled();
		const nextCancel = vi.fn();
		await render({ onCancel: nextCancel });
		expect(press(first, "Escape").defaultPrevented).toBe(true);
		expect(nextCancel).toHaveBeenCalledOnce();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("cancels only on the backdrop and respects non-cancellable work", async () => {
		const { container, render, onCancel } = await mount();
		const first = container.querySelector<HTMLButtonElement>('[aria-label="Name"]')!;
		const backdrop = container.querySelector(".modal-backdrop")!;
		act(() => first.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
		expect(onCancel).not.toHaveBeenCalled();
		act(() => backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
		expect(onCancel).toHaveBeenCalledOnce();
		onCancel.mockClear();
		await render({ cancellable: false });
		press(first, "Escape");
		act(() => backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
		expect(onCancel).not.toHaveBeenCalled();
	});
});
