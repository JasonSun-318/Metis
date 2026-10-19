// @vitest-environment jsdom

import { act, createRef, type ReactElement, type RefObject, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMenuDismiss } from "../src/renderer/hooks/use-menu-dismiss.ts";

interface HarnessProps {
	readonly close: (restoreFocus?: boolean) => void;
	readonly label: string;
	readonly open: boolean;
	readonly rootRef?: RefObject<HTMLDivElement | null>;
}

function Harness({ close, label, open, rootRef }: HarnessProps) {
	const localRef = useRef<HTMLDivElement>(null);
	const ref = rootRef ?? localRef;
	useMenuDismiss(open, ref, close);
	return <div data-testid={label} ref={ref} />;
}

let roots: Root[];

const mount = (container: HTMLElement) => {
	const root = createRoot(container);
	roots.push(root);
	return root;
};

const render = (root: Root, ui: ReactElement) => act(async () => root.render(ui));

const pointerDown = (target: EventTarget) => target.dispatchEvent(new Event("pointerdown", { bubbles: true }));

const pressEscape = (target: EventTarget) => {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });
	target.dispatchEvent(event);
	return event;
};

const appendOutside = () => {
	const outside = document.createElement("div");
	document.body.append(outside);
	return outside;
};

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	roots = [];
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	document.body.replaceChildren();
});

describe("useMenuDismiss", () => {
	it("listens only while open and removes the exact listeners on cleanup", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = mount(container);
		const close = vi.fn();
		const renderHarness = (open: boolean) => render(root, <Harness close={close} label="menu" open={open} />);

		await renderHarness(false);
		pointerDown(appendOutside());
		pressEscape(document);
		expect(close).not.toHaveBeenCalled();

		await renderHarness(true);
		const menu = container.querySelector<HTMLDivElement>('[data-testid="menu"]')!;
		pointerDown(menu);
		expect(close).not.toHaveBeenCalled();
		pointerDown(appendOutside());
		expect(close).toHaveBeenCalledOnce();
		expect(close).toHaveBeenLastCalledWith();

		const escapeEvent = pressEscape(document);
		expect(escapeEvent.defaultPrevented).toBe(true);
		expect(close).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenLastCalledWith(true);

		await renderHarness(false);
		pointerDown(appendOutside());
		pressEscape(document);
		expect(close).toHaveBeenCalledTimes(2);

		await renderHarness(true);
		await act(async () => root.unmount());
		roots = roots.filter((candidate) => candidate !== root);
		pointerDown(appendOutside());
		pressEscape(document);
		expect(close).toHaveBeenCalledTimes(2);
	});

	it("uses the latest close callback after an update", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = mount(container);
		const first = vi.fn();
		const latest = vi.fn();

		await render(root, <Harness close={first} label="menu" open />);
		await render(root, <Harness close={latest} label="menu" open />);

		pressEscape(container);
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenLastCalledWith(true);

		pointerDown(appendOutside());
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledTimes(2);
		expect(latest).toHaveBeenLastCalledWith();
	});

	it("reads the current root ref when handling an event", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = mount(container);
		const close = vi.fn();
		const rootRef = createRef<HTMLDivElement>();
		const replacement = document.createElement("div");
		document.body.append(replacement);

		await render(root, <Harness close={close} label="menu" open rootRef={rootRef} />);
		const menu = container.querySelector<HTMLDivElement>('[data-testid="menu"]')!;

		pointerDown(menu);
		expect(close).not.toHaveBeenCalled();

		rootRef.current = replacement;
		pointerDown(menu);
		expect(close).toHaveBeenCalledOnce();

		rootRef.current = menu;
		pointerDown(menu);
		expect(close).toHaveBeenCalledOnce();
	});

	it("keeps open instances independent", async () => {
		const firstContainer = document.createElement("div");
		const secondContainer = document.createElement("div");
		document.body.append(firstContainer, secondContainer);
		const firstRoot = mount(firstContainer);
		const secondRoot = mount(secondContainer);
		const firstClose = vi.fn();
		const secondClose = vi.fn();

		await render(firstRoot, <Harness close={firstClose} label="first" open />);
		await render(secondRoot, <Harness close={secondClose} label="second" open />);

		pointerDown(appendOutside());
		expect(firstClose).toHaveBeenCalledOnce();
		expect(secondClose).toHaveBeenCalledOnce();

		await act(async () => firstRoot.unmount());
		roots = roots.filter((candidate) => candidate !== firstRoot);

		pointerDown(appendOutside());
		pressEscape(document);
		expect(firstClose).toHaveBeenCalledOnce();
		expect(secondClose).toHaveBeenCalledTimes(3);

		await act(async () => secondRoot.unmount());
		roots = roots.filter((candidate) => candidate !== secondRoot);
		pointerDown(appendOutside());
		pressEscape(document);
		expect(secondClose).toHaveBeenCalledTimes(3);
	});
});
