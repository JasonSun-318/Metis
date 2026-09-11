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
			[{ transform: "translate(0px, -504px)" }, { transform: "translate(0px, 0px)" }],
			expect.objectContaining({ duration: 360, easing: "cubic-bezier(.16, 1, .3, 1)" }),
		);
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
