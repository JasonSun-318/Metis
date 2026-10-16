// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RELEASE_NOTES_READ_VERSION_STORAGE_KEY,
	ReleaseNotesPopover,
} from "../src/renderer/components/ReleaseNotesPopover.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { DesktopChangelog } from "../src/shared/desktop-api.ts";

const CHANGELOG: DesktopChangelog = {
	schemaVersion: 1,
	releases: [
		{ version: "0.82.0", notes: "## Highlights\n\n- Added history" },
		{ version: "0.81.0", notes: "## Fixes\n\n- Safer updates" },
	],
};

function findButton(container: ParentNode, label: string): HTMLButtonElement {
	const match = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
		...document.querySelectorAll<HTMLButtonElement>(".release-notes-popover button"),
	].find((button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function view(root: Root, loadChangelog: () => Promise<DesktopChangelog>) {
	await act(async () => root.render(<ReleaseNotesPopover loadChangelog={loadChangelog} />));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(async () => {
	await setLocale("en");
	localStorage.clear();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	localStorage.clear();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("ReleaseNotesPopover", () => {
	it("escapes sidebar clipping and stays within the viewport while preserving close behavior", async () => {
		const container = document.createElement("div");
		container.style.overflow = "hidden";
		container.style.width = "302px";
		document.body.append(container);
		const root = createRoot(container);
		let viewportWidth = 1024;
		vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() => viewportWidth);
		vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
		try {
			await view(root, vi.fn().mockResolvedValue(CHANGELOG));
			const trigger = findButton(container, "Open unread release notes");
			vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
				left: 280,
				right: 306,
				top: 700,
				bottom: 728,
				width: 26,
				height: 28,
				x: 280,
				y: 700,
				toJSON: () => ({}),
			});
			await act(async () => trigger.click());
			const panel = document.querySelector<HTMLElement>(".release-notes-popover")!;
			expect(panel.parentElement).toBe(document.body);
			expect(panel.style.left).toBe("8px");
			expect(panel.style.bottom).toBe("76px");
			expect(document.activeElement).toBe(findButton(panel, "Close release notes"));
			await act(async () =>
				panel.querySelector("summary")!.dispatchEvent(new Event("pointerdown", { bubbles: true })),
			);
			expect(document.querySelector(".release-notes-popover")).toBe(panel);
			viewportWidth = 300;
			await act(async () => window.dispatchEvent(new Event("resize")));
			expect(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(292);
			await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
			expect(document.querySelector(".release-notes-popover")).toBeNull();
			expect(document.activeElement).toBe(trigger);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it.each(["failure", "stale history"])("keeps a discovered update unread when refresh returns %s", async (result) => {
		localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, "0.81.0");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const oldHistory: DesktopChangelog = { schemaVersion: 1, releases: [CHANGELOG.releases[1]!] };
		const loadChangelog = vi.fn().mockResolvedValue(oldHistory);
		try {
			await view(root, loadChangelog);
			if (result === "failure") loadChangelog.mockRejectedValue(new Error("offline"));
			await act(async () =>
				root.render(<ReleaseNotesPopover loadChangelog={loadChangelog} availableVersion="0.82.0" />),
			);
			expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
			await act(async () => findButton(container, "Open unread release notes").click());
			expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.81.0");
			await act(async () => findButton(container, "Close release notes").click());
			loadChangelog.mockResolvedValue(CHANGELOG);
			await act(async () => findButton(container, "Open unread release notes").click());
			expect(document.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
			expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("refreshes stale cached history when the bell remounts with a discovered update", async () => {
		localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, "0.81.0");
		const container = document.createElement("div");
		document.body.append(container);
		let root = createRoot(container);
		const loadChangelog = vi
			.fn()
			.mockResolvedValueOnce({ schemaVersion: 1, releases: [CHANGELOG.releases[1]!] })
			.mockResolvedValue(CHANGELOG);
		try {
			await view(root, loadChangelog);
			await act(async () => root.unmount());
			root = createRoot(container);
			await act(async () =>
				root.render(<ReleaseNotesPopover loadChangelog={loadChangelog} availableVersion="0.82.0" />),
			);
			expect(loadChangelog).toHaveBeenCalledTimes(2);
			expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("does not let an older in-flight history overwrite the discovered release", async () => {
		localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, "0.81.0");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		let resolveOld!: (changelog: DesktopChangelog) => void;
		const loadChangelog = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<DesktopChangelog>((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockResolvedValue(CHANGELOG);
		try {
			await view(root, loadChangelog);
			await act(async () =>
				root.render(<ReleaseNotesPopover loadChangelog={loadChangelog} availableVersion="0.82.0" />),
			);
			await act(async () => findButton(container, "Open unread release notes").click());
			await act(async () => resolveOld({ schemaVersion: 1, releases: [CHANGELOG.releases[1]!] }));
			expect(document.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
			expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("loads independently, shows an unread dot, and renders newest-first history", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const loadChangelog = vi.fn().mockResolvedValue(CHANGELOG);
		await view(root, loadChangelog);

		expect(loadChangelog).toHaveBeenCalledOnce();
		expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		await act(async () => findButton(container, "Open unread release notes").click());
		expect(loadChangelog).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");

		const releases = [...document.querySelectorAll<HTMLDetailsElement>(".release-notes-release")];
		expect(releases.map((release) => release.querySelector("summary")?.textContent)).toEqual([
			"Version 0.82.0Latest",
			"Version 0.81.0",
		]);
		expect(releases[0]?.open).toBe(true);
		expect(releases[1]?.open).toBe(false);
		expect(releases[0]?.textContent).toContain("Added history");
		await act(async () => releases[1]?.querySelector("summary")?.click());
		expect(releases[1]?.open).toBe(true);
		expect(releases[1]?.textContent).toContain("Safer updates");

		await act(async () => root.unmount());
		const restoredRoot = createRoot(container);
		await view(restoredRoot, loadChangelog);
		expect(loadChangelog).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		await act(async () => findButton(container, "Open release notes").click());
		expect(loadChangelog).toHaveBeenCalledTimes(3);
		await act(async () => restoredRoot.unmount());
	});

	it("marks a newer changelog read when a refresh finishes while open", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const loadChangelog = vi
			.fn()
			.mockResolvedValueOnce({ schemaVersion: 1, releases: [CHANGELOG.releases[1]!] })
			.mockResolvedValueOnce(CHANGELOG);
		await view(root, loadChangelog);
		await act(async () => findButton(container, "Open unread release notes").click());
		expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		await act(async () => root.unmount());
	});

	it("keeps loading and failures inside the Popover and preserves loaded history", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const loadChangelog = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockRejectedValueOnce(new Error("still offline"))
			.mockResolvedValueOnce(CHANGELOG)
			.mockRejectedValueOnce(new Error("offline again"));
		await view(root, loadChangelog);
		await act(async () => {
			findButton(container, "Open release notes").click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not load release notes");

		await act(async () => findButton(container, "Close release notes").click());
		await act(async () => {
			findButton(container, "Open release notes").click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");

		await act(async () => findButton(container, "Close release notes").click());
		await act(async () => {
			findButton(container, "Open release notes").click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not load release notes");
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
		expect(document.querySelector(".system-notice")).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows local empty state and closes outside or on Escape with focus restored", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const empty = { schemaVersion: 1, releases: [] } as unknown as DesktopChangelog;
		await view(root, vi.fn().mockResolvedValue(empty));
		const trigger = findButton(container, "Open release notes");
		await act(async () => {
			trigger.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.querySelector('output, [role="status"]')?.textContent).toBe(
			"No release notes are available yet.",
		);
		await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => trigger.click());
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => root.unmount());
	});
});
