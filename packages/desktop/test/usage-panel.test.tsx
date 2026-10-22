// @vitest-environment jsdom

import type { UsageRangeDays, UsageSummaryView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsagePanel } from "../src/renderer/components/UsagePanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

function usage(rangeDays: UsageRangeDays): UsageSummaryView {
	const daily = Array.from({ length: rangeDays }, (_, index) => ({
		date: new Date(Date.UTC(2026, 7, 8 - rangeDays + index + 1)).toISOString().slice(0, 10),
		chatTokens: index === rangeDays - 1 ? 20 : 0,
		codeTokens: index === rangeDays - 1 ? 80 : 0,
		inputTokens: index === rangeDays - 1 ? 60 : 0,
		outputTokens: index === rangeDays - 1 ? 40 : 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	}));
	return {
		generatedAt: "2026-08-08T12:00:00.000Z",
		rangeDays,
		totalTokens: 100,
		inputTokens: 60,
		outputTokens: 40,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		chatTokens: 20,
		codeTokens: 80,
		sessionCount: 2,
		chatSessionCount: 1,
		codeSessionCount: 1,
		daily,
		topModels: [{ provider: "openai", modelId: "gpt-5", totalTokens: 100 }],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function renderUsagePanel() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return { container, root };
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("UsagePanel", () => {
	it("shows a retryable initial error and recovers on the current range", async () => {
		let calls = 0;
		const getUsage = vi.fn(() => {
			calls += 1;
			return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(usage(30));
		});
		const { container, root } = renderUsagePanel();

		await act(async () => root.render(<UsagePanel api={{ getUsage } as unknown as MetisDesktopApi} serverReady />));
		await flush();
		expect(container.querySelector(".usage-bar")).toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("offline");
		expect(button(container, "7d")).toBeTruthy();
		expect(button(container, "30d").getAttribute("aria-pressed")).toBe("true");

		await act(async () => button(container, "Retry").click());
		await flush();
		expect(getUsage).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(30);
		await act(async () => root.unmount());
	});

	it("never shows the previous range while a new range is pending or failed, then retries that range", async () => {
		const pendingSeven = deferred<UsageSummaryView>();
		let sevenCalls = 0;
		const getUsage = vi.fn(({ rangeDays }: { rangeDays: UsageRangeDays }) => {
			if (rangeDays === 30) return Promise.resolve(usage(30));
			sevenCalls += 1;
			return sevenCalls === 1 ? pendingSeven.promise : Promise.resolve(usage(7));
		});
		const { container, root } = renderUsagePanel();

		await act(async () => root.render(<UsagePanel api={{ getUsage } as unknown as MetisDesktopApi} serverReady />));
		await flush();
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(30);

		await act(async () => button(container, "7d").click());
		await flush();
		expect(container.querySelector(".usage-bar")).toBeNull();
		expect(container.querySelector(".usage-summary-cards")).toBeNull();
		expect(button(container, "7d").getAttribute("aria-pressed")).toBe("true");
		expect(button(container, "7d")).toBeTruthy();

		await act(async () => {
			pendingSeven.reject(new Error("seven failed"));
			await Promise.resolve();
		});
		await flush();
		expect(container.querySelector(".usage-bar")).toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("seven failed");
		expect(button(container, "7d").getAttribute("aria-pressed")).toBe("true");

		await act(async () => button(container, "Retry").click());
		await flush();
		expect(getUsage).toHaveBeenLastCalledWith({ rangeDays: 7 });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(7);
		await act(async () => root.unmount());
	});

	it("ignores a superseded response that arrives after a newer range", async () => {
		const pendingSeven = deferred<UsageSummaryView>();
		const pendingNinety = deferred<UsageSummaryView>();
		const getUsage = vi.fn(({ rangeDays }: { rangeDays: UsageRangeDays }) => {
			if (rangeDays === 30) return Promise.resolve(usage(30));
			return rangeDays === 7 ? pendingSeven.promise : pendingNinety.promise;
		});
		const { container, root } = renderUsagePanel();

		await act(async () => root.render(<UsagePanel api={{ getUsage } as unknown as MetisDesktopApi} serverReady />));
		await flush();
		await act(async () => button(container, "7d").click());
		await flush();
		await act(async () => button(container, "90d").click());
		await flush();

		await act(async () => {
			pendingNinety.resolve(usage(90));
			await Promise.resolve();
		});
		await flush();
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(90);
		expect(button(container, "90d").getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			pendingSeven.resolve(usage(7));
			await Promise.resolve();
		});
		await flush();
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(90);
		expect(button(container, "90d").getAttribute("aria-pressed")).toBe("true");
		await act(async () => root.unmount());
	});

	it("localizes range labels in English and Chinese", async () => {
		const getUsage = vi.fn(() => Promise.resolve(usage(30)));
		const english = renderUsagePanel();
		await act(async () =>
			english.root.render(<UsagePanel api={{ getUsage } as unknown as MetisDesktopApi} serverReady />),
		);
		await flush();
		expect(button(english.container, "7d")).toBeTruthy();
		expect(button(english.container, "30d")).toBeTruthy();
		expect(button(english.container, "90d")).toBeTruthy();
		await act(async () => english.root.unmount());

		await setLocale("zh-CN");
		const chinese = renderUsagePanel();
		await act(async () =>
			chinese.root.render(<UsagePanel api={{ getUsage } as unknown as MetisDesktopApi} serverReady />),
		);
		await flush();
		expect(button(chinese.container, "7 天")).toBeTruthy();
		expect(button(chinese.container, "30 天")).toBeTruthy();
		expect(button(chinese.container, "90 天")).toBeTruthy();
		await act(async () => chinese.root.unmount());
	});
});
