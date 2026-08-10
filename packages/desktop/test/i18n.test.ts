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
		expect(i18n.t("About {{count}} tokens", { count: 44 })).toBe("约 44 个 Token");
		expect(i18n.t("Thinking…")).toBe("思考中…");
		expect(i18n.t("Completed")).toBe("已完成");
		expect(i18n.t("Working")).toBe("进行中");

		await setLocale("en", localStorage);
		expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en");
		expect(document.documentElement.lang).toBe("en");
		expect(localeForIntl()).toBe("en-US");
	});
});
