import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

test("packaged Code sidebar reports incompatible sessions without agent retry rows or source changes", async ({}, info) => {
	test.setTimeout(90_000);
	let futureFile = "";
	let brokenFile = "";
	const futureBody = Buffer.from("future body is intentionally not JSON\n{unfinished");
	let futureBytes = Buffer.alloc(0);
	const brokenBytes = Buffer.from("broken header\n");
	const app = await launchPermissionApp({
		locale: "zh-CN",
		tools: () => undefined,
		seed: async (dirs) => {
			const { CURRENT_SESSION_VERSION, getDefaultSessionDir, getSessionDisplayMetadataPath } = (await import(
				pathToFileURL(path.resolve(__dirname, "../../coding-agent/dist/host.js")).href
			)) as {
				CURRENT_SESSION_VERSION: number;
				getDefaultSessionDir(cwd: string, agentDir: string): string;
				getSessionDisplayMetadataPath(file: string): string;
			};
			const storage = getDefaultSessionDir(dirs.projectDir, dirs.agentDir);
			await mkdir(storage, { recursive: true });
			const base = {
				type: "session",
				timestamp: "2026-10-28T12:00:00.000Z",
				cwd: dirs.projectDir,
				mode: "code",
				cwdOrigin: "user-selected",
				permissionPreset: "ask",
			};
			for (const [id, name, version] of [
				["11111111-1111-4111-8111-111111111111", "正常验收会话", CURRENT_SESSION_VERSION],
				["22222222-2222-4222-8222-222222222222", "新格式验收会话", CURRENT_SESSION_VERSION + 1],
			] as const) {
				const file = path.join(storage, `${id}.jsonl`);
				const header = Buffer.from(`${JSON.stringify({ ...base, id, version })}\n`);
				const bytes = version > CURRENT_SESSION_VERSION ? Buffer.concat([header, futureBody]) : header;
				await writeFile(file, bytes);
				await writeFile(getSessionDisplayMetadataPath(file), JSON.stringify({ version: 1, sessionId: id, name }));
				if (version > CURRENT_SESSION_VERSION) {
					futureFile = file;
					futureBytes = bytes;
				}
			}
			brokenFile = path.join(storage, "broken.jsonl");
			await writeFile(brokenFile, brokenBytes);
		},
	});
	try {
		const { page } = app;
		await page.getByRole("button", { name: "代码", exact: true }).click();
		const future = page.locator('.session-button[aria-label="新格式验收会话"]');
		await expect(future).toBeVisible();
		await expect(future).toHaveAttribute("title", /兼容版本/u);
		await expect(page.getByRole("button", { name: "重新加载子代理", exact: true })).toHaveCount(0);
		await future.click();
		await expect(page.getByRole("alert").filter({ hasText: "当前 Metis 版本不支持此会话格式" })).toBeVisible();
		await expect(page.locator('.session-button[aria-label="正常验收会话"]')).toBeVisible();
		await page.screenshot({ path: info.outputPath("sidebar-session-availability.png") });
		expect(await readFile(futureFile)).toEqual(futureBytes);
		expect(await readFile(brokenFile)).toEqual(brokenBytes);
	} finally {
		await app.close();
	}
});
