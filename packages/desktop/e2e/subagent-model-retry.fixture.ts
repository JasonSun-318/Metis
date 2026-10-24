import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { DomainEvent } from "@metis/app-protocol";
import type { Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeServer,
	listen,
	messageText,
	readOpenAiChatRequest,
	respondWithText,
	respondWithToolCall,
} from "./packaged-app-harness.ts";
import { createSubagentEnvironment } from "./subagent-conversations.fixture.ts";

export type RetryScenario = "recover" | "exhaust" | "stop" | "permanent" | "after-tool" | "timeout" | "child";
export const RETRY_SUCCESS = "retry-fixture-complete";
export const RETRY_CHILD = "Retry worker";

export async function retryFixture(scenario: RetryScenario) {
	const calls: { child: boolean; toolResults: number }[] = [];
	let rootCalls = 0;
	let childCalls = 0;
	const server = createServer(async (request, response) => {
		try {
			const payload = await readOpenAiChatRequest(request);
			const messages = payload.messages ?? [];
			const system = messages
				.filter((message) => message.role === "system" || message.role === "developer")
				.map((message) => messageText(message.content))
				.join("\n");
			if (system.includes("conversation title generator")) {
				respondWithText(response, "Retry test");
				return;
			}
			const child = system.includes("<agent_contract>") && system.includes(`You are agent "${RETRY_CHILD}"`);
			const index = child ? ++childCalls : ++rootCalls;
			const toolResults = messages.filter((message) => message.role === "tool").length;
			calls.push({ child, toolResults });
			if (scenario === "child" && !child) {
				if (index === 1)
					respondWithToolCall(response, {
						callId: "spawn-retry-worker",
						name: "spawn_agent",
						arguments: { name: RETRY_CHILD, agentType: "worker", task: "Read-only retry test. Reply briefly." },
					});
				else respondWithText(response, "Parent delegated and continues independently.");
				return;
			}
			if (scenario === "after-tool" && index === 1) {
				respondWithToolCall(response, {
					callId: "read-before-failure",
					name: "read",
					arguments: { path: "README.md" },
				});
				return;
			}
			if (scenario === "timeout" && index === 1) return; // The configured request timeout must abort this socket.
			const fail =
				scenario === "exhaust" ||
				scenario === "stop" ||
				scenario === "permanent" ||
				(scenario === "after-tool" ? index === 2 : scenario === "timeout" ? false : index <= 2);
			if (fail) {
				response.writeHead(scenario === "permanent" ? 401 : 503, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						error: { message: scenario === "permanent" ? "Invalid API key" : "Temporary service unavailable" },
					}),
				);
			} else respondWithText(response, RETRY_SUCCESS);
		} catch {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	});
	const port = await listen(server);
	let environment: Awaited<ReturnType<typeof createSubagentEnvironment>>;
	try {
		environment = await createSubagentEnvironment({
			providerId: "retry-fixture",
			modelId: "retry-model",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			apiKey: "local-fixture-key",
		});
		const settingsPath = path.join(environment.agentDir, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		await writeFile(
			settingsPath,
			JSON.stringify({
				...settings,
				retry: { enabled: true, baseDelayMs: scenario === "stop" ? 10_000 : scenario === "exhaust" ? 40 : 1000 },
				...(scenario === "timeout" ? { httpIdleTimeoutMs: 400 } : {}),
			}),
		);
	} catch (error) {
		await closeServer(server);
		throw error;
	}
	return { environment, calls, close: () => closeServer(server) };
}

type RetryGlobals = { metis: MetisDesktopApi; retryEvents: DomainEvent[] };
export async function observeRetryEvents(page: Page, sessionId: string) {
	await page.evaluate((sessionId) => {
		const globals = window as unknown as RetryGlobals;
		globals.retryEvents = [];
		globals.metis.subscribe((event) => {
			if (event.type !== "app-server" || event.envelope.method !== "connection/events") return;
			for (const change of event.envelope.params.events)
				if (
					"sessionId" in change &&
					change.sessionId === sessionId &&
					(change.type === "session/retryChanged" || change.type === "agent/updated")
				)
					globals.retryEvents.push(change);
		});
	}, sessionId);
}
export async function retryEvents(page: Page) {
	return page.evaluate(() => (window as unknown as RetryGlobals).retryEvents);
}
export async function rootRetrySnapshot(page: Page, sessionId: string) {
	return page.evaluate(
		async (sessionId) => (window as unknown as RetryGlobals).metis.openSession({ sessionId }),
		sessionId,
	);
}
