import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";
import {
	appServerPid,
	closeServer,
	connectToApp,
	createAndRestoreChatSession,
	listen,
	packagedAsar,
	packagedExecutable,
	processIsAlive,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

test("packaged worker, WASM, trusted extension, and utility lifecycle stay functional", async () => {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-packaged-smoke-"));
	const agentDir = path.join(tempRoot, "agent");
	const projectDir = path.join(tempRoot, "project");
	const extensionDir = path.join(projectDir, ".arcmind", "extensions");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(extensionDir, { recursive: true }), mkdir(userDataDir)]);

	let providerRequests = 0;
	const providerToolNames: string[][] = [];
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
		providerToolNames.push(
			(payload.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter((name): name is string => Boolean(name)),
		);
		providerRequests += 1;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			`data: ${JSON.stringify({
				id: "chatcmpl-packaged-smoke",
				object: "chat.completion.chunk",
				created: 1,
				model: "packaged-smoke-model",
				choices: [
					{ index: 0, delta: { role: "assistant", content: "packaged-turn-ok" }, finish_reason: null },
				],
			})}\n\ndata: ${JSON.stringify({
				id: "chatcmpl-packaged-smoke",
				object: "chat.completion.chunk",
				created: 1,
				model: "packaged-smoke-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
		);
	});
	const providerPort = await listen(fakeProvider);
	const codingAgentUrl = pathToFileURL(
		path.join(packagedAsar(), ".webpack", "app-server", "node_modules", "@arcmind", "coding-agent", "dist", "index.js"),
	).href;
	await Promise.all([
		writeFile(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"packaged-smoke": {
						baseUrl: `http://127.0.0.1:${providerPort}/v1`,
						apiKey: "packaged-smoke-key",
						api: "openai-completions",
						models: [
							{
								id: "packaged-smoke-model",
								name: "Packaged Smoke Model",
								contextWindow: 32_000,
								maxTokens: 1_024,
							},
						],
					},
				},
			}),
		),
		writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "packaged-smoke",
				defaultModel: "packaged-smoke-model",
				retry: { enabled: false },
				webSearch: { enabled: true, provider: "brave" },
			}),
		),
		writeFile(
			path.join(extensionDir, "packaged-image.ts"),
			`export default function (arcmind) {
	arcmind.on("session_start", async (_event, ctx) => {
		try {
			const { resizeImage } = await import(${JSON.stringify(codingAgentUrl)});
			const input = Uint8Array.from(Buffer.from(${JSON.stringify(TINY_PNG)}, "base64"));
			const result = await resizeImage(input, "image/png", { maxWidth: 1, maxHeight: 1 });
			const message = result?.width === 1 && result.height === 1
				? "Worker and WASM returned 1x1"
				: "Worker or WASM returned an unexpected result";
			await ctx.ui.confirm("Packaged image pipeline", message);
		} catch (error) {
			await ctx.ui.confirm(
				"Packaged image pipeline",
				\`Image pipeline error: \${error instanceof Error ? error.message : String(error)}\`,
			);
		}
	});
}
`,
		),
	]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = spawn(executable, [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${userDataDir}`], {
		cwd: projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			ARCMIND_CODING_AGENT_DIR: agentDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	app.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
	app.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	let finalUtilityPid: number | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		phase = "verifying draft creation timing";
		await waitForServerReady(page);
		const bridge = await page.evaluate(() => {
			const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
			return {
				hasAttachmentPicker: typeof api.selectAttachmentFiles === "function",
				hasSkillList: typeof api.listSkills === "function",
			};
		});
		expect(bridge).toEqual({ hasAttachmentPicker: true, hasSkillList: true });
		const sessionsBeforeDraft = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(sessionsBeforeDraft.sessions).toHaveLength(0);
		await page.getByRole("button", { name: "New task" }).click();
		const sessionsAfterNewTask = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(sessionsAfterNewTask.sessions).toHaveLength(0);
		await page.locator("#composer-input").fill("managed packaged smoke");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		expect(providerToolNames[0]).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
		const sessionsAfterFirstSend = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(sessionsAfterFirstSend.sessions).toHaveLength(1);
		expect(sessionsAfterFirstSend.sessions[0]).toMatchObject({ mode: "chat", cwdOrigin: "managed" });
		await expect(page.getByText("Tasks", { exact: true })).toBeVisible();

		phase = "creating trusted project session";
		const trustedSessionId = await createAndRestoreChatSession(page, projectDir, false);
		await expect(page.getByRole("heading", { name: "Trust this project?" })).toBeVisible();
		await page.getByRole("button", { name: /Trust \(this session only\)/ }).click();

		phase = "running the packaged extension image pipeline";
		await expect(page.getByRole("heading", { name: "Packaged image pipeline" })).toBeVisible();
		await expect(page.getByText("Worker and WASM returned 1x1", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Confirm" }).click();
		await page.locator(`[data-active-session-id="${trustedSessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });
		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		await expect.poll(() => appServerPid(rootPid)).not.toBeUndefined();

		phase = "running a fake provider turn";
		await page.locator("#composer-input").fill("packaged smoke turn");
		await page.getByRole("button", { name: "Send" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		expect(providerRequests).toBe(2);

		phase = "reloading and restarting";
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		const firstUtilityPid = appServerPid(rootPid);
		if (!firstUtilityPid) throw new Error("Could not find the packaged App Server");
		process.kill(firstUtilityPid, "SIGKILL");
		await expect.poll(() => appServerPid(rootPid)).not.toBe(firstUtilityPid);
		await waitForServerReady(page);
		finalUtilityPid = appServerPid(rootPid);
		if (!finalUtilityPid) throw new Error("Packaged App Server did not restart");

		phase = "quitting without an orphan";
		await browser.close();
		browser = undefined;
		await stopProcess(app);
		await expect.poll(() => processIsAlive(finalUtilityPid!)).toBe(false);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase} requests=${providerRequests}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fakeProvider);
		await rm(tempRoot, { recursive: true, force: true });
	}
});
