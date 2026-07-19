// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingSelector } from "../src/renderer/components/ThinkingSelector.tsx";

afterEach(() => document.body.replaceChildren());

describe("ThinkingSelector", () => {
	it("renders Ultra last with its real level and emits the composite selection", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		await act(async () => {
			root.render(
				<ThinkingSelector
					actualThinkingLevel="max"
					available={["off", "high", "max", "ultra"]}
					disabled={false}
					onChange={onChange}
					value="ultra"
				/>,
			);
		});
		const options = [...container.querySelectorAll("option")];
		expect(options.map((option) => option.textContent)).toEqual(["off", "high", "max", "Ultra · Multi-agent"]);
		expect(container.textContent).toContain("multiple model calls");
		const select = container.querySelector("select")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "high");
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onChange).toHaveBeenCalledWith("high");
		await act(async () => root.unmount());
	});
});
