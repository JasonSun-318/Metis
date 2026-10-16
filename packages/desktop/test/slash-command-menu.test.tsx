// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashCommandMenu } from "../src/renderer/components/SlashCommandMenu.tsx";

afterEach(() => document.body.replaceChildren());

describe("SlashCommandMenu", () => {
	it("orders built-ins before Skills and filters by query", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = {
			disabledCommands: new Set<never>(),
			onDismiss: vi.fn(),
			onSelectCommand: vi.fn(),
			onSelectSkill: vi.fn(),
			skills: [{ name: "codebase-design", description: "Design deep modules" }],
		};
		await act(async () => root.render(<SlashCommandMenu {...props} query="" />));
		expect([...container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent)).toEqual([
			"/compact",
			"/goal",
			"/plan",
			"/model",
			"/thinking",
			"/status",
			"/mcp",
			"skill:codebase-design",
		]);

		await act(async () => root.render(<SlashCommandMenu {...props} query="com" />));
		expect([...container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent)).toEqual([
			"/compact",
		]);
		await act(async () => root.render(<SlashCommandMenu {...props} query="goa" />));
		expect([...container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent)).toEqual([
			"/goal",
		]);
		await act(async () => root.unmount());
	});

	it("selects by pointer and keyboard but blocks disabled commands", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSelectCommand = vi.fn();
		await act(async () =>
			root.render(
				<SlashCommandMenu
					disabledCommands={new Set(["compact"])}
					disabledReasons={{ compact: "Stop the active task before compacting" }}
					onDismiss={vi.fn()}
					onSelectCommand={onSelectCommand}
					onSelectSkill={vi.fn()}
					query=""
					skills={[]}
				/>,
			),
		);
		const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
		expect(options[0]?.getAttribute("aria-disabled")).toBe("true");
		await act(async () => options[0]?.click());
		expect(onSelectCommand).not.toHaveBeenCalled();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onSelectCommand).toHaveBeenCalledWith("goal");
		await act(async () => root.unmount());
	});
});
