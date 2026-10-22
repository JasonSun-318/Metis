// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import i18n, { APP_LOCALE_STORAGE_KEY, loadLocale, localeForIntl, setLocale } from "../src/renderer/i18n.ts";

describe("Desktop locale preference", () => {
	beforeEach(async () => {
		localStorage.clear();
		await setLocale("en");
	});

	it("loads English for missing or invalid persisted values", () => {
		expect(loadLocale(localStorage)).toBe("en");
		for (const value of ["zh", "en-US", "auto", "", "null"]) {
			localStorage.setItem(APP_LOCALE_STORAGE_KEY, value);
			expect(loadLocale(localStorage)).toBe("en");
		}
	});

	it("persists either supported locale and updates the document language", async () => {
		await setLocale("zh-CN", localStorage);
		expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(i18n.resolvedLanguage).toBe("zh-CN");
		expect(localeForIntl()).toBe("zh-CN");
		expect(i18n.t("New tab")).toBe("新标签页");
		expect(i18n.t("Enter URL")).toBe("输入 URL");
		expect(i18n.t("Start browsing")).toBe("开始浏览");
		expect(i18n.t("Enter a URL to open a page")).toBe("输入 URL 以打开页面");
		expect(i18n.t("{{count}} tokens", { count: 44 })).toBe("44 个 Token");
		expect(i18n.t("Thinking…")).toBe("思考中…");
		expect(i18n.t("Completed")).toBe("已完成");
		expect(i18n.t("Working")).toBe("进行中");
		expect(i18n.t("New Skill")).toBe("新建技能");
		expect(i18n.t("New MCP")).toBe("新建 MCP");
		expect(i18n.t("Quick presets")).toBe("快速预设");
		expect(i18n.t("Concise and direct")).toBe("简洁直击");
		expect(i18n.t("Strict TypeScript")).toBe("严格类型");
		expect(i18n.t("Content font size")).toBe("内容字号");
		expect(i18n.t("Adjust Chat and Code reading text without changing interface controls or layout.")).toBe(
			"调整 Chat 与 Code 阅读内容的字号，不改变界面控件或布局。",
		);
		expect(i18n.t("All sources")).toBe("全部来源");
		expect(i18n.t("All scopes")).toBe("全部范围");
		expect(i18n.t("Back to Skills")).toBe("返回技能列表");
		expect(i18n.t("Back to MCP")).toBe("返回 MCP 列表");
		expect(i18n.t("Open containing folder")).toBe("打开所在文件夹");
		expect(i18n.t("Move Skill to Trash?")).toBe("将技能移到废纸篓？");
		expect(i18n.t("Skill moved to Trash")).toBe("技能已移到废纸篓");
		expect(i18n.t("Instructions")).toBe("使用说明");
		expect(i18n.t("Included files")).toBe("包含文件");
		expect(i18n.t("Use lowercase letters, numbers, and single hyphens for the Skill name.")).toBe(
			"技能名称只能使用小写字母、数字和单个连字符。",
		);
		expect(i18n.t("This Skill changed elsewhere. Review the latest version and try again.")).toBe(
			"此技能已在其他位置更改，请查看最新版本后重试。",
		);
		expect(i18n.t("System prompt")).toBe("系统提示词");
		expect(i18n.t("MCP & dynamic tools")).toBe("MCP 与动态工具");
		expect(i18n.t("Context breakdown unavailable")).toBe("上下文明细不可用");
		expect(i18n.t("Context exceeded")).toBe("上下文已超限");
		expect(i18n.t("Plan mode")).toBe("计划模式");
		expect(i18n.t("Exit Plan mode")).toBe("退出计划模式");
		expect(i18n.t("Start execution")).toBe("开始执行");
		expect(i18n.t("Describe what should change in this plan…")).toBe("说明希望如何修改这个计划…");
		expect(i18n.t("Revision {{revision}}", { revision: 3 })).toBe("第 3 版");
		expect(i18n.t("What's new")).toBe("更新日志");
		expect(i18n.t("Open unread release notes")).toBe("打开未读更新日志");
		expect(i18n.t("Loading release notes...")).toBe("正在加载更新日志……");
		expect(i18n.t("Could not load release notes. Check your connection and try again.")).toBe(
			"更新日志加载失败，请检查网络后重试。",
		);
		expect(i18n.t("Latest")).toBe("最新");
		expect(i18n.t("Minimal")).toBe("最小");
		expect(i18n.t("Automatic detection (recommended)")).toBe("自动识别（推荐）");
		expect(i18n.t("No reasoning")).toBe("不支持推理");
		expect(i18n.t("Generic reasoning: Low, medium, high")).toBe("通用推理：低、中、高");
		expect(
			i18n.t(
				"On Windows, Metis currently imports browsing history only. Cookies and sign-in state are not imported.",
			),
		).toBe("Windows 版 Metis 目前仅导入浏览记录，不会导入 Cookie 或登录状态。");
		expect(i18n.t("Bring in browser history and manage profile-specific history.")).toBe(
			"导入浏览记录，并管理各浏览器资料的独立历史记录。",
		);
		expect(i18n.t("Import browsing history from a supported Chromium profile.")).toBe(
			"从支持的 Chromium 浏览器资料导入浏览记录。",
		);

		await setLocale("en", localStorage);
		expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en");
		expect(document.documentElement.lang).toBe("en");
		expect(localeForIntl()).toBe("en-US");
	});

	it("localizes panel controls and uses consistent Hook terminology without translating technical IDs", async () => {
		await setLocale("zh-CN", localStorage);
		for (const key of [
			"Resize sessions sidebar",
			"Resize file tree",
			"Hide workspace tree",
			"Show workspace tree",
			"Clear filters",
			"No matching results",
		]) {
			expect(i18n.exists(key, { lng: "zh-CN" })).toBe(true);
			expect(i18n.t(key)).not.toBe(key);
		}
		expect(i18n.t("Search Hooks")).toBe("搜索钩子");
		expect(i18n.t("New Hook")).toBe("新建钩子");
		expect(i18n.t("Import selected")).toBe("导入所选技能");
		expect(i18n.t("Import selected servers")).toBe("导入所选服务器");
		for (const id of ["gpt-5", "reasoning_effort", "command-v1", "MCP"]) expect(i18n.t(id)).toBe(id);
		await setLocale("en", localStorage);
		expect(i18n.t("Resize file tree")).toBe("Resize file tree");
	});

	it("translates every home starter and greeting", async () => {
		await setLocale("zh-CN", localStorage);
		const { CODE_HOME_GREETINGS, HOME_GREETINGS, getHomeStarters } = await import(
			"../src/renderer/new-task-home-content.ts"
		);
		const keys = [
			...CODE_HOME_GREETINGS.flatMap((item) => [item.key, item.anonymousKey]),
			...HOME_GREETINGS.flatMap((item) => [item.key, item.anonymousKey]),
			...getHomeStarters("chat").flatMap((item) => [item.title, item.description, item.prompt]),
			...getHomeStarters("code").flatMap((item) => [item.title, item.description, item.prompt]),
		];
		for (const key of keys) expect(i18n.exists(key, { lng: "zh-CN" })).toBe(true);
		expect(i18n.t("A good day starts now.")).toBe("美好的一天开始了。");
		expect(i18n.t("Good morning, {{name}}.", { name: "小林" })).toBe("上午好，小林。");
		expect(i18n.t("Explore tasks")).toBe("探索任务");
		expect(i18n.t("Recent projects")).toBe("最近项目");
		expect(i18n.t("Implement a feature")).toBe("实现功能");
		expect(i18n.t("Fix a bug")).toBe("修复问题");
		expect(i18n.t("Understand this project")).toBe("理解项目");
		expect(i18n.t("Review the code")).toBe("审查代码");
		expect(i18n.t("Add tests")).toBe("补充测试");
		expect(i18n.t("Improve performance")).toBe("优化性能");
		expect(i18n.t("{{name}}, ready to build?", { name: "小林" })).toBe("小林，准备开始写代码？");
	});
});
