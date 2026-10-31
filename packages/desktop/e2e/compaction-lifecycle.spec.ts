import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeServer,
	connectToApp,
	launchPackagedDesktop,
	listen,
	packagedExecutable,
	readOpenAiChatRequest,
	reservePort,
	respondWithText,
	stopProcess,
	waitForServerReady,
	writeOfflineProviderConfig,
} from "./packaged-app-harness.ts";

for (const mode of ["chat", "code"] as const) {
	test(`${mode}: manual compaction disables sending and returns to idle`, async ({}, info) => {
		test.setTimeout(90_000);
		const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-compaction-ui-"));
		const agentDir = path.join(tempRoot, "agent");
		const homeDir = path.join(tempRoot, "home");
		const projectDir = path.join(tempRoot, "project");
		const userDataDir = path.join(tempRoot, "electron");
		await Promise.all([agentDir, homeDir, projectDir, userDataDir].map((dir) => mkdir(dir)));
		let summaryResponse: ServerResponse | undefined;
		let releaseSummary = false;
		const provider = createServer(async (request, response) => {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const body = await readOpenAiChatRequest(request);
			if (JSON.stringify(body.messages).includes("<conversation>")) {
				if (releaseSummary) respondWithText(response, "Conversation summary");
				else summaryResponse = response;
			} else {
				respondWithText(response, "Compaction fixture response");
			}
		});
		const port = await listen(provider);
		await writeOfflineProviderConfig(agentDir, port);
		const settingsPath = path.join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		await writeFile(settingsPath, JSON.stringify({ ...settings, compaction: { keepRecentTokens: 1 } }));
		const debuggingPort = await reservePort();
		const diagnostics: string[] = [];
		const app = launchPackagedDesktop({
			executable: packagedExecutable(), debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics,
		});
		let browser: Browser | undefined;
		try {
			const connected = await connectToApp(debuggingPort);
			browser = connected.browser;
			const page = connected.page;
			await waitForServerReady(page);
			await page.locator(".account-menu-trigger").waitFor();
			const sessionId = await page.evaluate(async ({ cwd, mode }) => {
				const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
				const result = await api.createSession({ requestId: crypto.randomUUID(), mode, cwd });
				localStorage.setItem(`metis.activeSessionId.${mode}`, result.session.sessionId);
				return result.session.sessionId;
			}, { cwd: projectDir, mode });
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.getByRole("button", { name: mode === "code" ? "Code" : "Chat", exact: true }).click();
			await expect(page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
			const input = page.locator("#composer-input");
			const answers = page.locator(".turn-answer, .code-turn-answer");
			await input.fill("Compaction lifecycle test");
			await page.getByRole("button", { name: "Send message", exact: true }).click();
			await expect(answers.last()).toContainText("Compaction fixture response");
			await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
			await input.fill("/compact");
			await page.getByRole("option").filter({ hasText: "/compact" }).click();
			await expect.poll(() => summaryResponse !== undefined).toBe(true);
			await expect(input).toHaveAttribute("contenteditable", "false");
			await expect(input).toHaveAttribute("data-placeholder", "Compacting conversation…");
			await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
			await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
			await expect(page.getByRole("listbox", { name: "Slash commands", exact: true })).toHaveCount(0);
			await page.screenshot({ path: info.outputPath("compacting.png") });
			releaseSummary = true;
			respondWithText(summaryResponse!, "Conversation summary");
			await expect(page.locator(".transcript-compaction-row")).toHaveText("Compacted");
			await expect(input).toHaveAttribute("contenteditable", "true");
			await expect(input).toHaveAttribute("data-placeholder", "Write a message…");
			await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
			await input.fill("Message after compaction");
			await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
			await page.screenshot({ path: info.outputPath("compacted.png") });
			await page.getByRole("button", { name: "Send message", exact: true }).click();
			await expect(answers).toHaveCount(2);
			await expect(answers.last()).toContainText("Compaction fixture response");
		} finally {
			await browser?.close();
			await stopProcess(app);
			await closeServer(provider);
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
}
