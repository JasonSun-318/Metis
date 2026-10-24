import { expect, test } from "@playwright/test";
import { createModelControlsSite } from "./browser-model-controls-fixture.ts";
import { type RecordedModelMessage, withBrowserModel } from "./browser-real-model-session.ts";

const onlyBrowser =
	"请只用 Metis 内置 browser_* 工具自主完成任务，不使用代码、命令行、外部搜索或子代理。根据实际页面选择控件和参数；遇到页面改变或操作失败时重新观察并恢复。最后核对结果，用中文报告实际完成情况。";

test.beforeEach(() => {
	test.skip(process.env.METIS_BROWSER_REAL_MODEL_TEST !== "1", "Explicit opt-in for real model quota");
	test.setTimeout(660_000);
});

function selections(messages: RecordedModelMessage[]) {
	return messages
		.flatMap((message) => message.content)
		.filter((block) => block.type === "toolCall" && block.name === "browser_act")
		.map((block) => block.arguments?.action as { type?: string; optionIndex?: number; value?: string } | undefined)
		.filter((action) => action?.type === "select");
}

test("real model selects grouped native options and recovers a page reset", async ({}, testInfo) => {
	const site = await createModelControlsSite();
	try {
		await withBrowserModel(testInfo, async (session) => {
			await session.run(
				`${onlyBrowser}\n打开 ${site.origin}/native ，将配送方式设为“国际配送”分组中的“标准配送”，通知语言设为“简体中文”，然后点击“预览设置”。如有库存更新，按页面提示完成恢复，最终确认预览内容正确。`,
			);
			const page = session.app.browser
				.contexts()
				.flatMap((context) => context.pages())
				.find((page) => page.url() === `${site.origin}/native`);
			expect(page).toBeTruthy();
			if (!page) throw new Error("Native controls page missing");
			await expect(page.locator("#delivery")).toHaveValue("private-native-current");
			await expect(page.locator("#language")).toHaveValue("简体中文");
			await expect(page.locator("#summary")).toHaveText("预览成功：国际配送 / 标准配送；通知语言：简体中文");
			const state = await page.evaluate(() => {
				const select = document.querySelector<HTMLSelectElement>("#delivery")!;
				return {
					index: select.selectedIndex,
					group: select.selectedOptions[0]?.parentElement?.getAttribute("label"),
					audit: (
						globalThis as unknown as {
							controlAudit: {
								changes: Array<{ id: string; type: string; value: string; index: number }>;
								resetCount: number;
								previewCount: number;
							};
						}
					).controlAudit,
				};
			});
			expect(state.index).toBe(4);
			expect(state.group).toBe("国际配送");
			expect(state.audit.resetCount).toBe(1);
			expect(
				state.audit.changes
					.filter((event) => event.id === "delivery" && event.type === "change")
					.map((event) => event.value),
			).toEqual(["private-native-initial", "private-native-current"]);
			const messages = await session.messages();
			const selected = selections(messages);
			expect(selected.length).toBeGreaterThanOrEqual(3);
			expect(selected.every((action) => Number.isInteger(action?.optionIndex) && action?.value === undefined)).toBe(
				true,
			);
			const toolOutputs = messages
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.content)
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			expect(toolOutputs).not.toContain("private-native-");
			const resetIndex = messages.findIndex(
				(message) =>
					message.role === "toolResult" &&
					message.isError &&
					message.content.some(
						(block) => block.type === "text" && block.text?.includes('"reason":"selection_changed"'),
					),
			);
			expect(resetIndex).toBeGreaterThanOrEqual(0);
			const failureText = messages[resetIndex]!.content.find((block) => block.type === "text")!.text!;
			expect(JSON.parse(failureText)).toMatchObject({
				status: "failed",
				reason: "selection_changed",
				execution: "dispatched",
				recovery: "observe",
			});
			expect(failureText).toContain("browser_observe");
			const afterFailure = messages
				.slice(resetIndex + 1)
				.flatMap((message) => message.content)
				.filter((block) => block.type === "toolCall");
			expect(afterFailure[0]?.name).toBe("browser_observe");
			expect(toolOutputs).not.toContain("OPERATION_FAILED");
			expect(toolOutputs).not.toContain('Validation failed for tool "browser_act"');
			await session.save("controls-result.json", {
				state,
				selected,
				toolErrors: messages.filter((message) => message.isError),
			});
			await page.screenshot({ path: testInfo.outputPath("native-final.png") });
		});
	} finally {
		await site.close();
	}
});

test("real model distinguishes nested iframe controls and edits after navigation", async ({}, testInfo) => {
	const site = await createModelControlsSite();
	try {
		await withBrowserModel(testInfo, async (session) => {
			await session.run(
				`${onlyBrowser}\n打开 ${site.origin}/frames 。只操作“课程报名嵌入页”中的正式报名表，不要修改外层练习表单。填写姓名“林青”，课程选“进阶课程”，时段选“晚间”，点击“预览报名”并核对。然后通过预览页的“编辑报名”返回表单，把姓名改为“陈禾”，课程和时段仍为进阶课程、晚间，再次预览并核对。所有信息均是本地测试数据。`,
			);
			const page = session.app.browser
				.contexts()
				.flatMap((context) => context.pages())
				.find((page) => page.url() === `${site.origin}/frames`);
			expect(page).toBeTruthy();
			if (!page) throw new Error("Outer frame page missing");
			const finalFrame = page.frames().find((frame) => frame.url().startsWith(`${site.origin}/frame/preview`));
			expect(finalFrame).toBeTruthy();
			if (!finalFrame) throw new Error("Nested final preview missing");
			await expect(finalFrame.locator("output")).toHaveText("姓名：陈禾；课程：进阶课程；时段：晚间");
			expect(site.previews).toEqual([
				{ round: "1", name: "林青", course: "advanced", time: "晚间" },
				{ round: "2", name: "陈禾", course: "advanced", time: "晚间" },
			]);
			await expect(page.locator("#outerName")).toHaveValue("外层原值");
			await expect(page.locator("#outerCourse")).toHaveValue("基础课程");
			const outerAudit = await page.evaluate(
				() => (globalThis as unknown as { outerAudit: { edits: number; clicks: number } }).outerAudit,
			);
			expect(outerAudit).toEqual({ edits: 0, clicks: 0 });
			const messages = await session.messages();
			const selected = selections(messages);
			expect(selected.length).toBeGreaterThanOrEqual(4);
			expect(selected.every((action) => Number.isInteger(action?.optionIndex) && action?.value === undefined)).toBe(
				true,
			);
			const toolOutputs = messages
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.content)
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			expect(toolOutputs).not.toContain("PRIVATE_IFRAME_DRAFT");
			expect(toolOutputs).not.toContain('Validation failed for tool "browser_act"');
			await session.save("controls-result.json", {
				previews: site.previews,
				outerAudit,
				selected,
				frameUrls: page.frames().map((frame) => frame.url()),
				requests: site.requests,
			});
			await page.screenshot({ path: testInfo.outputPath("iframe-final.png") });
		});
	} finally {
		await site.close();
	}
});
