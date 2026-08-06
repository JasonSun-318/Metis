// @vitest-environment jsdom

import type { ProfileUsageSummaryView } from "@arcmind/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/renderer/components/AccountMenu.tsx";
import { buildActivityWeeks, formatDuration, ProfilePanel } from "../src/renderer/components/ProfilePanel.tsx";
import { APP_LOCALE_STORAGE_KEY, setLocale } from "../src/renderer/i18n.ts";

const profile: ProfileUsageSummaryView = {
	generatedAt: "2026-08-01T12:00:00.000Z",
	totalTokens: 1_520_000,
	peakDailyTokens: 500,
	longestSessionMs: 7_020_000,
	currentStreakDays: 2,
	longestStreakDays: 5,
	sessionCount: 12,
	mostUsedMode: "code",
	mostUsedModePercent: 75,
	mostUsedThinkingLevel: "high",
	mostUsedThinkingLevelPercent: 67,
	usedSkillCount: 3,
	skillUseCount: 9,
	activity: [
		{ date: "2026-07-31", tokens: 125 },
		{ date: "2026-08-01", tokens: 500 },
	],
	topSkills: [
		{ name: "ponytail", count: 5 },
		{ name: "writing-plans", count: 4 },
	],
};

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

beforeEach(async () => {
	localStorage.clear();
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("ProfilePanel", () => {
	it("builds a fixed 53-week calendar and formats durations", () => {
		const weeks = buildActivityWeeks(profile);
		expect(weeks).toHaveLength(53);
		expect(weeks.filter((week) => week.month)).toHaveLength(12);
		expect(weeks.flatMap((week) => week.days)).toHaveLength(371);
		expect(weeks.flatMap((week) => week.days).find((day) => day.date === "2026-07-31"))
			.toMatchObject({ tokens: 125, future: false });
		expect(formatDuration(59_000)).toBe("0m");
		expect(formatDuration(7_020_000)).toBe("1h 57m");
	});

	it("renders real summary data, Token cells, and Skill rankings", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const api = { getProfile: vi.fn().mockResolvedValue(profile) };
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ProfilePanel api={api} serverReady />));
		await flush();

		expect(api.getProfile).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("ArcMind User");
		expect(container.textContent).toContain("1.5M");
		expect(container.textContent).toContain("Most used Skills");
		expect(container.textContent).toContain("Most used reasoning effort");
		expect(container.textContent).toContain("High · 67%");
		expect(container.textContent).toContain("Code · 75%");
		expect(container.textContent).toContain("ponytail");
		expect(container.querySelectorAll(".profile-heatmap-week")).toHaveLength(53);
		const animatedCells = container.querySelectorAll<HTMLElement>(".profile-heatmap-cell");
		expect(animatedCells[0]?.style.getPropertyValue("--profile-cell-index")).toBe("0");
		expect(animatedCells[animatedCells.length - 1]?.style.getPropertyValue("--profile-cell-index")).not.toBe("0");
		expect(container.querySelector('[aria-label*="Aug 1, 2026: 500 Tokens"]')?.getAttribute("data-level")).toBe("4");
		await act(async () => root.unmount());
	});

	it("keeps an honest empty state and retries a failed request", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const api = {
			getProfile: vi.fn()
				.mockRejectedValueOnce(new Error("offline"))
				.mockResolvedValueOnce({ ...profile, usedSkillCount: 0, skillUseCount: 0, topSkills: [] }),
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ProfilePanel api={api} serverReady />));
		await flush();
		expect(container.textContent).toContain("Couldn’t load your profile");
		await act(async () => button(container, "Retry").click());
		await flush();
		expect(container.textContent).toContain("Skill activity will appear after you use a Skill.");
		expect(api.getProfile).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});
});

describe("AccountMenu", () => {
	it("opens accessibly, closes with Escape, and activates Settings", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const onSettings = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<AccountMenu onSettings={onSettings} />));

		await act(async () => button(container, "ArcMind").click());
		expect(button(container, "ArcMind").getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement?.textContent).toBe("Settings");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(button(container, "ArcMind").getAttribute("aria-expanded")).toBe("false");
		await act(async () => button(container, "ArcMind").click());
		await act(async () => button(container, "Settings").click());
		expect(onSettings).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("opens a two-language submenu and persists an immediate Chinese switch", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<AccountMenu onSettings={vi.fn()} />));

		await act(async () => button(container, "ArcMind").click());
		await act(async () => button(container, "Language").click());
		expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
		expect(button(container, "English").getAttribute("aria-checked")).toBe("true");
		await act(async () => button(container, "中文").click());
		expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(button(container, "ArcMind").getAttribute("aria-expanded")).toBe("false");

		await act(async () => button(container, "ArcMind").click());
		expect(container.textContent).toContain("设置");
		expect(container.textContent).toContain("语言");
		await act(async () => root.unmount());
	});
});
