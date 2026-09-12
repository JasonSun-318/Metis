// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { animateNewTaskComposer } from "../src/renderer/new-task-composer-transition.ts";

describe("new task composer transition", () => {
	it("moves from the measured home position to the existing conversation position", () => {
		const form = document.createElement("form");
		document.body.append(form);
		vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(410, 700, 770, 120));
		const animation = { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation;
		const animate = vi.fn().mockReturnValue(animation);
		Object.defineProperty(form, "animate", { value: animate, configurable: true });
		expect(animateNewTaskComposer(form, new DOMRect(410, 196, 770, 132), false)).toBe(animation);
		expect(animate).toHaveBeenCalledWith(
			[
				{ transform: "translate(0px, -504px)", width: "770px" },
				{ transform: "translate(0px, 0px)", width: "770px" },
			],
			expect.objectContaining({ duration: 360, easing: "cubic-bezier(.16, 1, .3, 1)" }),
		);
		form.remove();
	});

	it("expands the compact home width without scaling text", () => {
		const form = document.createElement("form");
		document.body.append(form);
		vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 700, 770, 120));
		const animation = { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation;
		const animate = vi.fn().mockReturnValue(animation);
		Object.defineProperty(form, "animate", { value: animate });
		animateNewTaskComposer(form, new DOMRect(425, 348, 720, 112), false);
		expect(animate).toHaveBeenCalledWith(
			[
				{ transform: "translate(25px, -352px)", width: "720px" },
				{ transform: "translate(0px, 0px)", width: "770px" },
			],
			expect.objectContaining({ fill: "none" }),
		);
		expect(form.style.width).toBe("");
		form.remove();
	});

	it("clears its marker after cancellation without leaving inline dimensions", async () => {
		const form = document.createElement("form");
		document.body.append(form);
		vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 700, 770, 120));
		let rejectFinished!: (cause: Error) => void;
		const finished = new Promise<void>((_resolve, reject) => {
			rejectFinished = reject;
		});
		const cancel = vi.fn(() => rejectFinished(new Error("cancelled")));
		Object.defineProperty(form, "animate", { value: () => ({ finished, cancel }) });
		const animation = animateNewTaskComposer(form, new DOMRect(425, 348, 720, 112), false);
		expect(form.dataset.homeTransition).toBe("running");
		animation?.cancel();
		await finished.catch(() => undefined);
		await Promise.resolve();
		expect(form.dataset.homeTransition).toBeUndefined();
		expect(form.style.width).toBe("");
		expect(form.style.transform).toBe("");
		form.remove();
	});

	it("skips disconnected or unmeasurable elements", () => {
		const form = document.createElement("form");
		const animate = vi.fn();
		Object.defineProperty(form, "animate", { value: animate });
		expect(animateNewTaskComposer(form, new DOMRect(0, 0, 720, 112), false)).toBeNull();
		document.body.append(form);
		vi.spyOn(form, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 0));
		expect(animateNewTaskComposer(form, new DOMRect(0, 0, 720, 112), false)).toBeNull();
		expect(animate).not.toHaveBeenCalled();
		form.remove();
	});

	it("does not animate when reduced motion is enabled", () => {
		const form = document.createElement("form");
		document.body.append(form);
		const animate = vi.fn();
		Object.defineProperty(form, "animate", { value: animate });
		expect(animateNewTaskComposer(form, new DOMRect(0, 0, 770, 132), true)).toBeNull();
		expect(animate).not.toHaveBeenCalled();
		form.remove();
	});
});
