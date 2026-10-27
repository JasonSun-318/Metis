// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserImportDialog } from "../src/renderer/components/BrowserImportDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

let roots: Root[] = [];

const readySource = {
	sourceId: "chrome" as const,
	name: "Google Chrome",
	running: false,
	profiles: [
		{ sourceProfileId: "Default", name: "Personal", email: "person@example.com" },
		{ sourceProfileId: "Profile 2", name: "Work", email: "work@example.com" },
	],
};

function apiFixture(
	overrides: {
		running?: boolean;
		platform?: "darwin" | "win32";
		sources?: readonly unknown[];
		chooseBrowserImportDirectory?: (input: {
			sourceId: "chrome" | "edge" | "brave" | "chromium";
		}) => Promise<boolean>;
	} = {},
) {
	return {
		platform: overrides.platform ?? "darwin",
		listBrowserImportSources: vi.fn(
			async () =>
				overrides.sources ?? [
					{ ...readySource, ...(overrides.running === undefined ? {} : { running: overrides.running }) },
				],
		),
		importBrowserData: vi.fn(async () => ({
			profile: {
				profileId: "20000000-0000-4000-8000-000000000001",
				name: "Work",
				sourceId: "chrome" as const,
				sourceProfileId: "Profile 2",
			},
			cookies: { imported: 900, skipped: 4 },
			history: { accepted: 400, retained: 500 },
		})),
		...(overrides.chooseBrowserImportDirectory
			? { chooseBrowserImportDirectory: vi.fn(overrides.chooseBrowserImportDirectory) }
			: {}),
	} as unknown as MetisDesktopApi;
}

function renderDialog(api: MetisDesktopApi, onImported = vi.fn()) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(<BrowserImportDialog api={api} onCancel={vi.fn()} onImported={onImported} />));
	roots.push(root);
	return { container, onImported };
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

