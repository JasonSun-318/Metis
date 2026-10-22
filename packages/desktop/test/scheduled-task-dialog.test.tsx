// @vitest-environment jsdom

import type { ScheduleTaskView } from "@metis/app-protocol";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskDialog } from "../src/renderer/components/ScheduledTaskDialog.tsx";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const TASK: ScheduleTaskView = {
	id: "20000000-0000-4000-8000-000000000001",
	name: "Morning brief",
	instruction: "Summarize the calendar.",
	model: { provider: "openai", modelId: "gpt-4" },
	schedule: { kind: "daily", time: "08:00" },
	timezone: "Asia/Shanghai",
	target: { kind: "general", workspace: "task" },
	status: "active",
	createdAt: "2026-07-31T00:00:00Z",
	updatedAt: "2026-07-31T00:00:00Z",
	nextRunAt: "2026-08-01T00:00:00Z",
	unreadCount: 0,
};

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function selectOption(container: HTMLElement, label: string, option: string) {
	const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
	await act(async () => trigger.click());
	const item = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
		(button) => button.textContent === option,
	)!;
	await act(async () => item.click());
}

function field(container: HTMLElement, name: string): HTMLInputElement | HTMLTextAreaElement {
	return [...container.querySelectorAll("label")]
		.find((label) => label.firstChild?.textContent === name)!
		.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	return [...container.querySelectorAll("button")].find((button) => button.textContent === text)!;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	return { container, root };
}

