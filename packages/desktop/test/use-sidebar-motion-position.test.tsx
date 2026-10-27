// @vitest-environment jsdom

import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { More } from "reicon-react/icons/More";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarMotionPosition } from "../src/renderer/components/use-sidebar-motion-position.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let reactRoot: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function Anchor({ open, onPosition }: { readonly open: boolean; readonly onPosition: () => void }) {
	const anchor = useRef<HTMLButtonElement>(null);
	useSidebarMotionPosition(anchor, open, onPosition);
	return (
		<button ref={anchor} type="button">
			Actions
		</button>
	);
}

async function mount(open = true, insideSidebar = true, onPosition = vi.fn()) {
	const render = async (nextOpen: boolean) => {
		await act(async () => {
			reactRoot.render(
				<div className={insideSidebar ? "sidebar-list-motion" : "conversation-header"}>
					<Anchor open={nextOpen} onPosition={onPosition} />
				</div>,
			);
		});
	};
	await render(open);
	return { boundary: host.firstElementChild as HTMLDivElement, onPosition, render };
}

async function mutate(change: () => void) {
	await act(async () => {
		change();
		await Promise.resolve();
	});
}

async function tick(timestamp = performance.now()) {
	await act(async () => {
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(timestamp);
	});
}

function anchorRect(top: number, width = 24): DOMRect {
	return { x: 0, y: top, left: 0, right: width, top, bottom: top + 24, width, height: 24, toJSON: () => ({}) };
}

function ReiconAnchor({ onPosition }: { readonly onPosition: () => void }) {
	const anchor = useRef<HTMLButtonElement>(null);
	const [position, setPosition] = useState({ top: 0 });
	const updatePosition = useCallback(() => {
		onPosition();
		setPosition({ top: anchor.current?.getBoundingClientRect().top ?? 0 });
	}, [onPosition]);
	useSidebarMotionPosition(anchor, true, updatePosition);
	return (
		<button data-position={position.top} ref={anchor} type="button">
			<More aria-hidden="true" size={16} />
		</button>
	);
}

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	reactRoot = createRoot(host);
	frames = new Map();
	nextFrame = 0;
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameRequestCallback) => {
			const id = ++nextFrame;
			frames.set(id, callback);
			return id;
		}),
	);
	vi.stubGlobal(
		"cancelAnimationFrame",
		vi.fn((id: number) => frames.delete(id)),
	);
});

afterEach(async () => {
	await act(async () => reactRoot.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("sidebar portal menu position", () => {
	it("follows the anchor while moving, then positions once more at its final location", async () => {
		let top = 40;
		const positions: number[] = [];
		const { boundary } = await mount(
			true,
			true,
			vi.fn(() => positions.push(host.querySelector("button")!.getBoundingClientRect().top)),
		);
		vi.spyOn(host.querySelector("button")!, "getBoundingClientRect").mockImplementation(() => anchorRect(top));
		expect(frames.size).toBe(0);
		await mutate(() => {
			boundary.dataset.animating = "true";
		});
		await tick();
		top = 65;
		await tick();
		top = 90;
		await mutate(() => {
			delete boundary.dataset.animating;
		});
		expect(positions).toEqual([40, 65, 90]);
		expect(frames.size).toBe(0);
	});

	it("does not loop when positioning rerenders a Reicon SVG with the same markup", async () => {
		const onPosition = vi.fn();
		await act(async () =>
			reactRoot.render(
				<div className="sidebar-list-motion">
					<ReiconAnchor onPosition={onPosition} />
				</div>,
			),
		);
		const button = host.querySelector("button")!;
		let top = 40;
		let width = 24;
		vi.spyOn(button, "getBoundingClientRect").mockImplementation(() => anchorRect(top, width));
		await mutate(() => host.firstElementChild!.append(document.createElement("span")));
		expect(onPosition).toHaveBeenCalledOnce();
		expect(button.dataset.position).toBe("40");
		const svg = button.querySelector("svg")!;
		const markup = svg.innerHTML;
		await mutate(() => {
			svg.innerHTML = markup;
		});
		expect(onPosition).toHaveBeenCalledOnce();
		top = 80;
		await mutate(() => {
			svg.innerHTML = markup;
		});
		expect(onPosition).toHaveBeenCalledTimes(2);
		expect(button.dataset.position).toBe("80");
		width = 32;
		await mutate(() => {
			svg.innerHTML = markup;
		});
		expect(onPosition).toHaveBeenCalledTimes(3);
		expect(frames.size).toBe(0);
	});

	it("starts a new geometry cache when a menu reopens", async () => {
		const { boundary, render, onPosition } = await mount();
		await mutate(() => boundary.append(document.createElement("span")));
		await render(false);
		await render(true);
		await mutate(() => boundary.append(document.createElement("span")));
		expect(onPosition).toHaveBeenCalledTimes(2);
	});

	it("observes a menu opened during an existing animation", async () => {
		const { boundary, render, onPosition } = await mount(false);
		boundary.dataset.animating = "true";
		await render(true);
		expect(frames.size).toBe(1);
		await tick();
		expect(onPosition).toHaveBeenCalledOnce();
	});

	it("repositions after a reduced-motion DOM reorder without starting a frame loop", async () => {
		const { boundary, onPosition } = await mount();
		await mutate(() => {
			boundary.prepend(document.createElement("span"));
		});
		expect(onPosition).toHaveBeenCalledOnce();
		expect(frames.size).toBe(0);
	});

	it("stops tracking and observing when the menu closes", async () => {
		const { boundary, render, onPosition } = await mount();
		await mutate(() => {
			boundary.dataset.animating = "true";
		});
		expect(frames.size).toBe(1);
		await render(false);
		expect(frames.size).toBe(0);
		await mutate(() => {
			delete boundary.dataset.animating;
			boundary.append(document.createElement("span"));
		});
		expect(onPosition).not.toHaveBeenCalled();
	});

	it("cancels its queued frame and observer when unmounted", async () => {
		const { boundary, onPosition } = await mount();
		await mutate(() => {
			boundary.dataset.animating = "true";
		});
		await act(async () => reactRoot.render(null));
		expect(frames.size).toBe(0);
		await mutate(() => {
			delete boundary.dataset.animating;
		});
		expect(onPosition).not.toHaveBeenCalled();
	});

	it("does not add tracking for a header action outside the sidebar motion boundary", async () => {
		const { boundary, onPosition } = await mount(true, false);
		await mutate(() => {
			boundary.dataset.animating = "true";
			boundary.append(document.createElement("span"));
		});
		expect(onPosition).not.toHaveBeenCalled();
		expect(frames.size).toBe(0);
	});

	it("bounds frame tracking even if an animating flag is left set", async () => {
		const { boundary, onPosition } = await mount();
		await mutate(() => {
			boundary.dataset.animating = "true";
		});
		await tick(performance.now() + 10_000);
		expect(onPosition).toHaveBeenCalledOnce();
		expect(frames.size).toBe(0);
	});
});
