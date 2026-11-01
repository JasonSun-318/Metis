import { expect, type Locator, test } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

test.describe.configure({ timeout: 180_000 });

/**
 * Disclosure and tab-panel heights animate through CSS transitions
 * (`::details-content` block-size and `.model-provider-section` block-size)
 * that Chrome does not expose through getAnimations(), so they cannot be
 * paused and seeked like element animations. The transition timeline only
 * advances on rendered frames, which makes a 220ms token produce two or three
 * samples under a software renderer. Stretch the product's own
 * --motion-duration-switch for the sample window instead: the real transition
 * and easing still run, but every frame in the window sees an intermediate
 * height regardless of the achieved frame rate.
 */
const SLOW_MOTION_MS = 1_000;
const SLOW_MOTION_WINDOW_MS = SLOW_MOTION_MS + 120;

async function sampleDisclosure(row: Locator, reverse = false) {
	return row.evaluate(
		async (element, options) => {
			const dialog = element.closest<HTMLElement>(".model-provider-dialog");
			const previous = dialog?.style.getPropertyValue("--motion-duration-switch") ?? "";
			dialog?.style.setProperty("--motion-duration-switch", `${options.duration}ms`);
			try {
				const summary = element.querySelector<HTMLElement>("summary")!;
				const samples = [element.getBoundingClientRect().height];
				summary.click();
				const start = performance.now();
				let reversedAt: number | null = null;
				do {
					await new Promise(requestAnimationFrame);
					samples.push(element.getBoundingClientRect().height);
					if (options.reverse && reversedAt === null && performance.now() - start > 65) {
						summary.click();
						reversedAt = performance.now();
					}
					// A reverse click can land well after 65ms on a slow renderer, so give
					// the closing transition a full window from the click that started it.
				} while (performance.now() < (reversedAt ?? start) + options.window);
				return samples;
			} finally {
				if (dialog) {
					if (previous) dialog.style.setProperty("--motion-duration-switch", previous);
					else dialog.style.removeProperty("--motion-duration-switch");
				}
			}
		},
		{ reverse, duration: SLOW_MOTION_MS, window: SLOW_MOTION_WINDOW_MS },
	);
}

function expectIntermediateFrames(samples: number[]) {
	const low = Math.min(...samples);
	const high = Math.max(...samples);
	expect(high - low).toBeGreaterThan(30);
	expect(samples.filter((value) => value > low + 2 && value < high - 2).length).toBeGreaterThan(2);
}

async function expectCompactActions(root: Locator) {
	await expect(
		root.locator(".settings-primary-button, .settings-secondary-button, .settings-danger-button").first(),
	).toBeVisible();
	const sizes = await root
		.locator(".settings-primary-button, .settings-secondary-button, .settings-danger-button")
		.evaluateAll((elements) =>
			elements
				.filter((element) => element.getClientRects().length > 0)
				.map((element) => ({
					label: element.textContent,
					toolbarAction: element.parentElement?.classList.contains("permission-rules-toolbar"),
					height: Math.round(element.getBoundingClientRect().height),
					font: getComputedStyle(element).fontSize,
				})),
		);
	expect(sizes.length).toBeGreaterThan(0);
	for (const size of sizes) {
		expect(size.height, size.label ?? "action").toBe(size.toolbarAction ? 28 : 32);
		expect(size.font, size.label ?? "action").toBe("12px");
	}
}

