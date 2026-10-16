// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../src/renderer/components/AppErrorBoundary.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const mounted: Array<{ host: HTMLDivElement; unmount: () => void }> = [];

beforeEach(async () => {
	await setLocale("en");
});

afterEach(() => {
	for (const entry of mounted.splice(0)) {
		act(() => entry.unmount());
		entry.host.remove();
	}
	vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
	it("replaces a crashing renderer subtree with a localized recovery action", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		mounted.push({ host, unmount: () => root.unmount() });

		function Crash(): never {
			throw new Error("renderer exploded");
		}

		await act(async () => {
			root.render(
				<AppErrorBoundary>
					<Crash />
				</AppErrorBoundary>,
			);
		});

		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Metis encountered an unexpected error.");
		expect(host.querySelector("button")?.textContent).toBe("Reload Metis");
		expect(host.textContent).not.toContain("renderer exploded");
	});
});
