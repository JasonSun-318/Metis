// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskList } from "../src/renderer/components/TaskList.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
describe("transcript task list", () => {
	it("keeps completed work as an expandable snapshot, including on reload", async () => {
		const tasks = [
			{ task: "Inspect", completed: false },
			{ task: "Verify", completed: false },
		];
		await act(async () => root.render(<TaskList tasks={tasks} />));
		const first = container.querySelector("li");
		expect(container.querySelectorAll(".task-list-spinner")).toHaveLength(2);
		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		await act(async () => root.render(<TaskList tasks={[{ ...tasks[0]!, completed: true }, tasks[1]!]} />));
		expect(container.querySelector("li.is-completed .task-list-spinner")).toBeNull();
		expect(container.querySelectorAll(".task-list-spinner")).toHaveLength(1);
		await act(async () => root.render(<TaskList tasks={tasks.map((task) => ({ ...task, completed: true }))} />));
		expect(container.querySelectorAll(".task-list-spinner")).toHaveLength(0);
		expect(container.querySelector("button")?.textContent).toContain("Completed2/2");
		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector(".transcript-drawer")?.hasAttribute("inert")).toBe(true);
		await act(async () => container.querySelector("button")!.click());
		expect(container.querySelector("li")).toBe(first);
		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		await act(async () =>
			root.render(<TaskList key="reload" tasks={tasks.map((task) => ({ ...task, completed: true }))} />),
		);
		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelectorAll("li.is-completed")).toHaveLength(2);
	});
	it("only toggles presentation and renders no controls for task status", async () => {
		await act(async () => root.render(<TaskList tasks={[{ task: "Read", completed: false }]} />));
		expect(container.querySelectorAll("button")).toHaveLength(1);
		expect(container.querySelector("input")).toBeNull();
		await act(async () => container.querySelector("button")!.click());
		expect(container.querySelector("li")?.textContent).toBe("Read");
		await act(async () => root.render(<TaskList tasks={[]} />));
		expect(container.childElementCount).toBe(0);
	});
});
