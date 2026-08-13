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

		await setLocale("en", localStorage);
		expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en");
		expect(document.documentElement.lang).toBe("en");
		expect(localeForIntl()).toBe("en-US");
	});
});
