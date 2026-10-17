import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfigurationCoordinator as HostMcpConfigurationCoordinator } from "../src/host.ts";
import {
	AuthStorage,
	initTheme,
	McpConfigurationCoordinator,
	type RenderDiffOptions,
	renderDiff,
	ShowImagesSelectorComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
} from "../src/index.ts";

describe("public SDK compatibility", () => {
	beforeEach(() => initTheme("dark"));

	it("keeps the image selector constructor and callbacks", () => {
		const select = vi.fn();
		const cancel = vi.fn();
		const component = new ShowImagesSelectorComponent(false, select, cancel);
		const list = component.getSelectList();
		expect(list.getSelectedItem()?.value).toBe("no");
		list.handleInput("\u001b[A");
		list.handleInput("\r");
		expect(select).toHaveBeenCalledExactlyOnceWith(true);
		list.handleInput("\u001b");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps the thinking selector constructor and callbacks", () => {
		const select = vi.fn();
		const cancel = vi.fn();
		const component = new ThinkingSelectorComponent("low", ["off", "low", "high"], select, cancel);
		const list = component.getSelectList();
		expect(list.getSelectedItem()?.value).toBe("low");
		list.handleInput("\u001b[B");
		list.handleInput("\r");
		expect(select).toHaveBeenCalledExactlyOnceWith("high");
		list.handleInput("\u001b");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps theme selection, preview and cancellation callbacks", () => {
		const select = vi.fn();
		const cancel = vi.fn();
		const preview = vi.fn();
		const component = new ThemeSelectorComponent("dark", select, cancel, preview);
		const list = component.getSelectList();
		expect(list.getSelectedItem()?.value).toBe("dark");
		list.handleInput("\u001b[B");
		const selectedTheme = list.getSelectedItem()?.value;
		expect(selectedTheme).not.toBe("dark");
		expect(preview).toHaveBeenCalledExactlyOnceWith(selectedTheme);
		list.handleInput("\r");
		expect(select).toHaveBeenCalledExactlyOnceWith(selectedTheme);
		list.handleInput("\u001b");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("accepts the legacy diff options", () => {
		const diff = "-1 old\n+1 new";
		const options: RenderDiffOptions = { filePath: "legacy.ts" };
		expect(renderDiff(diff, options)).toBe(renderDiff(diff));
	});

	it("keeps diagnostics available through the root and host entry points", () => {
		expect(HostMcpConfigurationCoordinator).toBe(McpConfigurationCoordinator);
		const coordinator = new HostMcpConfigurationCoordinator({ authStorage: AuthStorage.inMemory() });
		expect(coordinator.drainDiagnostics()).toEqual([]);
	});
});
