import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeSubagentApp,
	createSubagentSession,
	launchSubagentApp,
	listSubagents,
	openAgentConversation,
	type RunningSubagentApp,
	readSessionItems,
	removeSubagentEnvironment,
	saveSubagentEvidence,
	sendParentPrompt,
} from "./subagent-conversations.fixture.ts";
import { createReplayFixture, REPEAT_TASK, REPLAY_WORKER } from "./subagent-request-replay.fixture.ts";

type Globals = { metis: MetisDesktopApi };
for (const mode of ["chat", "code"] as const) {
	test(`${mode}: reuses an old child after process restart, deduplicates replay and aligns progress`, async ({}, testInfo) => {
		test.setTimeout(120_000);
		const fixture = await createReplayFixture();
		let app: RunningSubagentApp | undefined;
		try {
			app = await launchSubagentApp(fixture.environment);
			const sessionId = await createSubagentSession(
				app.page,
				fixture.environment,
				mode,
				`${mode} restart and replay`,
			);
			await sendParentPrompt(app.page, "REPLAY_PARENT_CREATE");
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.status).toBe("done");
			const child = (await listSubagents(app.page, sessionId))[0]!;
			fixture.setAgentId(child.agentId);
			await sendParentPrompt(app.page, "REPLAY_PARENT_REPEAT_BEFORE_RESTART");
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.tasks.length).toBe(2);
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.status).toBe("done");
			await closeSubagentApp(app);
			app = undefined;

			// A new Electron/App Server process opens the same profile and child JSONL.
			app = await launchSubagentApp(fixture.environment);
			if (mode === "code") await app.page.getByRole("button", { name: "Code", exact: true }).click();
			await expect(app.page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
			fixture.hold();
			await sendParentPrompt(app.page, "REPLAY_PARENT_REPEAT_AFTER_RESTART");
			await expect.poll(async () => fixture.calls.filter((call) => call.child).length).toBe(3);
			await openAgentConversation(app.page, REPLAY_WORKER);
			const conversation = app.page.locator(".agent-conversation:visible");
			await expect(conversation.locator(".transcript-scroll .turn-runtime-status")).toHaveCount(1);
			await expect(conversation.locator(".conversation-composer .turn-runtime-status")).toHaveCount(0);
			const progress = conversation.locator(".transcript-scroll .turn-runtime-status");
			const beforeScroll = (await progress.boundingBox())!.y;
			const scrollDelta = await conversation.locator(".transcript-scroll").evaluate((scroll) => {
				const before = scroll.scrollTop;
				scroll.scrollTop = Math.max(0, before - 40);
				return before - scroll.scrollTop;
			});
			expect(scrollDelta).toBeGreaterThan(0);
			await expect
				.poll(async () => Math.round((await progress.boundingBox())!.y - beforeScroll))
				.toBe(Math.round(scrollDelta));
			await conversation.locator(".transcript-scroll").evaluate((scroll) => {
				scroll.scrollTop = scroll.scrollHeight;
			});
			// The per-message timing menu was replaced by automatic queueing; a
			// running child's composer must offer the queue affordance after the
			// restart without mutating the durable queue.
			const composerInput = conversation.locator('[id^="agent-composer-"]');
			await composerInput.fill("Queued after restart");
			await expect(conversation.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
			await composerInput.fill("");
			await app.page.screenshot({ path: testInfo.outputPath(`${mode}-child-progress.png`) });
			fixture.release();
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.status).toBe("done");
			await expect(conversation.locator(".turn-runtime-status")).toHaveCount(0);
			const tasks = (await listSubagents(app.page, sessionId))[0]!.tasks;
			expect(tasks).toHaveLength(3);
			expect(tasks[1]!.taskId).not.toBe(tasks[2]!.taskId);
			expect(tasks[1]!.taskSummary).toBe(REPEAT_TASK);
			expect(tasks[2]!.taskSummary).toBe(REPEAT_TASK);
			expect(fixture.calls.filter((call) => call.child && call.prompt.includes(REPEAT_TASK))).toHaveLength(2);

			await conversation
				.locator(".agent-conversation-header")
				.getByRole("button", { name: "Open parent conversation", exact: true })
				.click();
			await sendParentPrompt(app.page, "REPLAY_PARENT_DIFFERENT_AFTER_RESTART");
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.tasks.length).toBe(4);
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.status).toBe("done");
			const parentItems = await readSessionItems(app.page, sessionId);
			expect(JSON.stringify(parentItems)).not.toContain("The request ID already belongs to different input");

			const input = {
				sessionId,
				agentId: child.agentId,
				requestId: randomUUID(),
				delivery: "queue" as const,
				input: { text: "REPLAY_TASK_EXPLICIT: Run exactly once." },
			};
			const receipt = await app.page.evaluate(
				(input) => (window as unknown as Globals).metis.sendAgentMessage(input),
				input,
			);
			const same = await app.page.evaluate(
				(input) => (window as unknown as Globals).metis.sendAgentMessage(input),
				input,
			);
			expect(same.messageId).toBe(receipt.messageId);
			expect(same.taskId).toBe(receipt.taskId);
			await expect.poll(async () => (await listSubagents(app!.page, sessionId))[0]?.status).toBe("done");
			const callsBeforeReplay = fixture.calls.filter((call) => call.child).length;
			expect(callsBeforeReplay).toBe(5);
			await closeSubagentApp(app);
			app = undefined;
			app = await launchSubagentApp(fixture.environment);
			if (mode === "code") await app.page.getByRole("button", { name: "Code", exact: true }).click();
			const afterRestart = await app.page.evaluate(
				(input) => (window as unknown as Globals).metis.sendAgentMessage(input),
				input,
			);
			expect(afterRestart.taskId).toBe(receipt.taskId);
			expect(afterRestart.messageId).toBe(receipt.messageId);
			expect(afterRestart.state).toBe("delivered");
			const conflict = await app.page.evaluate(async (input) => {
				try {
					await (window as unknown as Globals).metis.sendAgentMessage({
						...input,
						input: { text: "Changed input must be rejected" },
					});
					return "unexpected success";
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			}, input);
			expect(conflict).toMatch(/request ID.*reused/i);
			const final = (await listSubagents(app.page, sessionId))[0]!;
			expect(final.tasks).toHaveLength(5);
			expect(final.status).toBe("done");
			expect(fixture.calls.filter((call) => call.child).length).toBe(callsBeforeReplay);
			await saveSubagentEvidence(testInfo, `${mode}-restart-replay.json`, {
				tasks: final.tasks.map(({ taskId, status }) => ({ taskId, status })),
				childCalls: callsBeforeReplay,
				receipt,
				afterRestart,
				conflict,
			});
		} catch (error) {
			await saveSubagentEvidence(testInfo, `${mode}-replay-failure.json`, {
				calls: fixture.calls,
				diagnostics: fixture.environment.diagnostics,
			});
			throw error;
		} finally {
			fixture.release();
			if (app) await closeSubagentApp(app).catch(() => undefined);
			await fixture.close();
			await removeSubagentEnvironment(fixture.environment);
		}
	});
}
