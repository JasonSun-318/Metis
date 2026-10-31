import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

for (const mode of ["chat", "code"] as const) {
test(`${mode}: delivered cards share the original file and refresh after edits and restart`, async ({}, testInfo) => {
	test.setTimeout(120_000);
	const app = await launchPermissionApp({
		mode, preset: "full", locale: "en",
		seed: (dirs) => writeFile(path.join(dirs.projectDir, "report.txt"), "Initial report"),
		tools: (marker, dirs) => marker === "case-sensitive"
			? { name: "deliver_file", arguments: { path: path.join(dirs.homeDir, ".ssh", "id_rsa") } }
			: marker === "case-outside"
			? { name: "deliver_file", arguments: { path: path.join(dirs.outsideDir, "outside.txt") } }
			: marker === "case-edit"
			? { name: "write", arguments: { path: path.join(dirs.projectDir, "report.txt"), content: "Updated report with the latest changes" } }
			: { name: "deliver_file", arguments: { path: path.join(dirs.projectDir, "report.txt"), message: marker === "case-first" ? "Initial delivery" : "Revised delivery" } },
	});
	try {
		await app.page.setViewportSize({ width: 1280, height: 900 });
		await app.submit("case-first");
		await app.waitDone("case-first");
		const cards = app.page.locator(".transcript-delivered-file-card");
		await expect(cards).toHaveCount(1);
		await cards.first().getByRole("button", { name: "Preview", exact: true }).click();
		const preview = app.page.locator(".universal-previewer");
		await expect(preview).toContainText("Initial report");
		await app.submit("case-edit");
		await app.waitDone("case-edit");
		await expect(preview).toContainText("Updated report with the latest changes");
		await preview.getByRole("button", { name: "Close preview", exact: true }).click();
		await app.submit("case-second");
		await app.waitDone("case-second");
		await expect(cards).toHaveCount(2);
		await expect(cards.first()).toContainText("Initial delivery");
		await expect(cards.last()).toContainText("Revised delivery");
		await cards.first().getByRole("button", { name: "Preview", exact: true }).click();
		await expect(preview).toContainText("Updated report with the latest changes");
		await app.page.screenshot({ path: testInfo.outputPath("live-file-history.png") });
		expect(await readFile(path.join(app.projectDir, "report.txt"), "utf8")).toBe("Updated report with the latest changes");
		expect(existsSync(path.join(app.agentDir, "attachments", app.sessionId, "delivered"))).toBe(false);
		const files = await app.page.evaluate(async (sessionId) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return (await api.subscribeSession({ sessionId })).deliveredFiles;
		}, app.sessionId);
		expect(files).toHaveLength(1);
		expect(files[0]?.sourcePath).toBe(path.join(app.projectDir, "report.txt"));
		const missing = await app.page.evaluate(async (sessionId) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return api.readPreviewFile({ source: "delivered", sessionId, fileId: "0000000000000000" });
		}, app.sessionId);
		expect(missing).toEqual({ ok: false, reason: "not-found" });
		await app.relaunch();
		const restoredCards = app.page.locator(".transcript-delivered-file-card");
		await expect(restoredCards).toHaveCount(2);
		await restoredCards.first().getByRole("button", { name: "Preview", exact: true }).click();
		await expect(app.page.locator(".universal-previewer")).toContainText("Updated report with the latest changes");
		await app.page.getByRole("button", { name: "Close preview", exact: true }).click();
		await app.setPreset("Full", "Ask");
		await app.submit("case-outside");
		await expect(app.approval).toBeVisible();
		await app.allowOnce();
		await app.waitDone("case-outside");
		await expect(restoredCards.last()).toContainText("outside");
		await restoredCards.last().getByRole("button", { name: "Preview", exact: true }).click();
		await expect(app.page.locator(".universal-previewer")).toContainText("outside");
		await app.page.getByRole("button", { name: "Close preview", exact: true }).click();
		await app.submit("case-sensitive");
		await expect(app.approval).toBeVisible();
		await app.reject();
		await app.waitDone("case-sensitive");
		await expect(restoredCards).toHaveCount(3);
	} finally { await app.close(); }
});
}
