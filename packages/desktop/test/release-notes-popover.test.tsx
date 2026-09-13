// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RELEASE_NOTES_READ_VERSION_STORAGE_KEY,
	ReleaseNotesPopover,
} from "../src/renderer/components/ReleaseNotesPopover.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { DesktopUpdateState } from "../src/shared/desktop-api.ts";

const RELEASE_NOTES = "## Highlights\n\n- Added the bell\n- Improved updates";

function findButton(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function view(
	root: Root,
	state: DesktopUpdateState,
	overrides: Partial<{
		checking: boolean;
		checkFailure: "failed" | "unsupported" | null;
		onCheck: () => void;
		onUpdate: () => void;
	}> = {},
) {
	return act(async () => root.render(
		<ReleaseNotesPopover
			checking={overrides.checking ?? false}
			checkFailure={overrides.checkFailure ?? null}
			onCheck={overrides.onCheck ?? vi.fn()}
			onUpdate={overrides.onUpdate ?? vi.fn()}
			state={state}
		/>,
	));
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
	it("shows an unread dot, renders Markdown, and persists the opened version", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onCheck = vi.fn();
		await view(root, { status: "available", version: "0.81.0", releaseNotes: RELEASE_NOTES }, { onCheck });

		expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		await act(async () => findButton(container, "Open unread release notes").click());
		expect(onCheck).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="dialog"]')?.textContent).toContain("0.81.0");
		expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Added the bell");
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.81.0");

		await act(async () => findButton(container, "Open release notes").click());
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => root.unmount());
		const restoredRoot = createRoot(container);
		await view(restoredRoot, { status: "available", version: "0.81.0", releaseNotes: RELEASE_NOTES }, { onCheck });
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		await view(restoredRoot, { status: "available", version: "0.82.0", releaseNotes: "- Next release" }, { onCheck });
		expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		await act(async () => restoredRoot.unmount());
	});

	it("marks a release read when it arrives while the Popover is open", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await view(root, { status: "unavailable" }, { checking: true });
		await act(async () => findButton(container, "Open release notes").click());
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking for updates");
		await view(root, { status: "available", version: "0.81.0", releaseNotes: RELEASE_NOTES });
		expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.81.0");
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		await act(async () => root.unmount());
	});

	it("keeps the release unread when update progress changes without opening the Popover", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await view(root, { status: "available", version: "0.81.0", releaseNotes: RELEASE_NOTES });
		expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		await view(root, {
			status: "downloading",
			version: "0.81.0",
			releaseNotes: RELEASE_NOTES,
			progress: 42,
		});
		expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		await view(root, { status: "ready", version: "0.81.0", releaseNotes: RELEASE_NOTES });
		expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
		expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBeNull();
		await act(async () => root.unmount());
	});

	it("maps available, downloading, and ready states to the existing update action", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onUpdate = vi.fn();
		await view(root, { status: "available", version: "0.81.0", releaseNotes: RELEASE_NOTES }, { onUpdate });
		await act(async () => findButton(container, "Open unread release notes").click());
		await act(async () => findButton(container, "Update to new version").click());
		expect(onUpdate).toHaveBeenCalledOnce();

		await view(root, { status: "downloading", version: "0.81.0", releaseNotes: RELEASE_NOTES, progress: 42 }, { onUpdate });
		expect(findButton(container, "Downloading update 42%").disabled).toBe(true);
		await view(root, { status: "ready", version: "0.81.0", releaseNotes: RELEASE_NOTES }, { onUpdate });
		await act(async () => findButton(container, "Open installer").click());
		expect(onUpdate).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});

	it("closes outside or on Escape, restores trigger focus, and reports check failures accurately", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await view(root, { status: "unavailable" });
		const trigger = findButton(container, "Open release notes");
		await act(async () => trigger.click());
		await view(root, { status: "unavailable" }, { checkFailure: "failed" });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not check for updates");
		await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => trigger.click());
		await view(root, { status: "unavailable" }, { checkFailure: "unsupported" });
		expect(container.querySelector('[role="status"]')?.textContent).toBe(
			"Update checks are not supported in this build",
		);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => root.unmount());
	});

	it("explains when a legacy release has no notes", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await view(root, { status: "available", version: "0.81.0", releaseNotes: "" });
		await act(async () => findButton(container, "Open unread release notes").click());
		expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
			"Release notes are unavailable for this version.",
		);
		await act(async () => root.unmount());
	});
});
