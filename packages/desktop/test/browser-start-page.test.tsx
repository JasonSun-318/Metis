// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserStartPage } from "../src/renderer/components/BrowserStartPage.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { DesktopHistoryEntry } from "../src/shared/desktop-api.ts";

beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	await setLocale("en");
});
afterEach(() => document.body.replaceChildren());

describe("browser start page", () => {
	it("keeps recent-page icons within the renderer image policy", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const favicon = "data:image/png;base64,aWNvbg==";
		try {
			await act(async () =>
				root.render(
					<BrowserStartPage
						tools={null}
						onNavigate={vi.fn()}
						history={[
							{
								entryId: "remote",
								url: "https://example.com",
								title: "Remote",
								visitedAt: 2,
								faviconUrl: "https://example.com/favicon.ico",
							},
							{
								entryId: "embedded",
								url: "https://example.org",
								title: "Embedded",
								visitedAt: 1,
								faviconUrl: favicon,
							},
						]}
					/>,
				),
			);
			const icons = [...container.querySelectorAll<HTMLImageElement>("img")];
			expect(icons.map((icon) => icon.getAttribute("src"))).toEqual([favicon]);
			expect(container.querySelector(".browser-start-recent-page svg")).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("shows working tools and an honest empty history", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const launch = vi.fn();
		try {
			await act(async () =>
				root.render(
					<BrowserStartPage
						tools={
							<button type="button" onClick={launch}>
								Terminal
							</button>
						}
						history={[]}
						onNavigate={vi.fn()}
					/>,
				),
			);
			await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
			expect(launch).toHaveBeenCalledTimes(1);
			expect(container.textContent).toContain("Pages you visit will appear here");
			expect(container.querySelectorAll(".browser-start-recent-page")).toHaveLength(0);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("shows the four most recent unique pages and opens the selected URL", async () => {
		const history: DesktopHistoryEntry[] = [
			{ entryId: "old", url: "https://example.com", title: "Old example", visitedAt: 1, faviconUrl: null },
			...Array.from({ length: 5 }, (_, index) => ({
				entryId: `page-${index}`,
				url: `https://example.com/${index}`,
				title: `Page ${index}`,
				visitedAt: index + 2,
				faviconUrl: null,
			})),
			{ entryId: "new", url: "https://example.com", title: "New example", visitedAt: 10, faviconUrl: null },
		];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const navigate = vi.fn();
		try {
			await act(async () =>
				root.render(
					<BrowserStartPage
						tools={<button type="button">Terminal</button>}
						history={history}
						onNavigate={navigate}
					/>,
				),
			);
			const pages = [...container.querySelectorAll<HTMLButtonElement>(".browser-start-recent-page")];
			expect(pages.map((page) => page.textContent)).toEqual(["New example", "Page 4", "Page 3", "Page 2"]);
			await act(async () => pages[0]!.click());
			expect(navigate).toHaveBeenCalledWith("https://example.com");
		} finally {
			await act(async () => root.unmount());
		}
	});
});
