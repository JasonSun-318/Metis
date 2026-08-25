// @vitest-environment jsdom

import type { PlanView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanCard } from "../src/renderer/components/PlanCard.tsx";

const plan: PlanView = {
	planId: "plan-1",
	revision: 2,
	title: "Add greeting",
	markdown: "# Goal\n\nAdd a greeting.",
	status: "proposed",
	createdAt: "2026-07-16T00:00:00.000Z",
};

afterEach(() => document.body.replaceChildren());

async function renderCard(overrides: Partial<PlanView> = {}) {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const onStart = vi.fn();
	const onRevise = vi.fn();
	const onCancel = vi.fn();
	const onOpen = vi.fn();
	await act(async () =>
		root.render(
			<PlanCard
				busy={false}
				onCancel={onCancel}
				onOpen={onOpen}
				onRevise={onRevise}
				onStart={onStart}
				plan={{ ...plan, ...overrides }}
			/>,
		),
	);
	return { container, root, onStart, onRevise, onCancel, onOpen };
}

describe("PlanCard", () => {
	it("renders fixed-scroll Markdown and invokes exact-revision actions", async () => {
		const { container, root, onStart, onRevise } = await renderCard();
		expect(container.querySelector(".plan-card-body")).not.toBeNull();
		container.querySelector<HTMLButtonElement>('[data-plan-action="start"]')!.click();
		container.querySelector<HTMLButtonElement>('[data-plan-action="revise"]')!.click();
		expect(onStart).toHaveBeenCalledWith(plan);
		expect(onRevise).toHaveBeenCalledWith(plan);
		await act(async () => root.unmount());
	});

	it.each(["superseded", "accepted", "cancelled"] as const)("keeps %s plans read-only", async (status) => {
		const { container, root } = await renderCard({ status });
		expect(container.querySelectorAll("[data-plan-action]")).toHaveLength(1);
		expect(container.querySelector('[data-plan-action="open"]')).not.toBeNull();
		await act(async () => root.unmount());
	});
});
