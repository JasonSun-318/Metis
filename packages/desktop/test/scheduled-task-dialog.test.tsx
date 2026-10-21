// @vitest-environment jsdom

import type { ScheduleTaskView } from "@metis/app-protocol";
import { act, useState } from "react";
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
});
