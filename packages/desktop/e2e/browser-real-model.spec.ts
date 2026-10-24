import { expect, type Page, test } from "@playwright/test";
import { withBrowserModel } from "./browser-real-model-session.ts";

const task = `请只用 Metis 内置的 browser_* 工具自主完成下面这项公开网页测试，不使用脚本、命令行、外部搜索或子代理：
1. 打开 https://en.wikipedia.org/wiki/Web_browser 。
2. 使用页面搜索框输入 temporary query，然后用平台的全选快捷键和 Backspace 清空，再输入 Chromium (web browser)，按 Enter 搜索并确认到了对应条目。
3. 使用浏览器后退回 Web browser，前进回 Chromium，再后退回 Web browser。
4. 使用网页的 Appearance 菜单把颜色切成 Dark。
5. 点击页面中的 Firefox 链接，确认 Firefox 标题和深色外观，最后获取一次页面截图。
全程不登录、不发布内容、不修改账户。遇到工具拒绝或页面变化时，根据最新观察恢复；若无法完成，明确报告卡在哪一步。完成后用中文简述实际结果。`;

// This deliberately spends real model quota. It never substitutes scripted responses.
test("configured model autonomously controls Wikipedia in packaged Metis", async ({}, testInfo) => {
	test.skip(
		process.env.METIS_BROWSER_REAL_MODEL_TEST !== "1",
		"Explicit opt-in for real model quota and public internet",
	);
	test.setTimeout(660_000);
	await withBrowserModel(testInfo, async (session) => {
		const running = session.app;
		const items = session.items;
		const navigation: string[] = [];
		const networkFailures: Array<{ url: string; error: string }> = [];
		const observedPages = new Set<Page>();
		const inputs: string[] = [];
		const startedAt = Date.now();
		try {
			for (const context of running.browser.contexts()) {
				// Passive input instrumentation verifies the actual field contents. It does
				// not choose a locator, focus a field, or perform any website action.
				await context.exposeBinding("recordBrowserAcceptanceInput", (_source, value: string) => {
					inputs.push(value);
				});
				await context.addInitScript(() => {
					if (location.hostname !== "en.wikipedia.org") return;
					document.addEventListener(
						"input",
						(event) => {
							const target = event.target;
							if (target instanceof HTMLInputElement && target.name === "search") {
								void (
									globalThis as unknown as { recordBrowserAcceptanceInput(value: string): Promise<void> }
								).recordBrowserAcceptanceInput(target.value);
							}
						},
						true,
					);
				});
				const observe = (page: Page) => {
					if (page === running.page || observedPages.has(page)) return;
					observedPages.add(page);
					const recordNavigation = (url: string) => {
						if (url.startsWith("https://en.wikipedia.org/") && navigation.at(-1) !== url) navigation.push(url);
					};
					page.on("framenavigated", (frame) => {
						if (frame === page.mainFrame()) recordNavigation(frame.url());
					});
					// CDP can discover a WebContentsView after its initial commit.
					recordNavigation(page.url());
					page.on("requestfailed", (request) =>
						networkFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "failed" }),
					);
					page.on("response", (response) => {
						if (response.status() >= 400)
							networkFailures.push({ url: response.url(), error: String(response.status()) });
					});
				};
				context.on("page", observe);
				for (const page of context.pages()) observe(page);
			}
			await session.run(task);
			const website = [...observedPages].find((page) => page.url() === "https://en.wikipedia.org/wiki/Firefox");
			expect(website, "Model did not reach Firefox").toBeTruthy();
			if (!website) return;
			await expect(website.getByRole("heading", { name: "Firefox", exact: true })).toBeVisible();
			await expect(website.locator("html")).toHaveClass(/skin-theme-clientpref-night/u);
			const relevant = navigation.filter((url) =>
				/\/wiki\/(Web_browser|Chromium_\(web_browser\)|Firefox)$/u.test(url),
			);
			expect(relevant).toEqual([
				"https://en.wikipedia.org/wiki/Web_browser",
				"https://en.wikipedia.org/wiki/Chromium_(web_browser)",
				"https://en.wikipedia.org/wiki/Web_browser",
				"https://en.wikipedia.org/wiki/Chromium_(web_browser)",
				"https://en.wikipedia.org/wiki/Web_browser",
				"https://en.wikipedia.org/wiki/Firefox",
			]);
			expect(inputs).toContain("temporary query");
			expect(inputs).toContain("");
			expect(inputs).toContain("Chromium (web browser)");
			const blocks = [...items.values()].flatMap((item) => item.content);
			const calls = blocks.filter((block) => block.type === "tool_call");
			expect(calls.every((call) => call.name.startsWith("browser_"))).toBe(true);
			const keyInputs = calls.map((call) => call.inputPreview ?? "").join("\n");
			expect(keyInputs).toMatch(/(?:ControlOrMeta|Meta|Command|Cmd)\+A/iu);
			expect(keyInputs).toContain("Backspace");
			// Live transcript projections may omit image references; the durable
			// session is the authoritative record of tool images delivered to context.
			let capturedFinalScreenshot = false;
			for (const message of await session.messages()) {
				if (message.role !== "toolResult" || message.toolName !== "browser_observe" || message.isError) continue;
				const text = message.content.find((block) => block.type === "text")?.text;
				if (text && JSON.parse(text).url === "https://en.wikipedia.org/wiki/Firefox")
					capturedFinalScreenshot ||= message.content.some(
						(block) => block.type === "image_ref" || block.type === "image",
					);
			}
			expect(capturedFinalScreenshot).toBe(true);
			await website.screenshot({ path: testInfo.outputPath("wikipedia-final.png") });
			await running.page.screenshot({ path: testInfo.outputPath("metis-final.png") });
		} finally {
			await session.save("browser-results.json", {
				navigation,
				inputs,
				networkFailures,
				elapsedMs: Date.now() - startedAt,
			});
		}
	});
});
