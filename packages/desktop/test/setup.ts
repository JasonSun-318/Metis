import "../src/renderer/i18n.ts";
import { vi } from "vitest";

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		options: Record<string, unknown> = {};
		loadAddon() {}
		open(host: HTMLElement) {
			const terminal = document.createElement("div");
			terminal.className = "xterm";
			host.append(terminal);
		}
		onData() {
			return { dispose() {} };
		}
		write() {}
		focus() {}
		dispose() {}
	},
}));

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
Object.defineProperty(globalThis, "requestAnimationFrame", {
	configurable: true,
	writable: true,
	value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: clearTimeout });

const emptyRect = {
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
};
if (typeof Range !== "undefined") {
	Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => emptyRect });
	Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
}
