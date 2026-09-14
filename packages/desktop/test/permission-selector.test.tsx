// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionSelector } from "../src/renderer/components/PermissionSelector.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

function mount(props: Partial<Parameters<typeof PermissionSelector>[0]> = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onChange = vi.fn().mockResolvedValue(undefined);
	act(() =>
		root.render(
			<PermissionSelector
				disabled={false}
				onChange={onChange}
				value="auto"
				{...props}
			/>,
		),
	);
	return { container, onChange, root };
}

async function openMenu(container: HTMLElement) {
	await act(async () => container.querySelector<HTMLButtonElement>(".composer-selector-trigger")!.click());
}

function option(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((candidate) =>
		candidate.querySelector("strong")?.textContent === label,
	);
	if (!match) throw new Error(`Missing option: ${label}`);
	return match;
}

describe("PermissionSelector", () => {
	it("describes sandboxed Ask/Auto and unrestricted Full", async () => {
		const { container } = mount({ value: "ask" });
		await openMenu(container);
		expect(option(container, "Ask").textContent).toContain(
			"Runs in the workspace sandbox and asks you when approval is needed.",
		);
		expect(option(container, "Auto").textContent).toContain(
			"Runs in the workspace sandbox. The current model reviews risky actions when needed.",
		);
		expect(option(container, "Full").textContent).toContain("Runs without a sandbox or tool approvals, including file deletion and network actions.");
		expect(container.textContent).not.toMatch(/without Metis approval/i);
		expect(container.textContent).not.toContain("Full access");
	});

	it("translates the same preset meanings in Chinese", async () => {
		await setLocale("zh-CN");
		const { container } = mount({
			activeReview: { actionId: "action-1", reviewer: "model", riskLevel: "high" },
			value: "auto",
		});
		expect(container.querySelector('[role="status"]')?.textContent).toBe("正在检查安全性…");
		await openMenu(container);
		expect(option(container, "询问").textContent).toContain("在工作区沙箱中运行，需要时向你询问。");
		expect(option(container, "自动").textContent).toContain(
			"在工作区沙箱中运行。当前模型会在需要时进行安全审查。",
		);
		expect(option(container, "完全访问").textContent).toContain("不使用沙箱，不弹工具审批；包括删除文件及联网操作。");
	});

	it("shows a parent ceiling without rewriting the saved preset", async () => {
		const { container, onChange } = mount({ constrainedByParent: true, value: "full" });
		expect(container.querySelector('[role="status"]')?.textContent).toContain("A parent session limits");
		await openMenu(container);
		expect(option(container, "Full").getAttribute("aria-checked")).toBe("true");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("disables Ask and Auto when the sandbox is unhealthy instead of falling back to the host", async () => {
		const { container, onChange } = mount({ sandboxHealth: "unavailable", value: "full" });
		expect(container.querySelector('[role="status"]')?.textContent).toContain("Ask and Auto stay disabled");
		expect(container.textContent).not.toMatch(/without Metis approval/i);
		await openMenu(container);
		expect(option(container, "Ask").disabled).toBe(true);
		expect(option(container, "Auto").disabled).toBe(true);
		expect(option(container, "Full").disabled).toBe(false);
		await act(async () => option(container, "Ask").click());
		expect(onChange).not.toHaveBeenCalled();
	});

	it("offers explicit Windows sandbox setup when the capability is provided", async () => {
		const onSetupSandbox = vi.fn().mockResolvedValue(undefined);
		const { container } = mount({ onSetupSandbox, sandboxHealth: "unavailable", value: "full" });
		await openMenu(container);
		const setup = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) => candidate.textContent?.includes("Set up Windows sandbox"),
		);
		expect(setup).toBeDefined();
		await act(async () => setup!.click());
		expect(onSetupSandbox).toHaveBeenCalledOnce();
	});

	it("announces model review without exposing hidden reasoning", async () => {
		const { container } = mount({
			activeReview: { actionId: "action-9", reviewer: "model", riskLevel: "critical" },
		});
		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).toBe("Checking security…");
		expect(container.textContent).not.toContain("action-9");
		expect(container.textContent).not.toMatch(/base64|reasoning|prompt/i);
	});

	it("opens from the keyboard, restores focus on Escape, and emits the selected preset", async () => {
		const previous = document.createElement("button");
		previous.textContent = "before";
		document.body.append(previous);
		previous.focus();
		const { container, onChange } = mount({ value: "ask" });
		const trigger = container.querySelector<HTMLButtonElement>(".composer-selector-trigger")!;
		await act(async () => trigger.focus());
		await act(async () => trigger.click());
		await act(async () => { await Promise.resolve(); });
		expect(document.activeElement).toBe(option(container, "Ask"));
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.activeElement).toBe(option(container, "Auto"));
		await act(async () => option(container, "Auto").click());
		expect(onChange).toHaveBeenCalledWith("auto");
		await act(async () => trigger.click());
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
