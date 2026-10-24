import { expect, test } from "@playwright/test";
import {
	retryEvents,
	retryFixture,
	RETRY_CHILD,
	RETRY_SUCCESS,
	rootRetrySnapshot,
	observeRetryEvents,
	type RetryScenario,
} from "./subagent-model-retry.fixture.ts";
import {
	closeSubagentApp,
	createSubagentSession,
	launchSubagentApp,
	listSubagents,
	openAgentConversation,
	readSessionItems,
	removeSubagentEnvironment,
	saveSubagentEvidence,
	sendParentPrompt,
} from "./subagent-conversations.fixture.ts";
import { waitForServerReady } from "./packaged-app-harness.ts";

const cases: readonly ["chat" | "code", RetryScenario][] = [
	["chat", "recover"],
	["code", "recover"],
	["code", "exhaust"],
	["chat", "stop"],
	["code", "permanent"],
	["code", "after-tool"],
	["chat", "timeout"],
	["code", "child"],
];
for (const [mode, scenario] of cases)
	test(`${mode}: model retry ${scenario}`, async ({}, testInfo) => {
		test.setTimeout(90_000);
		const fixture = await retryFixture(scenario);
		let app: Awaited<ReturnType<typeof launchSubagentApp>> | undefined;
		let observedEvents: Awaited<ReturnType<typeof retryEvents>> = [];
		try {
			app = await launchSubagentApp(fixture.environment);
			const page = app.page;
			const sessionId = await createSubagentSession(page, fixture.environment, mode, `Retry ${scenario}`);
			await observeRetryEvents(page, sessionId);
			await sendParentPrompt(page, `RETRY_ACCEPTANCE_${scenario}`);
			const transcript = page.locator(".transcript:visible");
			if (scenario === "child") {
				await expect.poll(async () => (await listSubagents(page, sessionId)).length).toBe(1);
				await openAgentConversation(page, RETRY_CHILD);
				await expect(page.locator(".agent-conversation:visible .turn-runtime-status")).toHaveAttribute(
					"aria-label",
					/Retrying \([12]\/5\)/,
				);
				await expect(page.locator(".agent-conversation:visible .notice-error")).toHaveCount(0);
				await expect
					.poll(async () => (await listSubagents(page, sessionId))[0]?.status, { timeout: 20_000 })
					.toBe("done");
				expect(fixture.calls.filter((call) => call.child)).toHaveLength(3);
				expect((await retryEvents(page)).filter((event) => event.type === "session/retryChanged")).toHaveLength(0);
				expect(
					(await retryEvents(page)).some(
						(event) => event.type === "agent/updated" && event.agent.retry?.attempt === 1,
					),
				).toBe(true);
				await expect(transcript).toContainText(RETRY_SUCCESS);
				await expect(page.locator(".agent-conversation:visible .turn-runtime-status")).toHaveCount(0);
			} else if (scenario === "permanent") {
				await expect(transcript.locator(".notice-error")).toHaveCount(1);
				expect(fixture.calls).toHaveLength(1);
				expect(await retryEvents(page)).toHaveLength(0);
			} else {
				if (scenario !== "exhaust") {
					await expect(page.locator(".turn-runtime-status:visible")).toHaveAttribute(
						"aria-label",
						"Retrying (1/5)",
					);
					await expect(transcript.locator(".notice-error")).toHaveCount(0);
					const retry = (await rootRetrySnapshot(page, sessionId)).retry;
					expect(retry).toMatchObject({ attempt: 1, maxAttempts: 5 });
					await page.screenshot({ path: testInfo.outputPath(`${mode}-${scenario}-retry.png`) });
				}
				if (scenario === "stop") {
					await page.getByRole("button", { name: "Stop task", exact: true }).click();
					await expect.poll(async () => (await rootRetrySnapshot(page, sessionId)).activeTurnId).toBeNull();
					await expect(page.locator(".turn-runtime-status:visible")).toHaveCount(0);
					await page.waitForTimeout(300);
					expect(fixture.calls).toHaveLength(1);
					await expect(transcript.locator(".notice-error")).toHaveCount(0);
				} else if (scenario === "exhaust") {
					await expect(transcript.locator(".notice-error")).toHaveCount(1);
					expect(fixture.calls).toHaveLength(6);
					const events = await retryEvents(page);
					expect(
						events.flatMap((event) =>
							event.type === "session/retryChanged" && event.retry ? [event.retry.attempt] : [],
						),
					).toEqual([1, 2, 3, 4, 5]);
					await expect(page.locator(".turn-runtime-status:visible")).toHaveCount(0);
				} else {
					await expect(transcript).toContainText(RETRY_SUCCESS);
					await expect(transcript.locator(".notice-error")).toHaveCount(0);
					await expect(page.locator(".turn-runtime-status:visible")).toHaveCount(0);
					expect(fixture.calls).toHaveLength(scenario === "timeout" ? 2 : 3);
					if (scenario === "after-tool") {
						const results = (await readSessionItems(page, sessionId)).flatMap((item) =>
							item.content.filter((block) => block.type === "tool_result" && block.name === "read"),
						);
						expect(results).toHaveLength(1);
						expect(fixture.calls.slice(1).every((call) => call.toolResults === 1)).toBe(true);
					}
				}
				expect((await rootRetrySnapshot(page, sessionId)).retry).toBeUndefined();
				observedEvents = await retryEvents(page);
				if (scenario !== "stop") {
					await page.reload({ waitUntil: "domcontentloaded" });
					await waitForServerReady(page);
					if (mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
					await expect(transcript.locator(".notice-error")).toHaveCount(scenario === "exhaust" ? 1 : 0);
					if (scenario !== "exhaust") await expect(transcript).toContainText(RETRY_SUCCESS);
				}
			}
			await saveSubagentEvidence(testInfo, "model-retry-evidence.json", {
				mode,
				scenario,
				calls: fixture.calls,
				events: observedEvents.length > 0 ? observedEvents : await retryEvents(page),
			});
		} finally {
			if (app) await closeSubagentApp(app).catch(() => undefined);
			await fixture.close();
			await removeSubagentEnvironment(fixture.environment);
		}
	});