function button(container: ParentNode | null, label: string): HTMLButtonElement {
	const match = [...(container ?? document).querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function select(container: ParentNode, label: string, option: string) {
	const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	act(() => trigger.click());
	const item = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
		candidate.textContent?.includes(option),
	);
	expect(item).toBeDefined();
	act(() => item!.click());
}

function unmountLast() {
	const root = roots.pop();
	if (root) act(() => root.unmount());
	document.body.replaceChildren();
}

afterEach(() => {
	for (const root of roots) act(() => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

describe("BrowserImportDialog", () => {
	it("selects a Chromium profile and imports Cookies plus history from a legacy source without status", async () => {
		const api = apiFixture();
		const { container, onImported } = renderDialog(api);
		await flush();
		await select(container, "Source profile", "Work");
		await act(async () => button(container, "Import").click());
		expect(api.importBrowserData).toHaveBeenCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Profile 2",
			dataTypes: { cookies: true, history: true },
		});
		expect(onImported).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: expect.objectContaining({ sourceProfileId: "Profile 2" }),
			}),
		);
		expect(container.textContent).not.toMatch(/password|autofill/iu);
	});

	it("offers only browsing history on Windows", async () => {
		const api = apiFixture({ platform: "win32" });
		const { container } = renderDialog(api);
		await flush();

		expect(container.textContent).toContain("On Windows, Metis currently imports browsing history only.");
		expect(container.textContent).not.toContain("Import website sign-in state");
		expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]).toHaveLength(1);

		await act(async () => button(container, "Import").click());
		expect(api.importBrowserData).toHaveBeenCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		});
	});

	it("blocks import while the source browser is running", async () => {
		const { container } = renderDialog(apiFixture({ running: true }));
		await flush();
		expect(container.textContent).toContain("Close Google Chrome before importing");
		expect(button(container, "Import").disabled).toBe(true);
	});

	it("blocks import when the process check failed, the status is unknown, or running is not a boolean", async () => {
		for (const source of [
			{ ...readySource, status: "process-check-failed" },
			{ ...readySource, status: "unexpected-new-status" },
			{ ...readySource, running: "maybe" },
			{
				...readySource,
				status: "ready",
				diagnostic: { stage: "process", code: "TIMEOUT" },
			},
		]) {
			const api = apiFixture({ sources: [source] });
			const { container } = renderDialog(api);
			await flush();
			expect(container.textContent).toContain("Import is blocked");
			expect(button(container, "Import").disabled).toBe(true);
			expect(api.importBrowserData).not.toHaveBeenCalled();
			unmountLast();
		}
	});

	it("allows verified profiles recovered from missing or incompatible metadata", async () => {
		for (const code of ["ENOENT", "invalid-json", "invalid-schema"]) {
			const api = apiFixture({
				sources: [{ ...readySource, status: "ready", diagnostic: { stage: "local-state", code } }],
			});
			const { container } = renderDialog(api);
			await flush();
			expect(container.textContent).toContain("Profile names were recovered from folders");
			expect(button(container, "Import").disabled).toBe(false);
			expect(api.importBrowserData).not.toHaveBeenCalled();
			unmountLast();
		}
	});

	it("requires at least one selected data type", async () => {
		const { container } = renderDialog(apiFixture());
		await flush();
		for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
			act(() => checkbox.click());
		}
		expect(button(container, "Import").disabled).toBe(true);
	});

	it("orders ready sources ahead of unavailable ones and keeps them selectable", async () => {
		const api = apiFixture({
			sources: [
				{ ...readySource, status: "not-found", profiles: [] },
				{
					sourceId: "edge" as const,
					name: "Microsoft Edge",
					running: false,
					status: "ready",
					profiles: [{ sourceProfileId: "Default", name: "Main", email: null }],
				},
			],
		});
		const { container } = renderDialog(api);
		await flush();
		expect(container.querySelector<HTMLButtonElement>('button[aria-label="Source browser"]')?.textContent).toContain(
			"Microsoft Edge",
		);
		expect(button(container, "Import").disabled).toBe(false);
	});

	it("shows a detected browser's recovery state before browsers that are not installed", async () => {
		const api = apiFixture({
			sources: [
				{ ...readySource, sourceId: "edge", name: "Microsoft Edge", status: "not-found", profiles: [] },
				{ ...readySource, status: "permission-denied", profiles: [] },
			],
		});
		const { container } = renderDialog(api);
		await flush();
		expect(container.querySelector('button[aria-label="Source browser"]')?.textContent).toContain("Google Chrome");
		expect(container.textContent).toContain("does not have permission to read it");
		expect(button(container, "Import").disabled).toBe(true);
	});

	it("distinguishes missing, unreadable, permission-denied, invalid-metadata and no-profile sources", async () => {
		const cases: Array<{ status: string; expected: string; recovery: boolean }> = [
			{ status: "not-found", expected: "data was not found at the default location", recovery: true },
			{ status: "unreadable", expected: "was found, but Metis cannot read it", recovery: true },
			{ status: "permission-denied", expected: "does not have permission to read it", recovery: true },
			{ status: "invalid-metadata", expected: "profile information is invalid or incomplete", recovery: true },
			{ status: "no-profiles", expected: "has no usable profiles", recovery: true },
		];
		for (const { status, expected, recovery } of cases) {
			const api = apiFixture({
				sources: [{ ...readySource, status, profiles: status === "no-profiles" ? [] : readySource.profiles }],
			});
			const { container } = renderDialog(api);
			await flush();
			expect(container.textContent).toContain(expected);
			const choose = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
				(candidate) => candidate.textContent?.trim() === "Choose data folder",
			);
			expect(Boolean(choose)).toBe(recovery);
			unmountLast();
		}
	});

	it("recovers a permission-denied source through the trusted native chooser and never auto-imports", async () => {
		const choose = vi.fn(async () => true);
		const api = apiFixture({
			sources: [{ ...readySource, status: "permission-denied" }],
			chooseBrowserImportDirectory: choose,
		});
		vi.mocked(api.listBrowserImportSources)
			.mockResolvedValueOnce([{ ...readySource, status: "permission-denied" }])
			.mockResolvedValueOnce([{ ...readySource, status: "ready", location: "selected" }]);
		const { container } = renderDialog(api);
		await flush();
		expect(button(container, "Import").disabled).toBe(true);

		await act(async () => button(container, "Choose data folder").click());
		await flush();
		await flush();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(choose).toHaveBeenCalledWith({ sourceId: "chrome" });
		expect(api.importBrowserData).not.toHaveBeenCalled();
		expect(container.textContent).not.toContain("does not have permission to read it");
		expect(container.textContent).toContain("Using the folder you selected.");
		expect(button(container, "Import").disabled).toBe(false);
		expect(document.activeElement?.textContent).toMatch(/Check again|Choose data folder/);
	});

	it("keeps the current selection when the native chooser is cancelled", async () => {
		const choose = vi.fn(async () => false);
		const api = apiFixture({
			sources: [{ ...readySource, status: "not-found", profiles: [] }],
			chooseBrowserImportDirectory: choose,
		});
		const { container } = renderDialog(api);
		await flush();

		await act(async () => button(container, "Choose data folder").click());
		await flush();
		await flush();

		expect(choose).toHaveBeenCalledWith({ sourceId: "chrome" });
		expect(api.listBrowserImportSources).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("data was not found at the default location");
		expect(document.activeElement).toBe(button(container, "Choose data folder"));
	});

	it("preserves the chosen browser, profile and data checkboxes across a refresh", async () => {
		const api = apiFixture();
		const { container } = renderDialog(api);
		await flush();
		await select(container, "Source profile", "Work");
		act(() => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click());

		await act(async () => button(container, "Check again").click());
		await flush();

		expect(api.listBrowserImportSources).toHaveBeenCalledTimes(2);
		expect(container.querySelector<HTMLButtonElement>('button[aria-label="Source profile"]')?.textContent).toContain(
			"Work",
		);
		const after = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(after[0]!.checked).toBe(false);
		expect(after[1]!.checked).toBe(true);
	});

	it("starts only one import for a rapid double activation", async () => {
		const api = apiFixture();
		let resolveImport: ((value: unknown) => void) | undefined;
		vi.mocked(api.importBrowserData).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveImport = resolve;
			}) as never,
		);
		const { container, onImported } = renderDialog(api);
		await flush();

		await act(async () => {
			const importButton = button(container, "Import");
			importButton.click();
			importButton.click();
			await Promise.resolve();
		});
		expect(api.importBrowserData).toHaveBeenCalledOnce();

		await act(async () => {
			resolveImport?.({
				profile: {
					profileId: "20000000-0000-4000-8000-000000000001",
					name: "Personal",
					sourceId: "chrome",
					sourceProfileId: "Default",
				},
				cookies: { imported: 1, skipped: 0 },
				history: { accepted: 1, retained: 1 },
			});
			await Promise.resolve();
		});
		expect(onImported).toHaveBeenCalledOnce();
	});

	it("keeps focus on the recheck control and announces its loading status", async () => {
		const api = apiFixture();
		let resolveList: ((value: unknown) => void) | undefined;
		vi.mocked(api.listBrowserImportSources).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveList = resolve;
			}) as never,
		);
		const { container } = renderDialog(api);
		await flush();
		const recheck = button(container, "Check again");
		expect(recheck.disabled).toBe(false);
		recheck.focus();
		act(() => recheck.click());
		expect(document.activeElement).toBe(recheck);
		expect(container.querySelector("output")?.textContent).toContain("Checking browser data");
		await act(async () => {
			resolveList?.([{ ...readySource }]);
			await Promise.resolve();
		});
		await flush();
		expect(document.activeElement).toBe(recheck);
		expect(container.querySelector("output")).toBeNull();
	});

	it("keeps recheck available independently of any error", async () => {
		const api = apiFixture();
		vi.mocked(api.listBrowserImportSources).mockRejectedValueOnce(new Error("sources unavailable"));
		const { container } = renderDialog(api);
		await flush();

		expect(container.textContent).toContain("sources unavailable");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("sources unavailable");
		await act(async () => button(container, "Check again").click());
		await flush();
		expect(container.textContent).not.toContain("sources unavailable");
		expect(button(container, "Import").disabled).toBe(false);
	});

	it("hides diagnostic details behind a disclosure without secrets", async () => {
		const api = apiFixture({
			sources: [
				{
					...readySource,
					status: "unreadable",
					profiles: [],
					diagnostic: { stage: "local-state", code: "EPIPE" },
				},
			],
		});
		const { container } = renderDialog(api);
		await flush();

		const details = container.querySelector<HTMLDetailsElement>("details.browser-import-diagnostic");
		expect(details).not.toBeNull();
		expect(details?.open).toBe(false);
		act(() => details!.querySelector("summary")!.click());
		expect(details?.open).toBe(true);
		expect(details?.textContent).toContain("local-state");
		expect(details?.textContent).toContain("EPIPE");
		expect(container.textContent).not.toMatch(/password|secret|stack/iu);
		expect(container.querySelector("pre, code")).toBeNull();
	});

	it("ignores discovery responses that resolve after unmount", async () => {
		const api = apiFixture();
		let resolveList: ((value: unknown) => void) | undefined;
		vi.mocked(api.listBrowserImportSources).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveList = resolve;
			}) as never,
		);
		const { container } = renderDialog(api);
		unmountLast();
		await act(async () => {
			resolveList?.([{ ...readySource }]);
			await Promise.resolve();
		});
		expect(container.textContent).toBe("");
	});

	it("keeps the chosen source, profile and data types after an import failure", async () => {
		const api = apiFixture();
		vi.mocked(api.importBrowserData).mockRejectedValueOnce(new Error("import failed"));
		const { container, onImported } = renderDialog(api);
		await flush();
		await select(container, "Source profile", "Work");
		act(() => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click());

		await act(async () => button(container, "Import").click());
		await flush();

		expect(container.textContent).toContain("import failed");
		expect(container.querySelector<HTMLButtonElement>('button[aria-label="Source profile"]')?.textContent).toContain(
			"Work",
		);
		const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(checkboxes[0]!.checked).toBe(false);
		expect(checkboxes[1]!.checked).toBe(true);
		expect(onImported).not.toHaveBeenCalled();
		expect(api.listBrowserImportSources).toHaveBeenCalledOnce();

		expect(button(container, "Import").disabled).toBe(false);
		await act(async () => button(container, "Import").click());
		expect(api.importBrowserData).toHaveBeenCalledTimes(2);
		expect(api.importBrowserData).toHaveBeenLastCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Profile 2",
			dataTypes: { cookies: false, history: true },
		});
	});

	it("offers an explicit history-only retry after a cookie failure without silently changing choices", async () => {
		const api = apiFixture();
		vi.mocked(api.importBrowserData).mockRejectedValueOnce(new Error("Browser cookies could not be read"));
		const { container, onImported } = renderDialog(api);
		await flush();

		await act(async () => button(container, "Import").click());
		await flush();

		expect(container.textContent).toContain("Browser cookies could not be read");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Cookies could not be imported");
		expect(container.textContent).toContain(
			"Cookies could not be imported. Your selected data types were not changed.",
		);
		const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(checkboxes[0]!.checked).toBe(true);
		expect(checkboxes[1]!.checked).toBe(true);
		expect(onImported).not.toHaveBeenCalled();

		await act(async () => button(container, "Retry with history only").click());
		await flush();

		expect(api.importBrowserData).toHaveBeenLastCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		});
		const after = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(after[0]!.checked).toBe(false);
		expect(after[1]!.checked).toBe(true);
	});
});