for (const theme of ["dark", "light"] as const) {
	test(`provider panels preserve edits and test the lowest reasoning level in ${theme}`, async ({}, info) => {
		const app = await launchPermissionApp({ preset: "auto", tools: () => undefined, locale: "zh-CN" });
		const page = app.page;
		try {
			await page.evaluate(async (baseUrl) => {
				const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
				await api.updateModelSettings({
					requestId: crypto.randomUUID(),
					mutation: {
						type: "save_provider",
						provider: "panel-test",
						name: "推理模型测试",
						baseUrl,
						api: "openai-completions",
						credential: { action: "set", value: "fixture-key" },
						models: ["first", "second"].map((modelId) => ({
							modelId,
							name: modelId,
							contextWindow: 128000,
							maxOutputTokens: 8192,
							reasoningMode: "manual",
							thinkingLevelMap: { low: "low", high: "high", max: "max" },
							imageInput: false,
						})),
					},
				});
				await api.updateModelSettings({
					requestId: crypto.randomUUID(),
					mutation: {
						type: "set_defaults",
						model: { provider: "panel-test", modelId: "first" },
						thinkingSelection: "max",
					},
				});
			}, app.providerBaseUrl);
			await page.locator(".account-menu-trigger").click();
			await page.getByRole("menuitem", { name: "设置", exact: true }).click();
			await page.locator(".settings-navigation").getByRole("button", { name: "通用", exact: true }).click();
			await page
				.getByRole("group", { name: "外观", exact: true })
				.getByRole("button", { name: theme === "dark" ? "深色" : "浅色", exact: true })
				.click();
			const keyField = page.locator(".web-search-api-key");
			const providerField = page.locator(".web-search-provider-select");
			await expect(keyField).toHaveCSS("width", "220px");
			await expect(providerField).toHaveCSS("width", "220px");
			const keyBox = await keyField.boundingBox();
			const providerBox = await providerField.boundingBox();
			expect(keyBox!.x).toBeCloseTo(providerBox!.x, 0);
			await expectCompactActions(page.locator(".general-page"));
			await page.screenshot({ path: info.outputPath(`general-controls-${theme}.png`), animations: "disabled" });
			await page.setViewportSize({ width: 680, height: 820 });
			expect((await keyField.boundingBox())!.width).toBeCloseTo((await providerField.boundingBox())!.width, 0);
			expect(
				await page.locator(".general-page").evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.locator(".settings-navigation").getByRole("button", { name: "模型", exact: true }).click();
			await expectCompactActions(page.locator(".model-settings-page"));
			const search = page.locator(".model-provider-toolbar input");
			await expect(search).toHaveCSS("border-top-width", "0px");
			await expect(page.locator(".model-service-section")).toHaveCSS("border-top-width", "1px");
			await page.screenshot({ path: info.outputPath(`model-page-${theme}.png`), animations: "disabled" });
			await page.locator(".model-provider-card").filter({ hasText: "推理模型测试" }).click();
			const dialog = page.locator(".model-custom-provider-dialog");
			const panel = dialog.locator('[role="tabpanel"]:visible');
			await expect(panel.getByLabel("提供商名称", { exact: true })).toBeVisible();
			await expect(dialog.getByLabel("模型 ID", { exact: true }).first()).not.toBeVisible();
			await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
			const notice = dialog.locator(".system-notice-stack .system-notice");
			await expect(notice).toHaveAttribute("data-tone", "success");
			await expect(notice).toContainText("连接成功");
			await expect(notice).toBeInViewport();
			expect(
				await notice.evaluate((element) => {
					const rect = element.getBoundingClientRect();
					return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
				}),
			).toBe(true);
			expect(app.provider.calls.filter((call) => call.model === "first").at(-1)?.thinking).toBe("low");
			expect(app.provider.calls.filter((call) => call.model === "first").at(-1)?.tools).toBeUndefined();
			await page.screenshot({ path: info.outputPath(`provider-connection-${theme}.png`), animations: "disabled" });
			await notice.getByRole("button", { name: "关闭提醒", exact: true }).click();
			// A test-target change must not change defaults or create an unsaved configuration.
			await dialog.getByRole("button", { name: "测试模型", exact: true }).click();
			await page.getByRole("option", { name: "second", exact: true }).click();
			await dialog.getByRole("button", { name: "关闭供应商配置", exact: true }).click();
			await expect(page.locator(".settings-unsaved-dialog")).toHaveCount(0);
			await page.locator(".model-provider-card").filter({ hasText: "推理模型测试" }).click();
			await dialog.getByRole("tab", { name: "模型", exact: true }).click();
			await expect(dialog.locator(".model-custom-model-row[open]")).toHaveCount(0);
			await expectCompactActions(dialog);
			const modelRow = dialog.locator(".model-custom-model-row").first();
			const opening = await sampleDisclosure(modelRow);
			expectIntermediateFrames(opening);
			await info.attach(`opening-${theme}`, { body: JSON.stringify(opening), contentType: "application/json" });
			const closing = await sampleDisclosure(modelRow);
			expectIntermediateFrames(closing);
			await expect(modelRow).not.toHaveAttribute("open");
			const rapid = await sampleDisclosure(modelRow, true);
			await expect(modelRow).not.toHaveAttribute("open");
			expect(rapid.at(-1)).toBeCloseTo(rapid[0], 0);
			await sampleDisclosure(modelRow);
			await expect(dialog.locator(".model-custom-model-row[open]")).toHaveCount(1);
			await expect(dialog.getByRole("button", { name: "第 1 个推理档位", exact: true })).toBeVisible();
			await page.emulateMedia({ reducedMotion: "reduce" });
			await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
			const reduced = await sampleDisclosure(modelRow);
			expect(new Set(reduced.slice(1).map(Math.round)).size).toBe(1);
			await page.emulateMedia({ reducedMotion: "no-preference" });
			await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
			await sampleDisclosure(modelRow);
			await dialog.getByLabel("显示名称", { exact: true }).first().fill("已编辑的模型");
			const switching = await dialog
				.getByRole("tab", { name: "连接", exact: true })
				.evaluate(
					async (button, options) => {
						const element = button.closest<HTMLDialogElement>("dialog")!;
						const previous = element.style.getPropertyValue("--motion-duration-switch");
						element.style.setProperty("--motion-duration-switch", `${options.duration}ms`);
						try {
							const samples = [element.getBoundingClientRect().height];
							(button as HTMLButtonElement).click();
							const start = performance.now();
							do {
								await new Promise(requestAnimationFrame);
								samples.push(element.getBoundingClientRect().height);
							} while (performance.now() - start < options.window);
							return samples;
						} finally {
							if (previous) element.style.setProperty("--motion-duration-switch", previous);
							else element.style.removeProperty("--motion-duration-switch");
						}
					},
					{ duration: SLOW_MOTION_MS, window: SLOW_MOTION_WINDOW_MS },
				);
			expectIntermediateFrames(switching);
			await dialog.getByRole("tab", { name: "模型", exact: true }).click();
			await expect(dialog.getByLabel("显示名称", { exact: true }).first()).toHaveValue("已编辑的模型");
			for (const width of [1200, 820]) {
				await page.setViewportSize({ width, height: 820 });
				expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
				await expect(dialog.locator(".model-provider-editor-footer")).toBeInViewport();
			}
			const lastLevel = dialog.getByRole("button", { name: "第 3 个推理档位", exact: true });
			await lastLevel.scrollIntoViewIfNeeded();
			await expect(lastLevel).toBeInViewport();
			await page.screenshot({ path: info.outputPath(`provider-models-${theme}.png`), animations: "disabled" });
			await dialog.getByRole("button", { name: "保存提供商", exact: true }).click();
			await expect(dialog).toBeVisible();
			await expect(dialog.getByRole("button", { name: "保存提供商", exact: true })).toBeDisabled();
			await dialog.getByRole("tab", { name: "新任务默认设置", exact: true }).click();
			await expect(dialog.getByRole("button", { name: "默认推理强度", exact: true })).toContainText("最大");
			await page.screenshot({ path: info.outputPath(`provider-defaults-${theme}.png`), animations: "disabled" });
			await dialog.getByRole("button", { name: "关闭供应商配置", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			const settings = await page.evaluate(() =>
				(globalThis as unknown as { metis: MetisDesktopApi }).metis.getModelSettings(),
			);
			expect(settings.defaultThinkingSelection).toBe("max");
			expect(
				settings.providers
					.find((provider) => provider.provider === "panel-test")
					?.models.find((model) => model.modelId === "first")?.name,
			).toBe("已编辑的模型");
			await page.locator(".settings-navigation").getByRole("button", { name: "权限", exact: true }).click();
			await expectCompactActions(page.locator(".permission-settings-page"));
			await expect(page.locator(".permission-settings-caption")).toHaveCount(0);
			await expect(page.locator(".permission-auto-approval")).toHaveCSS("border-top-width", "1px");
			await page.screenshot({ path: info.outputPath(`permissions-${theme}.png`), animations: "disabled" });
			for (const name of ["个性化", "记忆", "子智能体", "浏览器"]) {
				await page.locator(".settings-navigation").getByRole("button", { name, exact: true }).click();
				await expectCompactActions(page.locator(".settings-page"));
			}
			await page.locator(".settings-navigation").getByRole("button", { name: "通用", exact: true }).click();
			await page
				.getByRole("group", { name: "动效", exact: true })
				.getByRole("button", { name: "减少动效", exact: true })
				.click();
			await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
			await page.locator(".settings-navigation").getByRole("button", { name: "模型", exact: true }).click();
			await page.locator(".model-provider-card").filter({ hasText: "推理模型测试" }).click();
			await dialog.getByRole("tab", { name: "模型", exact: true }).click();
			const appReduced = await sampleDisclosure(dialog.locator(".model-custom-model-row").first());
			expect(new Set(appReduced.slice(1).map(Math.round)).size).toBe(1);
			await dialog.getByRole("button", { name: "关闭供应商配置", exact: true }).click();
		} finally {
			await app.close();
		}
	});
}
