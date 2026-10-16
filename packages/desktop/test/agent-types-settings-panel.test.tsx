// @vitest-environment jsdom

import type { CustomAgentTypeView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypesSettingsPanel } from "../src/renderer/components/AgentTypesSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

function typeView(overrides: Partial<CustomAgentTypeView> & { id: string }): CustomAgentTypeView {
	return {
		displayName: overrides.id,
		description: `${overrides.id} description`,
		allowedTools: ["read"],
		systemPrompt: "",
		writePolicy: "inherit",
		mayDelegate: false,
		builtIn: true,
		...overrides,
	};
}

function button(container: ParentNode, label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
}

function typeInput(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

let roots: Root[] = [];

function renderPanel(api: MetisDesktopApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	void act(() => root.render(<AgentTypesSettingsPanel api={api} serverReady />));
	roots.push(root);
	return { container };
}

function agentTypesApi(overrides: Partial<MetisDesktopApi> = {}): MetisDesktopApi {
	return {
		listAgentTypes: vi.fn().mockResolvedValue({
			types: [
				typeView({ id: "default" }),
				typeView({ id: "explorer", allowedTools: ["read", "grep"] }),
				typeView({ id: "auditor", builtIn: false, displayName: "Auditor" }),
			],
		}),
		upsertAgentType: vi.fn().mockImplementation(async ({ type }) => ({ type: { ...type, builtIn: false } })),
		removeAgentType: vi.fn().mockResolvedValue({ id: "auditor" }),
		...overrides,
	} as unknown as MetisDesktopApi;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("AgentTypesSettingsPanel", () => {
	it("lists built-in types read-only and custom types with edit and delete", async () => {
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		expect(container.textContent).toContain("Built-in agent types");
		expect(container.textContent).toContain("Custom agent types");
		expect(container.textContent).toContain("Auditor");
		expect(button(container, "Delete default")).toBeUndefined();
		expect(button(container, "Duplicate explorer")).toBeDefined();
		expect(button(container, "Edit Auditor")).toBeDefined();
		expect(button(container, "Delete Auditor")).toBeDefined();
	});

	it("creates a custom type through the form with a slug id", async () => {
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "New agent type")!.click());
		const inputs = [...container.querySelectorAll<HTMLInputElement>(".agent-types-field > input")];
		const [displayNameInput, idInput] = inputs;
		await act(async () => {
			typeInput(displayNameInput!, "Code Reviewer");
			typeInput(idInput!, "code-reviewer");
		});
		await act(async () => button(container, "Save")!.click());
		await flush();

		expect(desktopApi.upsertAgentType).toHaveBeenCalledWith(
			expect.objectContaining({
				type: expect.objectContaining({ id: "code-reviewer", displayName: "Code Reviewer" }),
			}),
		);
	});

	it("rejects an invalid slug locally without calling the server", async () => {
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "New agent type")!.click());
		const inputs = [...container.querySelectorAll<HTMLInputElement>(".agent-types-field > input")];
		await act(async () => {
			typeInput(inputs[0]!, "Broken");
			typeInput(inputs[1]!, "Bad_Slug");
		});
		await act(async () => button(container, "Save")!.click());
		await flush();

		expect(desktopApi.upsertAgentType).not.toHaveBeenCalled();
		expect(container.querySelector(".agent-types-form-error")?.textContent).toContain("lowercase");
	});

	it("deletes a custom type after confirmation", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "Delete Auditor")!.click());
		await flush();

		expect(confirmSpy).toHaveBeenCalled();
		expect(desktopApi.removeAgentType).toHaveBeenCalledWith(expect.objectContaining({ id: "auditor" }));
	});
});
