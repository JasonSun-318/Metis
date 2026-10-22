// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserImportDialog } from "../src/renderer/components/BrowserImportDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

let roots: Root[] = [];

function apiFixture(running = false, platform: "darwin" | "win32" = "darwin") {
	return {
		platform,
		listBrowserImportSources: vi.fn(async () => [
			{
				sourceId: "chrome" as const,
				name: "Google Chrome",
				running,
				profiles: [
					{ sourceProfileId: "Default", name: "Personal", email: "person@example.com" },
					{ sourceProfileId: "Profile 2", name: "Work", email: "work@example.com" },
				],
			},
		]),
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

async function select(container: ParentNode, label: string, option: string) {
	const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	act(() => trigger.click());
	const item = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
		candidate.textContent?.includes(option),
	);
	expect(item).toBeDefined();
	act(() => item!.click());
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
	it("selects a Chromium profile and imports Cookies plus history", async () => {
		const api = apiFixture();
		const { container, onImported } = renderDialog(api);
		await flush();
		await select(container, "Source profile", "Work");
		const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		await act(async () => importButton.click());
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
		const api = apiFixture(false, "win32");
		const { container } = renderDialog(api);
		await flush();

		expect(container.textContent).toContain("On Windows, Metis currently imports browsing history only.");
		expect(container.textContent).not.toContain("Import website sign-in state");
		expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]).toHaveLength(1);

		const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		await act(async () => importButton.click());
		expect(api.importBrowserData).toHaveBeenCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		});
	});

	it("blocks import while the source browser is running", async () => {
		const { container } = renderDialog(apiFixture(true));
		await flush();
		expect(container.textContent).toContain("Close Google Chrome before importing");
		const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		expect(importButton.disabled).toBe(true);
	});

	it("requires at least one selected data type", async () => {
		const { container } = renderDialog(apiFixture());
		await flush();
		for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
			act(() => checkbox.click());
		}
		const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		expect(importButton.disabled).toBe(true);
	});

	it("retries a failed source discovery and restores the importable selection", async () => {
		const api = apiFixture();
		vi.mocked(api.listBrowserImportSources).mockRejectedValueOnce(new Error("sources unavailable"));
		const { container } = renderDialog(api);
		await flush();

		expect(container.textContent).toContain("sources unavailable");
		expect(api.listBrowserImportSources).toHaveBeenCalledOnce();

		const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Retry",
		);
		expect(retry).toBeDefined();
		await act(async () => retry!.click());
		await flush();

		expect(container.textContent).not.toContain("sources unavailable");
		const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		expect(importButton.disabled).toBe(false);
		await act(async () => importButton.click());
		expect(api.importBrowserData).toHaveBeenCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: true, history: true },
		});
	});

	it("keeps the chosen source, profile and data types after an import failure", async () => {
		const api = apiFixture();
		vi.mocked(api.importBrowserData).mockRejectedValueOnce(new Error("import failed"));
		const { container, onImported } = renderDialog(api);
		await flush();
		await select(container, "Source profile", "Work");
		const cookies = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!;
		act(() => cookies.click());

		const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		await act(async () => importButton.click());
		await flush();

		expect(container.textContent).toContain("import failed");
		expect(container.querySelector<HTMLButtonElement>('button[aria-label="Source profile"]')?.textContent).toContain(
			"Work",
		);
		expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.checked).toBe(false);
		expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.checked).toBe(true);
		expect(onImported).not.toHaveBeenCalled();
		expect(api.listBrowserImportSources).toHaveBeenCalledOnce();

		const retryImport = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Import",
		)!;
		expect(retryImport.disabled).toBe(false);
		await act(async () => retryImport.click());
		expect(api.importBrowserData).toHaveBeenCalledTimes(2);
		expect(api.importBrowserData).toHaveBeenLastCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Profile 2",
			dataTypes: { cookies: false, history: true },
		});
		expect(api.listBrowserImportSources).toHaveBeenCalledOnce();
	});
});
