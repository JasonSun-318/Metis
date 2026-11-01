import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

test.describe.configure({ timeout: 240_000 });

/**
 * Isolated end-to-end coverage for the redesigned permission settings page.
 * Every launch uses the fixture's temporary HOME/agent/user-data and a fresh
 * project directory; no real user settings, approvals, or sessions are read.
 */

const tools: Parameters<typeof launchPermissionApp>[0]["tools"] = () => undefined;

async function readRules(app: Awaited<ReturnType<typeof launchPermissionApp>>) {
	return app.page.evaluate(async () => {
		const metis = (
			globalThis as unknown as {
				metis: {
					getPermissionAutoSettings(): Promise<{
						permissionRules?: readonly {
							readonly id: string;
							readonly name: string;
							readonly enabled: boolean;
						}[];
					}>;
				};
			}
		).metis;
		const view = await metis.getPermissionAutoSettings();
		return view.permissionRules ?? [];
	});
}

/** Last tool-result text the fake provider saw; surfaces the real tool output when a side effect is missing. */
function lastToolResult(app: Awaited<ReturnType<typeof launchPermissionApp>>): string {
	const payload = JSON.parse(
		[...app.provider.calls].reverse().find((call) => call.kind === "primary")?.payload ?? "{}",
	) as { messages?: readonly { role?: string; content?: unknown }[] };
	const tool = [...(payload.messages ?? [])].reverse().find((message) => message.role === "tool");
	return typeof tool?.content === "string" ? tool.content : JSON.stringify(tool?.content ?? null);
}

