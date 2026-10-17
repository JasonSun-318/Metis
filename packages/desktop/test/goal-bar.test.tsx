// @vitest-environment jsdom

import type { SessionGoalView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalBar } from "../src/renderer/components/GoalBar.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const activeGoal = {
	goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	objective: "keep tests green",
	status: "active",
	timeUsedSeconds: 5,
	activeStartedAt: "2026-08-17T00:00:00.000Z",
} satisfies SessionGoalView;

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	vi.useRealTimers();
});

function mount(
	goal: SessionGoalView | null,
	handlers?: Partial<{ onPause: () => void; onResume: () => void; onClear: () => void }>,
) {
	const onPause = handlers?.onPause ?? vi.fn();
	const onResume = handlers?.onResume ?? vi.fn();
	const onClear = handlers?.onClear ?? vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => root.render(<GoalBar goal={goal} onClear={onClear} onPause={onPause} onResume={onResume} />));
	return { container, onPause, onResume, onClear, root };
}

describe("GoalBar", () => {
	it("folds without changing the goal, keeps its timer live, and opens a new goal", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T00:00:10.000Z"));
		const { container, onPause, onResume, onClear, root } = mount(activeGoal);
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse goal"]')!.click());
		const body = container.querySelector<HTMLElement>(".goal-bar-body")!;
		expect(body.hidden).toBe(true);
		expect(body.hasAttribute("inert")).toBe(true);
		expect(container.querySelector(".goal-bar-summary")?.textContent).toBe(activeGoal.objective);
		act(() => vi.advanceTimersByTime(2_000));
		expect(container.querySelector(".goal-bar-elapsed")?.textContent).toBe("17s");
		expect(onPause).not.toHaveBeenCalled();
		expect(onResume).not.toHaveBeenCalled();
		expect(onClear).not.toHaveBeenCalled();
		act(() =>
			root.render(
				<GoalBar
					goal={{ ...activeGoal, goalId: "new-goal" }}
					onPause={onPause}
					onResume={onResume}
					onClear={onClear}
				/>,
			),
		);
		expect(body.hidden).toBe(false);
	});

	it("renders nothing without a goal", () => {
		const { container } = mount(null);
		expect(container.childElementCount).toBe(0);
	});

	it("shows an active goal with a live elapsed timer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T00:00:10.000Z"));
		const { container } = mount(activeGoal);
		expect(container.textContent).toContain("Active goal");
		expect(container.textContent).toContain("keep tests green");
		expect(container.querySelector(".goal-bar-elapsed")?.textContent).toBe("15s");

		act(() => {
			vi.advanceTimersByTime(2_000);
		});
		expect(container.querySelector(".goal-bar-elapsed")?.textContent).toBe("17s");
	});

	it("invokes pause and clear for an active goal", () => {
		const { container, onPause, onClear } = mount(activeGoal);
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Pause goal"]')?.click());
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Delete goal"]')?.click());
		expect(onPause).toHaveBeenCalledOnce();
		expect(onClear).toHaveBeenCalledOnce();
	});

	it("shows resume for paused goals without advancing the timer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T00:00:10.000Z"));
		const paused = {
			...activeGoal,
			status: "paused" as const,
			timeUsedSeconds: 12,
			activeStartedAt: null,
		};
		const { container, onResume } = mount(paused);
		expect(container.textContent).toContain("Goal paused");
		expect(container.querySelector(".goal-bar-elapsed")?.textContent).toBe("12s");
		act(() => {
			vi.setSystemTime(new Date("2026-08-17T00:01:10.000Z"));
			vi.advanceTimersByTime(1_000);
		});
		expect(container.querySelector(".goal-bar-elapsed")?.textContent).toBe("12s");
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Resume goal"]')?.click());
		expect(onResume).toHaveBeenCalledOnce();
	});

	it("allows resume from blocked and usage-limited goals", () => {
		for (const status of ["blocked", "usage_limited"] as const) {
			const { container, onResume, root } = mount({
				...activeGoal,
				status,
				activeStartedAt: null,
				timeUsedSeconds: 20,
			});
			expect(container.textContent).toContain(status === "blocked" ? "Goal blocked" : "Goal usage limited");
			act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Resume goal"]')?.click());
			expect(onResume).toHaveBeenCalledOnce();
			act(() => root.unmount());
			roots = roots.filter((candidate) => candidate !== root);
			container.remove();
			vi.mocked(onResume).mockClear();
		}
	});
});
