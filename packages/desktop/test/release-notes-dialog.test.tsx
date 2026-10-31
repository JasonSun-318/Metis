// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RELEASE_NOTES_READ_VERSION_STORAGE_KEY,
	ReleaseNotesDialog,
} from "../src/renderer/components/ReleaseNotesDialog.tsx";
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
		...document.querySelectorAll<HTMLButtonElement>(".release-notes-dialog button"),
	].find((button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function view(root: Root, loadChangelog: () => Promise<DesktopChangelog>) {
	await act(async () => root.render(<ReleaseNotesDialog loadChangelog={loadChangelog} />));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function AccountMenuHarness({
	loadChangelog,
	availableVersion,
	onUnreadChange,
}: {
	readonly loadChangelog: () => Promise<DesktopChangelog>;
	readonly availableVersion?: string;
	readonly onUnreadChange: (unread: boolean) => void;
}) {
	const accountRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	return (
		<>
			<button onClick={() => setOpen((previous) => !previous)} ref={accountRef} type="button">
				Account
			</button>
			<div aria-hidden={!open} hidden={!open} inert={!open} role="menu">
				<ReleaseNotesDialog
					availableVersion={availableVersion}
					loadChangelog={loadChangelog}
					onOpen={() => setOpen(false)}
					onUnreadChange={onUnreadChange}
					returnFocusRef={accountRef}
					variant="menu"
				/>
			</div>
		</>
	);
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

describe("ReleaseNotesDialog", () => {
	it.each(["Escape", "close button"])(
		"keeps the dialog outside a hidden menu and returns focus to its persistent anchor on %s",
		async (dismiss) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const onUnreadChange = vi.fn();
			const loadChangelog = vi.fn().mockResolvedValue(CHANGELOG);
			vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
			vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
			try {
				await act(async () =>
					root.render(<AccountMenuHarness loadChangelog={loadChangelog} onUnreadChange={onUnreadChange} />),
				);
				const account = findButton(container, "Account");
				const notifications = findButton(container, "Notifications");
				const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
				expect(onUnreadChange).toHaveBeenLastCalledWith(true);
				expect(notifications.getAttribute("role")).toBe("menuitem");
				expect(notifications.className).toBe("account-menu-item account-menu-notifications");
				expect(notifications.querySelector(".account-menu-item-dot")).not.toBeNull();
				expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBeNull();
				await act(async () => account.click());
				expect(menu.hidden).toBe(false);
				expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBeNull();
				await act(async () => notifications.click());
				const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
				expect(menu.hidden).toBe(true);
				expect(menu.hasAttribute("inert")).toBe(true);
				expect(menu.getAttribute("aria-hidden")).toBe("true");
				expect(panel.parentElement?.parentElement).toBe(document.body);
				expect(panel.getAttribute("aria-modal")).toBe("true");
				expect(panel.textContent).toContain("Added history");
				expect(document.activeElement).toBe(findButton(panel, "Close release notes"));
				expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
				expect(onUnreadChange).toHaveBeenLastCalledWith(false);
				expect(notifications.getAttribute("aria-label")).toBe("Notifications");
				if (dismiss === "Escape") {
					const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
					const parentEscape = vi.fn();
					const onKeyDown = (event: KeyboardEvent) => {
						if (event.key === "Escape" && !event.defaultPrevented) parentEscape();
					};
					document.addEventListener("keydown", onKeyDown);
					try {
						await act(async () => findButton(panel, "Close release notes").dispatchEvent(escapeEvent));
						expect(escapeEvent.defaultPrevented).toBe(true);
						expect(parentEscape).not.toHaveBeenCalled();
					} finally {
						document.removeEventListener("keydown", onKeyDown);
					}
				} else await act(async () => findButton(panel, "Close release notes").click());
				expect(document.querySelector('[role="dialog"]')).toBeNull();
				expect(document.activeElement).toBe(account);
				expect(menu.hidden).toBe(true);
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it.each(["failure", "stale history"])(
		"reports a newer menu notification unread through %s and acknowledges only displayed history",
		async (result) => {
			localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, "0.81.0");
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const onUnreadChange = vi.fn();
			const oldHistory: DesktopChangelog = { schemaVersion: 1, releases: [CHANGELOG.releases[1]!] };
			const loadChangelog = vi.fn().mockResolvedValue(oldHistory);
			try {
				await act(async () =>
					root.render(
						<AccountMenuHarness
							loadChangelog={loadChangelog}
							availableVersion="0.83.0"
							onUnreadChange={onUnreadChange}
						/>,
					),
				);
				if (result === "failure") loadChangelog.mockRejectedValue(new Error("offline"));
				await act(async () => findButton(container, "Account").click());
				await act(async () => findButton(container, "Notifications").click());
				expect(onUnreadChange).toHaveBeenLastCalledWith(true);
				expect(container.querySelector(".account-menu-item-dot")).not.toBeNull();
				expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.81.0");
				await act(async () => findButton(container, "Close release notes").click());
				loadChangelog.mockResolvedValue(CHANGELOG);
				await act(async () => findButton(container, "Account").click());
				await act(async () => findButton(container, "Notifications").click());
				expect(document.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
				expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
				expect(onUnreadChange).toHaveBeenLastCalledWith(true);
				await act(async () => findButton(container, "Close release notes").click());
				loadChangelog.mockResolvedValue({
					schemaVersion: 1,
					releases: [{ version: "0.83.0", notes: "Published latest" }],
				});
				await act(async () => findButton(container, "Account").click());
				await act(async () => findButton(container, "Notifications").click());
				expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.83.0");
				expect(onUnreadChange).toHaveBeenLastCalledWith(false);
				expect(container.querySelector(".account-menu-item-dot")).toBeNull();
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it("reuses cached menu history without marking it read until the notification dialog opens", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		let root = createRoot(container);
		const loadChangelog = vi.fn().mockResolvedValue(CHANGELOG);
		const onUnreadChange = vi.fn();
		try {
			await act(async () =>
				root.render(<AccountMenuHarness loadChangelog={loadChangelog} onUnreadChange={onUnreadChange} />),
			);
			await act(async () => root.unmount());
			root = createRoot(container);
			await act(async () =>
				root.render(<AccountMenuHarness loadChangelog={loadChangelog} onUnreadChange={onUnreadChange} />),
			);
			expect(loadChangelog).toHaveBeenCalledOnce();
			expect(onUnreadChange).toHaveBeenLastCalledWith(true);
			await act(async () => findButton(container, "Account").click());
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBeNull();
			expect(loadChangelog).toHaveBeenCalledOnce();
			await act(async () => findButton(container, "Notifications").click());
			expect(loadChangelog).toHaveBeenCalledTimes(2);
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
			expect(onUnreadChange).toHaveBeenLastCalledWith(false);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("switches the reader without remounting the dialog and closes from the backdrop", async () => {
		const container = document.createElement("div");
		container.style.overflow = "hidden";
		document.body.append(container);
		const root = createRoot(container);
		try {
			await view(root, vi.fn().mockResolvedValue(CHANGELOG));
			const trigger = findButton(container, "Open unread release notes");
			await act(async () => trigger.click());
			const panel = document.querySelector<HTMLElement>(".release-notes-dialog")!;
			const reader = panel.querySelector<HTMLElement>(".release-notes-reader")!;
			expect(panel.closest("[hidden], [inert]")).toBeNull();
			reader.scrollTop = 100;
			await act(async () => findButton(panel, "Version 0.81.0").click());
			expect(document.querySelector(".release-notes-dialog")).toBe(panel);
			expect(reader.scrollTop).toBe(0);
			expect(reader.textContent).toContain("Safer updates");
			expect(reader.textContent).not.toContain("Added history");
			await act(async () => reader.dispatchEvent(new Event("pointerdown", { bubbles: true })));
			expect(document.querySelector(".release-notes-dialog")).toBe(panel);
			await act(async () => panel.parentElement!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
			expect(document.querySelector(".release-notes-dialog")).toBeNull();
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
				root.render(<ReleaseNotesDialog loadChangelog={loadChangelog} availableVersion="0.82.0" />),
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
				root.render(<ReleaseNotesDialog loadChangelog={loadChangelog} availableVersion="0.82.0" />),
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
				root.render(<ReleaseNotesDialog loadChangelog={loadChangelog} availableVersion="0.82.0" />),
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

		const releases = [...document.querySelectorAll<HTMLButtonElement>(".release-notes-version")];
		expect(releases.map((release) => release.textContent)).toEqual(["Version 0.82.0Latest", "Version 0.81.0"]);
		expect(releases[0]?.getAttribute("aria-current")).toBe("page");
		expect(releases[1]?.hasAttribute("aria-current")).toBe(false);
		expect(document.querySelector(".release-notes-reader")?.textContent).toContain("Added history");
		await act(async () => releases[1]?.click());
		expect(releases[1]?.getAttribute("aria-current")).toBe("page");
		expect(document.querySelector(".release-notes-reader")?.textContent).toContain("Safer updates");

		await act(async () => root.unmount());
		const restoredRoot = createRoot(container);
		await view(restoredRoot, loadChangelog);
		expect(loadChangelog).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		await act(async () => findButton(container, "Open release notes").click());
		expect(loadChangelog).toHaveBeenCalledTimes(3);
		await act(async () => restoredRoot.unmount());
	});

	it("keeps a newly published version unread while an older release is selected", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const loadChangelog = vi.fn().mockResolvedValue(CHANGELOG);
		try {
			await view(root, loadChangelog);
			await act(async () => findButton(container, "Open unread release notes").click());
			await act(async () => findButton(container, "Version 0.81.0").click());
			const reader = document.querySelector<HTMLElement>(".release-notes-reader")!;
			reader.scrollTop = 80;
			loadChangelog.mockResolvedValue({
				...CHANGELOG,
				releases: [{ version: "0.83.0", notes: "New publication" }, ...CHANGELOG.releases],
			});
			await act(async () =>
				root.render(<ReleaseNotesDialog loadChangelog={loadChangelog} availableVersion="0.83.0" />),
			);
			expect(reader.textContent).toContain("Safer updates");
			expect(reader.scrollTop).toBe(80);
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.82.0");
			expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
			await act(async () => findButton(container, "Version 0.83.0").click());
			expect(reader.textContent).toContain("New publication");
			expect(localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY)).toBe("0.83.0");
			expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("retries a failed load inside the modal without closing it", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const loadChangelog = vi.fn().mockRejectedValue(new Error("offline"));
		try {
			await view(root, loadChangelog);
			await act(async () => findButton(container, "Open release notes").click());
			const panel = document.querySelector(".release-notes-dialog");
			expect(panel?.querySelector('[role="alert"]')?.textContent).toContain("Could not load release notes");
			loadChangelog.mockResolvedValue(CHANGELOG);
			await act(async () => findButton(container, "Retry").click());
			expect(document.querySelector(".release-notes-dialog")).toBe(panel);
			expect(panel?.querySelector('[role="alert"]')).toBeNull();
			expect(panel?.textContent).toContain("Added history");
		} finally {
			await act(async () => root.unmount());
		}
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
		await act(async () =>
			document.querySelector(".modal-backdrop")!.dispatchEvent(new Event("pointerdown", { bubbles: true })),
		);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => trigger.click());
		await act(async () =>
			findButton(container, "Close release notes").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
			),
		);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => root.unmount());
	});
});
