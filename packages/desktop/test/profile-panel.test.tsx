// @vitest-environment jsdom

import type { ProfileUsageSummaryView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/renderer/components/AccountMenu.tsx";
import { buildActivityWeeks, formatDuration, ProfilePanel } from "../src/renderer/components/ProfilePanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import {
	DEFAULT_PROFILE_IDENTITY,
	PROFILE_IDENTITY_STORAGE_KEY,
	saveProfileIdentity,
} from "../src/renderer/profile-identity.ts";

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
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

beforeEach(async () => {
	localStorage.clear();
	saveProfileIdentity(DEFAULT_PROFILE_IDENTITY);
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
		expect(weeks.flatMap((week) => week.days).find((day) => day.date === "2026-07-31")).toMatchObject({
			tokens: 125,
			future: false,
		});
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
		expect(container.textContent).toContain("Metis User");
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

	it("compacts Token activity only from 10,000", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		await setLocale("zh-CN");
		const api = {
			getProfile: vi.fn().mockResolvedValue({
				...profile,
				peakDailyTokens: 10_000,
				activity: [
					{ date: "2026-07-31", tokens: 9_999 },
					{ date: "2026-08-01", tokens: 10_000 },
				],
			}),
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ProfilePanel api={api} serverReady />));
		await flush();

		expect(container.querySelector('[aria-label*="9999 个 Token"]')).not.toBeNull();
		expect(container.querySelector('[aria-label*="1万 个 Token"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("persists a local display name and avatar without changing profile usage data", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const bitmap = { width: 4_000, height: 2_000, close: vi.fn() } as unknown as ImageBitmap;
		const drawImage = vi.fn();
		const createImageBitmap = vi.fn(async () => bitmap);
		vi.stubGlobal("createImageBitmap", createImageBitmap);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage,
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/webp;base64,resized");
		saveProfileIdentity({ displayName: "Barry", avatarDataUrl: null });
		const api = { getProfile: vi.fn().mockResolvedValue(profile) };
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<>
					<AccountMenu onSettings={vi.fn()} />
					<ProfilePanel api={api} serverReady />
				</>,
			),
		);
		await flush();

		expect(container.querySelector(".profile-identity h1")?.textContent).toBe("Barry");
		expect(container.querySelector(".account-menu-name")?.textContent).toBe("Barry");
		expect(container.querySelector(".account-mark")?.textContent).toBe("B");
		await act(async () => button(container, "Edit display name").click());
		const name = container.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Barry Bai");
			name.dispatchEvent(new Event("input", { bubbles: true }));
			name.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
		});
		expect(JSON.parse(localStorage.getItem(PROFILE_IDENTITY_STORAGE_KEY)!).displayName).toBe("Barry Bai");
		expect(container.querySelector(".account-menu-name")?.textContent).toBe("Barry Bai");

		const avatar = container.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(avatar, "files", {
			configurable: true,
			value: [new File(["avatar"], "avatar.png", { type: "image/png" })],
		});
		await act(async () => avatar.dispatchEvent(new Event("change", { bubbles: true })));
		await flush();
		expect(createImageBitmap).toHaveBeenCalledOnce();
		expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 256, 128);
		expect(bitmap.close).toHaveBeenCalledOnce();
		expect(JSON.parse(localStorage.getItem(PROFILE_IDENTITY_STORAGE_KEY)!).avatarDataUrl).toBe(
			"data:image/webp;base64,resized",
		);
		expect(container.querySelector<HTMLImageElement>(".account-mark img")?.src).toBe(
			"data:image/webp;base64,resized",
		);
		await act(async () => root.unmount());
	});

	it("keeps an honest empty state and retries a failed request", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const api = {
			getProfile: vi
				.fn()
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

		await act(async () => button(container, "Metis User").click());
		expect(button(container, "Metis User").getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement?.textContent).toBe("Settings");
		expect(container.textContent).not.toContain("Language");
		expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(button(container, "Metis User").getAttribute("aria-expanded")).toBe("false");
		await act(async () => button(container, "Metis User").click());
		await act(async () => button(container, "Settings").click());
		expect(onSettings).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("clicking refresh triggers update check independently without opening Settings", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const onSettings = vi.fn();
		const onCheckUpdate = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<AccountMenu onCheckUpdate={onCheckUpdate} onSettings={onSettings} />));

		const refresh = button(container, "Check for updates");
		expect(refresh.classList.contains("account-update-check")).toBe(true);
		await act(async () => refresh.click());
		expect(onCheckUpdate).toHaveBeenCalledOnce();
		expect(onSettings).not.toHaveBeenCalled();
		expect(button(container, "Metis User").getAttribute("aria-expanded")).toBe("false");
		await act(async () => root.unmount());
	});
});
