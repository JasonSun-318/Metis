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

	it("shows a New agent type heading with Back and bottom Cancel then Save", async () => {
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "New agent type")!.click());

		expect(container.querySelector(".settings-section-heading h3")?.textContent).toBe("New agent type");
		expect(button(container, "Back to agent types")).toBeDefined();
		const actions = [...container.querySelectorAll<HTMLButtonElement>(".agent-types-actions button")];
		expect(actions.map((action) => action.textContent?.trim())).toEqual(["Cancel", "Save"]);

		await act(async () => button(container, "Back to agent types")!.click());
		expect(container.textContent).toContain("Built-in agent types");
		expect(container.querySelector(".settings-section-heading h3")).toBeNull();
	});

	it("duplicates into a new editor with a readable context and editable slug", async () => {
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "Duplicate explorer")!.click());

		expect(container.querySelector(".settings-section-heading h3")?.textContent).toBe("New agent type");
		const inputs = [...container.querySelectorAll<HTMLInputElement>(".agent-types-field > input")];
		expect(inputs[0]?.value).toBe("explorer");
		expect(inputs[1]?.value).toBe("");
		expect(inputs[1]?.disabled).toBe(false);
	});

	it("edits an existing type under an Edit agent type heading and goes back", async () => {
		const desktopApi = agentTypesApi();
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "Edit Auditor")!.click());

		expect(container.querySelector(".settings-section-heading h3")?.textContent).toBe("Edit agent type");
		const inputs = [...container.querySelectorAll<HTMLInputElement>(".agent-types-field > input")];
		expect(inputs[0]?.value).toBe("Auditor");
		expect(inputs[1]?.value).toBe("auditor");
		expect(inputs[1]?.disabled).toBe(true);
		expect(button(container, "Back to agent types")).toBeDefined();

		await act(async () => button(container, "Back to agent types")!.click());
		expect(container.textContent).toContain("Auditor");
		expect(container.textContent).toContain("Built-in agent types");
	});

	it("shows a failed deletion in the list and keeps the item", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const desktopApi = agentTypesApi({
			removeAgentType: vi.fn().mockRejectedValue(new Error("delete failed")),
		});
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "Delete Auditor")!.click());
		await flush();

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t delete the agent type.");
		expect(button(container, "Edit Auditor")).toBeDefined();
		expect(container.textContent).toContain("Auditor");

		await act(async () => button(container, "Edit Auditor")!.click());
		expect(container.querySelector('[role="alert"]')).toBeNull();
		await act(async () => button(container, "Back to agent types")!.click());
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("keeps the failed save draft inside the editor", async () => {
		const desktopApi = agentTypesApi({
			upsertAgentType: vi.fn().mockRejectedValue(new Error("save failed")),
		});
		const { container } = renderPanel(desktopApi);
		await flush();

		await act(async () => button(container, "New agent type")!.click());
		const inputs = [...container.querySelectorAll<HTMLInputElement>(".agent-types-field > input")];
		await act(async () => {
			typeInput(inputs[0]!, "Code Reviewer");
			typeInput(inputs[1]!, "code-reviewer");
		});
		await act(async () => button(container, "Save")!.click());
		await flush();

		expect(container.querySelector(".agent-types-form-error")?.textContent).toContain(
			"Couldn’t save the agent type.",
		);
		expect(inputs[0]?.value).toBe("Code Reviewer");
		expect(inputs[1]?.value).toBe("code-reviewer");
		expect(container.querySelector(".settings-section-heading h3")?.textContent).toBe("New agent type");
		expect(button(container, "Back to agent types")).toBeDefined();
	});
});