test("global commands remain compact and preserve non-command permissions", async ({}, testInfo) => {
	const app = await launchPermissionApp({ preset: "auto", tools });
	try {
		await app.openSettings("Permissions");
		const page = app.page;

		const initialRules = await readRules(app);
		await expect(page.locator(".permission-context-card")).toHaveCount(0);
		await expect(page.getByRole("tab", { name: /^Other actions/ })).toHaveCount(0);
		await expect(page.getByText("29 enabled", { exact: true })).toBeVisible();
		await expect(page.locator(".permission-rules-row")).toHaveCount(29);
		const region = page.locator(".permission-rules-scroll");
		const dimensions = await region.evaluate((element) => ({
			height: element.clientHeight, content: element.scrollHeight,
		}));
		expect(dimensions.height).toBeLessThanOrEqual(360);
		expect(dimensions.content).toBeGreaterThan(dimensions.height);
		const toolbar = page.locator(".permission-rules-toolbar");
		const toolbarBefore = await toolbar.boundingBox();
		await region.evaluate((element) => { element.scrollTop = element.scrollHeight; });
		expect((await toolbar.boundingBox())!.y).toBeCloseTo(toolbarBefore!.y, 0);
		await expect(toolbar.getByRole("button", { name: "Add command" })).toBeVisible();
		await region.evaluate((element) => { element.scrollTop = 0; });
		const addSize = await toolbar.getByRole("button", {name: "Add command"}).boundingBox();
		expect(addSize!.height).toBe(28);
		const inputStyle = await toolbar.locator("input").evaluate((element) => ({border: getComputedStyle(element).borderWidth, height: element.getBoundingClientRect().height}));
		expect(inputStyle).toEqual({border: "0px", height: 28});

		const catRow = page.locator('.permission-rules-row[data-rule-id="C04"]');
		await expect(catRow).toContainText("cat");
		await expect(catRow).toContainText("Auto");
		await expect(catRow).not.toContainText("Default");
		await expect(region).not.toContainText(app.projectDir);
		await page.setViewportSize({ width: 820, height: 760 });
		expect(
			await page.locator(".settings-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
		).toBe(true);
		const contrast = await catRow.locator(".permission-rule-mode").evaluate((element) => {
			const color = (value: string) => value.match(/[\d.]+/g)!.map(Number);
			const backgrounds: number[][] = [];
			for (let node: Element | null = element; node; node = node.parentElement)
				backgrounds.push(color(getComputedStyle(node).backgroundColor));
			let background = [255, 255, 255];
			for (const [r, g, b, a = 1] of backgrounds.reverse())
				background = [r!, g!, b!].map((channel, index) => channel * a + background[index]! * (1 - a));
			const foreground = color(getComputedStyle(element).color);
			const luminance = (channels: number[]) =>
				channels
					.slice(0, 3)
					.map((channel) => channel / 255)
					.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
					.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
			const text = luminance(foreground),
				surface = luminance(background);
			return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
		});
		expect(contrast).toBeGreaterThanOrEqual(4.5);

		await page.screenshot({ path: testInfo.outputPath("permissions-settings-narrow.png") });
		const editTrigger = page.getByRole("button", { name: "Edit cat", exact: true });
		await editTrigger.click();
		const editDialog = page.getByRole("dialog", { name: "Edit rule" });
		await expect(editDialog).toBeVisible();
		expect(await editDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
		for (let index = 0; index < 16; index += 1) {
			await page.keyboard.press("Tab");
			expect(await editDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
		}
		expect(
			await editDialog.evaluate((dialog) => {
				const bounds = dialog.getBoundingClientRect();
				return bounds.left >= 0 && bounds.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1;
			}),
		).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("permissions-rule-dialog-narrow.png") });
		await page.keyboard.press("Escape");
		await expect(editDialog).toHaveCount(0);
		await expect(editTrigger).toBeFocused();
		await page.setViewportSize({ width: 1280, height: 900 });

		// Search covers the complete collection without pagination.
		const search = page.getByRole("searchbox", { name: "Search commands" });
		await search.fill("git status");
		await expect(page.locator(".permission-rules-row")).toHaveCount(1);
		await expect(page.locator(".permission-rules-row")).toContainText("git status");
		await search.fill("");
		await expect(page.locator(".permission-rules-row")).toHaveCount(29);
		await expect(page.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0);

		// Direct deletion can be undone, and saves retain every hidden non-command record.
		await search.fill("pwd");
		await page.getByRole("button", { name: "Delete pwd", exact: true }).click();
		await expect(page.locator('.permission-rules-row[data-rule-id="C01"]')).toHaveCount(0);
		await page.getByRole("button", { name: "Undo", exact: true }).click();
		await expect(page.locator('.permission-rules-row[data-rule-id="C01"]')).toBeVisible();
		expect(await readRules(app)).toEqual(initialRules);
		await page.getByRole("button", { name: "Delete pwd", exact: true }).click();
		await expect.poll(async () => (await readRules(app)).some((rule) => rule.id === "C01")).toBe(false);
		expect(await readRules(app)).toEqual(initialRules.filter((rule) => rule.id !== "C01"));
		await page.getByRole("button", { name: "Rule list actions" }).click();
		await page.getByRole("menuitem", { name: "Restore default rules" }).click();
		const restoreDialog = page.getByRole("dialog", { name: "Restore default rules" });
		await expect(restoreDialog).toContainText("pwd");
		await restoreDialog.getByRole("button", { name: "Restore selected" }).click();
		await expect(page.locator('.permission-rules-row[data-rule-id="C01"]')).toBeVisible();

		await page.getByRole("button", { name: "Add command", exact: true }).click();
		const addDialog = page.getByRole("dialog", { name: "Add command", exact: true });
		await expect(addDialog.getByRole("textbox", { name: /^Command or argument prefix/ })).toBeVisible();
		await expect(addDialog.locator(".permission-rule-advanced")).not.toHaveAttribute("open", "");
		await addDialog.getByRole("button", { name: "Cancel", exact: true }).click();

		// Reviewer card opens the same approval-model dialog used by the Model page.
		await expect(page.getByText("No approval model configured", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Configure approval model" }).click();
		const reviewerDialog = page.getByRole("dialog", { name: "Approval model" });
		await expect(reviewerDialog).toBeVisible();
		await expect(reviewerDialog.getByRole("button", { name: "Save approval model" })).toBeVisible();
		await reviewerDialog.getByRole("button", { name: "Cancel" }).click();
		await expect(reviewerDialog).toHaveCount(0);

		await expect(page.getByRole("tab", { name: /^Current project:/ })).toHaveCount(0);
		const manage = page.getByRole("button", { name: "Manage remembered permissions" });
		await manage.click();
		const manager = page.getByRole("dialog", { name: "Remembered permissions", exact: true });
		await expect(manager).toContainText("No remembered permissions yet.");
		expect((await manager.boundingBox())!.width).toBeLessThanOrEqual(640);
		await expect(manager.locator("select, .remembered-permissions-toolbar, footer")).toHaveCount(0);
		await page.screenshot({path: testInfo.outputPath("remembered-empty.png")});
		await page.keyboard.press("Escape");
		await expect(manager).toHaveCount(0);
		await expect(manage).toBeFocused();
		await expect(page.getByRole("button", { name: "Run sandbox self-test", exact: true })).toBeVisible();
		const sandbox = page.locator(".sandbox-environment-card");
		const before = await sandbox.boundingBox();
		await sandbox.getByRole("button", {name: "Run sandbox self-test"}).click();
		await expect(sandbox.locator(".sandbox-environment-status")).toHaveText("Available", {timeout: 30000});
		expect((await sandbox.boundingBox())!.height).toBeCloseTo(before!.height, 0);
		await expect(sandbox.locator("details, ul, .sandbox-environment-notice")).toHaveCount(0);
		await page.screenshot({path: testInfo.outputPath("sandbox-available.png")});

	} finally {
		await app.close();
	}
});

test("visible rules control an already-open session and deletion survives restart", async () => {
	const app = await launchPermissionApp({
		preset: "auto",
		tools: (marker) =>
			marker.startsWith("case-visible-rules-") ? { name: "bash", arguments: { command: "ls -la" } } : undefined,
	});
	try {
		await app.submit("case-visible-rules-initial");
		await app.waitDone("case-visible-rules-initial");
		await expect(app.approval).toHaveCount(0);
		await app.page.locator(".execution-chain > summary").click();
		await expect(app.page.getByRole("button", { name: "View rule", exact: true })).toHaveCount(0);
        await app.openSettings("Permissions");
		await expect(app.page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
		const row = app.page.locator('.permission-rules-row[data-rule-id="C03"]');
		await expect(row).toBeVisible();
		await row.getByRole("button", { name: "Delete ls", exact: true }).click();
		await expect.poll(async () => (await readRules(app)).some((rule) => rule.id === "C03")).toBe(false);
		await app.closeSettings();
		await app.submit("case-visible-rules-disabled");
		await expect(app.approval).toBeVisible();
		await app.reject();
		await app.waitDone("case-visible-rules-disabled");
		await app.openSettings("Permissions");
		await app.closeSettings();
		await app.relaunch();
		expect((await readRules(app)).some((rule) => rule.id === "C03")).toBe(false);
		await app.submit("case-visible-rules-deleted");
		await expect(app.approval).toBeVisible();
		await app.reject();
		await app.waitDone("case-visible-rules-deleted");
		expect(app.provider.reviewCount).toBe(0);
	} finally {
		await app.close();
	}
});

for (const preset of ["ask", "auto"] as const) {
	test(`OfficeCLI keeps its existing permission and executes in ${preset}`, async () => {
		const app = await launchPermissionApp({
			preset,
			tools: (marker) =>
				marker === "case-officecli-default"
					? { name: "bash", arguments: { command: "officecli create office-permission.docx" } }
					: undefined,
		});
		try {
			await app.submit("case-officecli-default");
			await app.waitDone("case-officecli-default");
			await expect(app.approval).toHaveCount(0);
			// On failure the ENOENT alone hides why officecli did not write the
			// file; rethrow with the sandboxed command's real tool result instead.
			let docx: Buffer;
			try {
				docx = readFileSync(path.join(app.projectDir, "office-permission.docx"));
			} catch (error) {
				throw new Error(`office-permission.docx was not created; last tool result: ${lastToolResult(app)}`, {
					cause: error,
				});
			}
			expect(docx.subarray(0, 2).toString()).toBe("PK");
			await expect(app.page.locator(".tool-permission-source")).toHaveCount(0);
			expect(app.provider.reviewCount).toBe(0);
		} finally {
			await app.close();
		}
	});
}

test("Chinese permission controls remain compact in both themes", async ({}, testInfo) => {
	const app = await launchPermissionApp({ preset: "auto", tools, locale: "zh-CN" });
	try {
		const page = app.page;
		await page.setViewportSize({ width: 1440, height: 1100 });
		await page.locator(".account-menu-trigger").click();
		await page.getByRole("menuitem", {name: "设置", exact: true}).click();
		const navigation = page.locator(".settings-navigation");
		await navigation.getByRole("button", {name: "权限", exact: true}).click();
		await expect(page.getByRole("button", {name: "添加命令", exact: true})).toBeVisible();
		await page.locator(".sandbox-environment-card button").click();
		await expect(page.locator(".sandbox-environment-status")).toHaveText("可用", {timeout: 30000});
		await page.screenshot({path: testInfo.outputPath("permissions-zh-dark.png")});
		await navigation.getByRole("button", {name: "通用", exact: true}).click();
		await page.getByRole("group", {name: "外观", exact: true}).getByRole("button", {name: "浅色", exact: true}).click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
		await navigation.getByRole("button", {name: "权限", exact: true}).click();
		await page.screenshot({path: testInfo.outputPath("permissions-zh-light.png")});
		await page.getByRole("button", {name: "管理记住的授权", exact: true}).click();
		const dialog = page.getByRole("dialog", {name: "记住的授权", exact: true});
		await expect(dialog).toBeVisible();
		expect((await dialog.boundingBox())!.width).toBe(640);
		await page.screenshot({path: testInfo.outputPath("remembered-zh-light.png")});
	} finally { await app.close(); }
});