const MODELS = [{ provider: "openai", modelId: "gpt-4", name: "GPT-4" }];

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("ScheduledTaskDialog", () => {
	it("focuses the name field and restores the create button after closing", async () => {
		function Host() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button onClick={() => setOpen(true)} type="button">
						Create task
					</button>
					{open && (
						<ScheduledTaskDialog
							api={{} as MetisDesktopApi}
							models={[]}
							sessions={[]}
							onClose={() => setOpen(false)}
							onSaved={() => setOpen(false)}
						/>
					)}
				</>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<Host />));
			const trigger = container.querySelector<HTMLButtonElement>("button")!;
			trigger.focus();
			await act(async () => trigger.click());
			expect(document.activeElement).toBe(container.querySelector("input"));
			const close = container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
			const last = container.querySelector<HTMLButtonElement>("footer button:not(:disabled)")!;
			last.focus();
			await act(async () =>
				last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })),
			);
			expect(document.activeElement).toBe(close);
			await act(async () =>
				close.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
				),
			);
			expect(document.activeElement).toBe(last);
			await act(async () =>
				container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })),
			);
			expect(container.querySelector("dialog")).toBeNull();
			expect(document.activeElement).toBe(trigger);
		} finally {
			await act(async () => root.unmount());
		}
	});
	it("submits required display metadata, only the instruction prompt, and a configured model", async () => {
		const createSchedule = vi.fn().mockResolvedValue({ task: TASK });
		const selectProjectFolder = vi.fn().mockResolvedValue("/Users/test/Desktop");
		const api = { createSchedule, selectProjectFolder } as unknown as MetisDesktopApi;
		const onSaved = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTaskDialog
					api={api}
					models={[{ provider: "openai", modelId: "gpt-4", name: "GPT-4" }]}
					onClose={() => undefined}
					onSaved={onSaved}
					sessions={[]}
				/>,
			),
		);
		const labels = [...container.querySelectorAll("label")];
		const control = (name: string) =>
			labels.find((label) => label.firstChild?.textContent === name)?.querySelector("input, textarea") as
				| HTMLInputElement
				| HTMLTextAreaElement;
		await act(async () => {
			setValue(control("Name"), "Morning brief");
			setValue(control("Description"), "Desktop summary");
			setValue(control("Instructions"), "Summarize the calendar.");
		});
		await selectOption(container, "Model", "GPT-4 · openai");
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[aria-label="Choose additional folder access"]')!.click();
		});
		const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
		await act(async () => save.click());
		expect(createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Morning brief",
				description: "Desktop summary",
				instruction: "Summarize the calendar.",
				model: { provider: "openai", modelId: "gpt-4" },
				schedule: { kind: "daily", time: "09:00" },
				additionalWorkspaceCwd: "/Users/test/Desktop",
			}),
		);
		expect(onSaved).toHaveBeenCalledWith(TASK);
		await act(async () => root.unmount());
	});

	it("can remove additional folder access from an existing task", async () => {
		const existing = {
			...TASK,
			target: {
				kind: "general" as const,
				workspace: "task" as const,
				additionalWorkspaceCwd: "/Users/test/Desktop",
			},
		};
		const saved = { ...TASK, target: { kind: "general" as const, workspace: "task" as const } };
		const updateSchedule = vi.fn().mockResolvedValue({ task: saved });
		const api = { updateSchedule } as unknown as MetisDesktopApi;
		const onSaved = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTaskDialog
					api={api}
					models={[{ provider: "openai", modelId: "gpt-4", name: "GPT-4" }]}
					onClose={() => undefined}
					onSaved={onSaved}
					sessions={[]}
					task={existing}
				/>,
			),
		);
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[aria-label="Remove additional folder access"]')!.click();
		});
		const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
		await act(async () => save.click());
		expect(updateSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: TASK.id,
				sourceSessionId: null,
				additionalWorkspaceCwd: null,
			}),
		);
		expect(onSaved).toHaveBeenCalledWith(saved);
		await act(async () => root.unmount());
	});

	it("guards a create draft across Cancel, X, backdrop, Escape, keep, and discard", async () => {
		const onClose = vi.fn();
		const { container, root } = await mount(
			<ScheduledTaskDialog
				api={{} as MetisDesktopApi}
				models={[]}
				onClose={onClose}
				onSaved={() => undefined}
				sessions={[]}
			/>,
		);
		await act(async () => {
			setValue(field(container, "Name"), "Draft name");
			setValue(field(container, "Instructions"), "Draft instruction");
		});
		await act(async () => buttonByText(container, "Cancel").click());
		expect(onClose).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Your changes have not been saved.");
		expect(field(container, "Name").value).toBe("Draft name");
		expect(field(container, "Instructions").value).toBe("Draft instruction");
		await act(async () => buttonByText(container, "Keep editing").click());
		expect(container.textContent).not.toContain("Your changes have not been saved.");
		expect(onClose).not.toHaveBeenCalled();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
		expect(container.textContent).toContain("Your changes have not been saved.");
		await act(async () =>
			container
				.querySelector("dialog")!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
		);
		expect(container.textContent).not.toContain("Your changes have not been saved.");
		expect(document.activeElement).toBe(container.querySelector("input"));
		await act(async () =>
			container.querySelector("dialog")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
		);
		expect(container.textContent).toContain("Your changes have not been saved.");
		await act(async () => buttonByText(container, "Discard changes").click());
		expect(onClose).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("guards edited fields and discards without calling the update API", async () => {
		const onClose = vi.fn();
		const updateSchedule = vi.fn();
		const { container, root } = await mount(
			<ScheduledTaskDialog
				api={{ updateSchedule } as unknown as MetisDesktopApi}
				models={MODELS}
				onClose={onClose}
				onSaved={() => undefined}
				sessions={[]}
				task={TASK}
			/>,
		);
		await selectOption(container, "Repeat", "Weekly");
		await act(async () => buttonByText(container, "Cancel").click());
		expect(container.textContent).toContain("Your changes have not been saved.");
		await act(async () => buttonByText(container, "Keep editing").click());
		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Repeat"]')!.textContent).toContain("Weekly");
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
		await act(async () => buttonByText(container, "Discard changes").click());
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(updateSchedule).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("closes clean dialogs immediately and lets an unchanged edit return without a request", async () => {
		const onClose = vi.fn();
		const updateSchedule = vi.fn();
		const edit = await mount(
			<ScheduledTaskDialog
				api={{ updateSchedule } as unknown as MetisDesktopApi}
				models={MODELS}
				onClose={onClose}
				onSaved={() => undefined}
				sessions={[]}
				task={TASK}
			/>,
		);
		await act(async () =>
			[...edit.container.querySelectorAll<HTMLButtonElement>("footer button")]
				.find((button) => button.textContent === "Save")!
				.click(),
		);
		await flush();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(updateSchedule).not.toHaveBeenCalled();
		expect(edit.container.textContent).not.toContain("Your changes have not been saved.");
		await act(async () => edit.root.unmount());

		const createClose = vi.fn();
		const create = await mount(
			<ScheduledTaskDialog
				api={{} as MetisDesktopApi}
				models={[]}
				onClose={createClose}
				onSaved={() => undefined}
				sessions={[]}
			/>,
		);
		await act(async () => buttonByText(create.container, "Cancel").click());
		expect(createClose).toHaveBeenCalledTimes(1);
		expect(create.container.textContent).not.toContain("Your changes have not been saved.");
		await act(async () => create.root.unmount());
	});

	it("disables fields, menus, and close paths while a deferred save is pending", async () => {
		const pending = deferred<{ task: ScheduleTaskView }>();
		const createSchedule = vi.fn().mockReturnValue(pending.promise);
		const onClose = vi.fn();
		const onSaved = vi.fn();
		const { container, root } = await mount(
			<ScheduledTaskDialog
				api={{ createSchedule } as unknown as MetisDesktopApi}
				models={MODELS}
				onClose={onClose}
				onSaved={onSaved}
				sessions={[]}
			/>,
		);
		await act(async () => {
			setValue(field(container, "Name"), "Pending task");
			setValue(field(container, "Instructions"), "Do the work.");
		});
		await selectOption(container, "Model", "GPT-4 · openai");
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>("footer button")]
				.find((button) => button.textContent === "Save")!
				.click(),
		);
		expect(field(container, "Name").disabled).toBe(true);
		expect(field(container, "Description").disabled).toBe(true);
		expect(field(container, "Instructions").disabled).toBe(true);
		for (const label of ["Work in", "Model", "Repeat"]) {
			expect(container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.disabled).toBe(true);
		}
		expect(buttonByText(container, "Cancel").disabled).toBe(true);
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled).toBe(true);
		expect(container.querySelector<HTMLButtonElement>('footer button[type="submit"]')!.disabled).toBe(true);
		await act(async () =>
			container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })),
		);
		expect(onClose).not.toHaveBeenCalled();
		await act(async () => {
			pending.resolve({ task: TASK });
			await pending.promise;
		});
		await flush();
		expect(onSaved).toHaveBeenCalledWith(TASK);
		await act(async () => root.unmount());
	});

	it("keeps the complete draft and re-enables editing when a deferred save fails", async () => {
		const pending = deferred<{ task: ScheduleTaskView }>();
		const createSchedule = vi.fn().mockReturnValue(pending.promise);
		const onClose = vi.fn();
		const onSaved = vi.fn();
		const { container, root } = await mount(
			<ScheduledTaskDialog
				api={{ createSchedule } as unknown as MetisDesktopApi}
				models={MODELS}
				onClose={onClose}
				onSaved={onSaved}
				sessions={[]}
			/>,
		);
		await act(async () => {
			setValue(field(container, "Name"), "Keep me");
			setValue(field(container, "Description"), "Keep description");
			setValue(field(container, "Instructions"), "Keep instructions.");
		});
		await selectOption(container, "Model", "GPT-4 · openai");
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>("footer button")]
				.find((button) => button.textContent === "Save")!
				.click(),
		);
		await act(async () => {
			pending.reject(new Error("Save failed."));
			await pending.promise.catch(() => undefined);
		});
		await flush();
		expect(onSaved).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed.");
		expect(field(container, "Name").value).toBe("Keep me");
		expect(field(container, "Description").value).toBe("Keep description");
		expect(field(container, "Instructions").value).toBe("Keep instructions.");
		expect(field(container, "Name").disabled).toBe(false);
		expect(field(container, "Instructions").disabled).toBe(false);
		expect(buttonByText(container, "Cancel").disabled).toBe(false);
		await act(async () => root.unmount());
	});
	it("handles consecutive Escape keys before native cancellation can close a dirty dialog", async () => {
		const onClose = vi.fn();
		const { container, root } = await mount(
			<ScheduledTaskDialog
				api={{} as MetisDesktopApi}
				models={MODELS}
				sessions={[]}
				onClose={onClose}
				onSaved={vi.fn()}
			/>,
		);
		const input = field(container, "Name");
		await act(async () => setValue(input, "Keep this draft"));
		const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		await act(async () => input.dispatchEvent(first));
		expect(first.defaultPrevented).toBe(true);
		expect(container.querySelector(".scheduled-task-discard")).not.toBeNull();
		const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		await act(async () => input.dispatchEvent(second));
		expect(second.defaultPrevented).toBe(true);
		expect(container.querySelector(".scheduled-task-discard")).toBeNull();
		expect(container.querySelector("dialog")!.open).toBe(true);
		expect(input.value).toBe("Keep this draft");
		expect(onClose).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});
});
