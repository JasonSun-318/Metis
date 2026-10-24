import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
	type AgentRecord,
	closeSubagentApp,
	controlSubagent,
	createSubagentEnvironment,
	createSubagentModelServer,
	createSubagentSession,
	launchSubagentApp,
	listSubagents,
	modelRequestSummary,
	nativeWindowBounds,
	openAgentConversation,
	readSessionItems,
	readSubagentItems,
	removeSubagentEnvironment,
	saveSubagentEvidence,
	sendParentPrompt,
	SUBAGENT_CUSTOM_ROLE,
	SUBAGENT_FIXTURE,
	type SubagentMode,
	upsertFixtureRole,
	waitForModelRequest,
} from "./subagent-conversations.fixture.ts";
import { waitForServerReady } from "./packaged-app-harness.ts";

const PROVIDER_ID = "subagentFixture";
const MODEL_ID = "subagent-fixture";

async function waitForAgents(
	page: Page,
	sessionId: string,
	predicate: (agents: readonly AgentRecord[]) => boolean,
	timeoutMs = 30_000,
): Promise<AgentRecord[]> {
	const deadline = Date.now() + timeoutMs;
	let last: AgentRecord[] = [];
	while (Date.now() < deadline) {
		last = await listSubagents(page, sessionId);
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(
		`Timed out waiting for agent state after ${timeoutMs}ms: ${JSON.stringify(last.map((agent) => ({ name: agent.name, status: agent.status })))}`,
	);
}

function agentByName(agents: readonly AgentRecord[], name: string): AgentRecord {
	const found = agents.find((agent) => agent.name === name);
	if (!found) throw new Error(`Missing agent ${name}: ${JSON.stringify(agents.map((agent) => agent.name))}`);
	return found;
}

function itemText(item: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }): string {
	return item.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

async function verifyRunningSidebar(page: Page, parentName: string, child: AgentRecord, testInfo: TestInfo): Promise<void> {
	const childComposer = page.locator(`#agent-composer-${child.agentId}`);
	const childRow = page.getByRole("treeitem", { name: child.name, exact: true });
	const light = childRow.locator(".session-button-title > i.running");
	await expect(light).toHaveCount(1);
	await expect(childRow.locator(".agent-sidebar-status, .agent-sidebar-unread, .is-spinning")).toHaveCount(0);
	const color = await light.evaluate((element) => {
		const hex = getComputedStyle(element).getPropertyValue("--run-running").trim();
		return { actual: getComputedStyle(element).backgroundColor,
			expected: `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})` };
	});
	expect(color.actual).toBe(color.expected);
	const originalMotion = await page.evaluate(() => document.documentElement.dataset.motion);
	try {
		await page.evaluate(() => { document.documentElement.dataset.motion = "full"; });
		await expect(light).toHaveCSS("animation-name", "session-running-pulse");
		await expect(light).toHaveCSS("animation-duration", "1.4s");
		const initialOpacity = await light.evaluate((element) => Number(getComputedStyle(element).opacity));
		await expect.poll(async () => Math.abs(await light.evaluate((element) => Number(getComputedStyle(element).opacity)) - initialOpacity),
			{ timeout: 3_000, intervals: [80] }).toBeGreaterThan(0.08);
		await page.evaluate(() => { document.documentElement.dataset.motion = "reduced"; });
		await expect(light).toHaveCSS("animation-name", "none");
	} finally {
		await page.evaluate((motion) => {
			if (motion === undefined) delete document.documentElement.dataset.motion;
			else document.documentElement.dataset.motion = motion;
		}, originalMotion);
	}

	const rootRow = page.getByRole("button", { name: parentName, exact: true }).locator("..");
	const toggle = rootRow.locator(":scope > .agent-root-toggle");
	const more = rootRow.locator(":scope > .session-actions > button");
	await rootRow.hover();
	await expect(more).toHaveCSS("opacity", "1");
	await expect.poll(() => more.evaluate((element) => {
		const transform = getComputedStyle(element).transform;
		return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
	})).toBe(true);
	const geometry = await rootRow.evaluate((row) => {
		const rect = (selector: string) => {
			const bounds = row.querySelector(selector)!.getBoundingClientRect();
			return { x: bounds.x, right: bounds.right, y: bounds.y, height: bounds.height, width: bounds.width };
		};
		return { toggle: rect(":scope > .agent-root-toggle"), more: rect(":scope > .session-actions > button"), glyph: rect(".agent-root-toggle svg") };
	});
	expect(geometry.more.right).toBeLessThanOrEqual(geometry.toggle.x + 0.5);
	expect(Math.abs(geometry.toggle.y + geometry.toggle.height / 2 - geometry.more.y - geometry.more.height / 2)).toBeLessThan(1);
	expect(geometry.toggle).toMatchObject({ width: 24, height: 24 });
	expect(geometry.glyph.width).toBe(10);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(childRow).toHaveCount(0);
	await expect(childComposer, "collapsing children must not navigate to the parent").toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(childRow).toBeVisible();
	await expect(childComposer).toBeVisible();
	await saveSubagentEvidence(testInfo, `subagent-${child.mode ?? "child"}-sidebar-geometry.json`, geometry);
}

async function verifyAgentControls(page: Page, child: AgentRecord): Promise<void> {
	const conversation = page.locator(`[data-agent-id="${child.agentId}"]`);
	await expect(conversation.locator(".agent-conversation-capabilities")).toHaveCount(0);
	await expect(conversation).not.toContainText("Sent to the agent’s model");
	await expect(conversation).not.toContainText("Sent to model");
	const detailsButton = conversation.getByRole("button", { name: "Agent details", exact: true });
	await detailsButton.click();
	const details = page.getByRole("dialog", { name: "Agent details", exact: true });
	await expect(details).toBeVisible();
	await expect(details.getByText("Tools", { exact: true })).toBeVisible();
	await expect(details.locator("dd").filter({ hasText: /\bbash\b/ })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(details).toHaveCount(0);
	await expect(detailsButton).toBeFocused();

	const timing = conversation.getByRole("button", { name: "Message timing", exact: true });
	await timing.click();
	const choices = page.getByRole("listbox", { name: "Message timing", exact: true });
	const steer = choices.getByRole("option", { name: /^During current task/ });
	const queue = choices.getByRole("option", { name: /^After current task/ });
	await expect(steer).toHaveAttribute("aria-description", "The agent reads your message after its current step. Use Stop to interrupt immediately.");
	await expect(queue).toHaveAttribute("aria-description", "Start a follow-up after this task finishes.");
	await expect(steer.locator("small")).toBeVisible();
	await expect(queue.locator("small")).toBeVisible();
	await queue.click();
	await expect(timing).toContainText("After current task");
	await timing.click();
	await steer.click();
	await expect(timing).toContainText("During current task");
	await expect(timing).toBeFocused();
}

async function verifyNativeWindowLayout(app: Awaited<ReturnType<typeof launchSubagentApp>>, testInfo: TestInfo): Promise<void> {
	const page = app.page;
	const settleSidebar = async () => {
		await expect.poll(() => page.locator(".session-sidebar").evaluate((element) => {
			const transform = getComputedStyle(element).transform;
			return (transform === "none" || new DOMMatrixReadOnly(transform).isIdentity) &&
				element.getBoundingClientRect().left >= 0;
		})).toBe(true);
		return page.evaluate(() => ({
			scrollX: window.scrollX,
			documentScrollLeft: document.scrollingElement?.scrollLeft,
			sidebarLeft: document.querySelector(".session-sidebar")!.getBoundingClientRect().left,
		}));
	};
	const bounds = process.platform === "darwin" && process.env.METIS_NATIVE_WINDOW_TEST === "1" ? await nativeWindowBounds(app) : undefined;
	const geometry: unknown[] = [];
	try {
		for (const size of bounds ? [{ width: 1060, height: 720 }, { width: 1360, height: 900 }, { width: 1100, height: 760 }] : []) {
			await nativeWindowBounds(app, size);
			await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
			const measured = await page.evaluate(() => {
				const shell = document.querySelector<HTMLElement>(".app-shell")!;
				const rect = shell.getBoundingClientRect();
				return { width: window.innerWidth, height: window.innerHeight, shellWidth: rect.width, shellBottom: rect.bottom,
					sidebarWidth: getComputedStyle(shell).getPropertyValue("--sidebar-width").trim() };
			});
			expect(Math.abs(measured.shellWidth - measured.width)).toBeLessThan(2);
			expect(Math.abs(measured.shellBottom - measured.height)).toBeLessThan(2);
			expect(measured.sidebarWidth).toBe("232px");
			geometry.push(measured);
			await expect(page.locator(".agent-sidebar-open").first()).toBeVisible();
		}
		await saveSubagentEvidence(testInfo, "subagent-native-window-geometry.json", geometry);
		const darkSidebar = await settleSidebar();
		await page.screenshot({ path: testInfo.outputPath("subagent-dark-narrow.png") });
		await page.evaluate(() => localStorage.setItem("metis.theme.v1", "light"));
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForServerReady(page);
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
		await expect(page.locator(".agent-sidebar-open").first()).toBeVisible();
		const lightSidebar = await settleSidebar();
		await page.screenshot({ path: testInfo.outputPath("subagent-light-narrow.png") });
		expect(darkSidebar.scrollX).toBe(0);
		expect(darkSidebar.documentScrollLeft).toBe(0);
		expect(lightSidebar.scrollX).toBe(0);
		expect(lightSidebar.documentScrollLeft).toBe(0);
		await saveSubagentEvidence(testInfo, "subagent-sidebar-settled.json", { darkSidebar, lightSidebar });
	} finally {
		if (bounds) await nativeWindowBounds(app, bounds);
	}
}

async function verifyConversationMotion(page: Page, agents: readonly AgentRecord[], testInfo: TestInfo): Promise<void> {
	const original = await page.evaluate(() => document.documentElement.dataset.motion);
	try {
		await page.evaluate(() => { document.documentElement.dataset.motion = "full"; });
		const sampling = page.evaluate(async () => {
			const frames: number[] = [];
			const layouts = new Set<string>();
			const start = performance.now();
			let previous = start;
			await new Promise<void>((resolve) => {
				const tick = (now: number) => {
					frames.push(now - previous);
					previous = now;
					const panel = Array.from(document.querySelectorAll<HTMLElement>(".workspace-panel:not([hidden])"))
						.find((element) => element.getBoundingClientRect().width > 0);
					if (panel) {
						const rect = panel.getBoundingClientRect();
						layouts.add([rect.x, rect.y, rect.width, rect.height].map(Math.round).join(","));
					}
					if (now - start < 1_200) requestAnimationFrame(tick);
					else resolve();
				};
				requestAnimationFrame(tick);
			});
			return { frameIntervalsMs: frames.slice(1), panelBounds: [...layouts] };
		});
		for (const agent of [agents[0]!, agents[1]!, agents[0]!]) {
			await openAgentConversation(page, agent.name);
			await expect(page.locator(`#agent-composer-${agent.agentId}`)).toBeVisible();
		}
		const samples = await sampling;
		expect(samples.panelBounds, "switching children must not move or resize the conversation panel").toHaveLength(1);
		const active = page.locator(`#agent-composer-${agents[0]!.agentId}`);
		const full = await active.evaluate((element) => {
			const style = getComputedStyle(element.closest(".workspace-panel")!);
			return { name: style.animationName, duration: style.animationDuration, transform: style.transform,
				stationary: style.transform === "none" || new DOMMatrixReadOnly(style.transform).isIdentity };
		});
		expect(full).toMatchObject({ name: "tool-panel-in", duration: "0.14s", stationary: true });
		await page.evaluate(() => { document.documentElement.dataset.motion = "reduced"; });
		await openAgentConversation(page, agents[1]!.name);
		await expect(page.locator(`#agent-composer-${agents[1]!.agentId}`)).toBeVisible();
		const reduced = await page.locator(`#agent-composer-${agents[1]!.agentId}`).evaluate((element) =>
			getComputedStyle(element.closest(".workspace-panel")!).animationName);
		expect(reduced).toBe("none");
		await saveSubagentEvidence(testInfo, "subagent-motion-qa.json", { ...samples, full, reduced, renderer: "isolated Electron with software rendering" });
	} finally {
		await page.evaluate((value) => {
			if (value === undefined) delete document.documentElement.dataset.motion;
			else document.documentElement.dataset.motion = value;
		}, original);
	}
}

for (const mode of ["chat", "code"] as const) {
	test(`${mode}: creates two persistent children, keeps parent work parallel, and applies a user correction`, async ({}, testInfo) => {
		test.setTimeout(240_000);
		const model = await createSubagentModelServer();
		const environment = await createSubagentEnvironment({
			providerId: PROVIDER_ID,
			modelId: MODEL_ID,
			baseUrl: `http://127.0.0.1:${model.port}/v1`,
			apiKey: "subagent-fixture-key",
		});
		let app: Awaited<ReturnType<typeof launchSubagentApp>> | undefined;
		try {
			app = await launchSubagentApp(environment);
			await upsertFixtureRole(app.page);
			const parentName = `${mode} subagent parent`;
			const parentId = await createSubagentSession(app.page, environment, mode, parentName);
			const page = app.page;

			await sendParentPrompt(page, SUBAGENT_FIXTURE.start);
			await waitForModelRequest(
				model,
				(request) =>
					!request.isChild &&
					request.spawnNames.includes("spawn_agent") &&
					!request.mailboxEvents.some((event) => event.type === "intervention"),
				30_000,
			);
			const running = await waitForAgents(
				page,
				parentId,
				(agents) => agents.length === 2 && agents.some((agent) => agent.status === "running" || agent.status === "queued"),
			);
			expect(
				running.some((agent) => agent.status === "running" || agent.status === "queued"),
				"the parent completed independent work while both children were still active",
			).toBe(true);

			const alpha = agentByName(running, SUBAGENT_FIXTURE.alphaName);
			const beta = agentByName(running, SUBAGENT_FIXTURE.betaName);
			expect(alpha.agentType).toBe("worker");
			expect(beta.agentType).toBe(SUBAGENT_CUSTOM_ROLE.id);
			expect(alpha.parentSessionId).toBe(parentId);
			expect(beta.rootSessionId).toBe(parentId);
			expect(alpha.model).toMatchObject({ provider: PROVIDER_ID, modelId: MODEL_ID });
			expect(beta.model).toMatchObject({ provider: PROVIDER_ID, modelId: MODEL_ID });
			if (alpha.mode !== undefined) expect(alpha.mode).toBe(mode);

			const parentStart = model.requests.find(
				(request) => !request.isChild && request.userTexts.some((text) => text.includes(SUBAGENT_FIXTURE.start)),
			);
			expect(parentStart, "parent model request was not recorded").toBeTruthy();
			const parentSystem = parentStart?.system ?? "";
			expect(parentSystem).toContain("<agent_coordination>");
			for (const role of ["default", "explorer", "worker", "reviewer", SUBAGENT_CUSTOM_ROLE.id])
				expect(parentSystem).toContain(`${role}:`);
			expect(parentSystem).toContain("purpose=");
			expect(parentSystem).toContain("effective tools=");
			expect(parentStart?.toolNames).toEqual(
				expect.arrayContaining([
					"spawn_agent",
					"inspect_agents",
					"send_message",
					"followup_task",
					"wait_agents",
					"interrupt_agent",
				]),
			);

			const alphaRequest = await waitForModelRequest(
				model,
				(request) => request.isChild && request.agentId === alpha.agentId,
				30_000,
			);
			expect(alphaRequest.system).toContain("<agent_contract>");
			expect(alphaRequest.system).toContain(`You are agent "${alpha.name}" ("${alpha.agentId}")`);
			expect(alphaRequest.system).toContain(parentId);
			expect(alphaRequest.system).toContain('"name":"worker"');
			expect(alphaRequest.system).toContain("Produce the assigned outcome");
			expect(alphaRequest.userTexts.join("\n")).toContain("ALPHA_TASK");
			expect(alphaRequest.toolNames).toContain("bash");

			const betaRequest = await waitForModelRequest(
				model,
				(request) => request.isChild && request.agentId === beta.agentId,
				30_000,
			);
			expect(betaRequest.system).toContain("<agent_contract>");
			expect(betaRequest.system).toContain(`You are agent "${beta.name}" ("${beta.agentId}")`);
			expect(betaRequest.system).toContain(`"name":"${SUBAGENT_CUSTOM_ROLE.id}"`);
			expect(betaRequest.system).toContain(SUBAGENT_CUSTOM_ROLE.systemPrompt);
			expect(betaRequest.userTexts.join("\n")).toContain("BETA_TASK");
			expect(betaRequest.toolNames).not.toContain("spawn_agent");
			expect(betaRequest.toolNames).toEqual(expect.arrayContaining(["read", "grep", "bash"]));

			await waitForAgents(
				page,
				parentId,
				(agents) =>
					agents.some((agent) => agent.agentId === alpha.agentId && agent.status === "running"),
				20_000,
			);

			await openAgentConversation(page, alpha.name);
			const childConversation = page.locator(`[data-agent-id="${alpha.agentId}"]`);
			await expect(childConversation).toBeVisible();
			const childComposer = page.locator(`#agent-composer-${alpha.agentId}`);
			await expect(childComposer).toHaveAttribute("contenteditable", "true");
			await verifyRunningSidebar(page, parentName, alpha, testInfo);
			await verifyAgentControls(page, alpha);
			await childComposer.fill(SUBAGENT_FIXTURE.correction);
			await expect(childConversation.getByRole("button", { name: "Stop agent", exact: true })).toBeEnabled();
			await childConversation.getByRole("button", { name: "Queue message", exact: true }).click();

			const intervention = await waitForModelRequest(
				model,
				(request) =>
					!request.isChild &&
					request.mailboxEvents.some(
						(event) => event.type === "intervention" && event.text?.includes("CORRECTION-ALPHA"),
					),
				30_000,
			);
			const interventionEvent = intervention.mailboxEvents.find(
				(event) => event.type === "intervention" && event.text?.includes("CORRECTION-ALPHA"),
			);
			expect(interventionEvent).toBeTruthy();
			expect(interventionEvent?.agentId).toBe(alpha.agentId);
			expect(interventionEvent?.taskId).toBeTruthy();
			expect(interventionEvent?.instructionRevision).toBe(2);
			expect(interventionEvent?.delivery).toBe("steer");
			expect(interventionEvent?.messageId).toBeTruthy();

			const completed = await waitForAgents(
				page,
				parentId,
				(agents) => agents.every((agent) => agent.status === "done"),
				90_000,
			);
			const finishedAlpha = agentByName(completed, alpha.name);
			const finishedBeta = agentByName(completed, beta.name);
			expect(
				[finishedAlpha.latestTask?.finalMessage, finishedAlpha.currentTask?.finalMessage].some((message) =>
					message?.includes("CORRECTION-ALPHA"),
				),
			).toBe(true);
			expect(
				[finishedBeta.latestTask?.finalMessage, finishedBeta.currentTask?.finalMessage].some(
					(message) => (message?.length ?? 0) > 0,
				),
			).toBe(true);
			const alphaTask = finishedAlpha.tasks.find((task) => task.taskId === interventionEvent?.taskId);
			expect(alphaTask?.instructionRevision).toBe(2);
			expect(alphaTask?.consumedInstructionRevision).toBeGreaterThanOrEqual(2);

			await expect
				.poll(
					async () => {
						const parentItems = await readSessionItems(page, parentId);
						return parentItems.some(
							(item) => item.role === "assistant" && itemText(item).includes("parent-saw-intervention"),
						);
					},
					{ timeout: 30_000 },
				)
				.toBe(true);

			const items = await readSubagentItems(page, parentId, alpha.agentId);
			const initialItem = items.find(
				(item) => item.role === "user" && itemText(item).includes("ALPHA_TASK"),
			);
			expect(initialItem?.origin).toMatchObject({ kind: "agent", sessionId: parentId });
			const correctionItem = items.find(
				(item) => item.role === "user" && itemText(item).includes("CORRECTION-ALPHA"),
			);
			expect(correctionItem?.origin).toMatchObject({ kind: "user" });
			expect(correctionItem?.agentMessageId).toBe(interventionEvent?.messageId);
			expect(correctionItem?.instructionRevision).toBe(2);
			expect(correctionItem?.deliveryState).toBe("delivered");

			for (const request of model.requests) {
				expect(JSON.stringify(request.messages), "packaged native tools must not fail their integrity checks").not.toContain("Incomplete Metis installation");
				const eventIds = request.mailboxEvents.map((event) => event.eventId);
				expect(new Set(eventIds).size, "one prompt must not inject the same mailbox event twice").toBe(
					eventIds.length,
				);
			}

			const childDraft = `${mode} child draft stays isolated`;
			const parentDraft = `${mode} parent draft stays isolated`;
			await childComposer.fill(childDraft);
			await childConversation.getByRole("button", { name: "Open parent conversation" }).first().click();
			const parentComposer = page.locator("#composer-input");
			await expect(parentComposer).toBeVisible();
			const parentItems = await readSessionItems(page, parentId);
			const internal = parentItems.filter((item) => item.role === "system" && item.origin?.kind === "system" && item.agentTargetId);
			expect(internal.length, "durable parent history must retain intervention and both terminal notices").toBeGreaterThanOrEqual(3);
			expect(internal.some((item) => item.agentMessageId === interventionEvent?.messageId)).toBe(true);
			expect(internal.some((item) => itemText(item).includes("child-final alpha"))).toBe(true);
			expect(internal.some((item) => itemText(item).includes("child-final beta"))).toBe(true);
			const parentTranscript = page.locator(".transcript:visible");
			await expect(parentTranscript).toContainText("parent-saw-intervention");
			await expect(parentTranscript.locator(".agent-coordination-message")).toHaveCount(0);
			await expect(parentTranscript).not.toContainText("You sent a message to");
			await expect(parentTranscript).not.toContainText("child-final alpha");
			await expect(parentTranscript).not.toContainText("child-final beta");
			const betaLight = page.getByRole("treeitem", { name: beta.name, exact: true }).locator(".session-button-title > i");
			await expect(betaLight).toHaveClass("completed");
			await parentComposer.fill(parentDraft);
			await openAgentConversation(page, alpha.name);
			await expect(page.locator(`[data-agent-id="${alpha.agentId}"]`)).toBeVisible();
			await expect(page.locator(`#agent-composer-${alpha.agentId}`)).toHaveText(childDraft);
			await page
				.locator(`[data-agent-id="${alpha.agentId}"]`)
				.getByRole("button", { name: "Open parent conversation" })
				.first()
				.click();
			await expect(page.locator("#composer-input")).toHaveText(parentDraft);

			const beforeColdRead = model.requests.length;
			await readSubagentItems(page, parentId, alpha.agentId);
			await readSessionItems(page, parentId);
			await listSubagents(page, parentId);
			await page.waitForTimeout(1_500);
			expect(model.requests.length, "cold history reads must not start a model request").toBe(beforeColdRead);

			await page.screenshot({ path: testInfo.outputPath(`subagent-${mode}-parent.png`) });
			if (mode === "chat") await page.evaluate(() => localStorage.setItem("metis.session-sidebar-width.v1", "232"));
			await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
			await waitForServerReady(page);
			if (mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
			await expect(page.locator(`[data-active-session-id="${parentId}"]`)).toBeVisible();
			await openAgentConversation(page, alpha.name);
			await expect(page.locator(`[data-agent-id="${alpha.agentId}"]`)).toBeVisible();
			await expect(page.locator(`#agent-composer-${alpha.agentId}`)).toBeVisible();
			await page.waitForTimeout(1_500);
			expect(model.requests.length, "opening cold child history must not start a model request").toBe(beforeColdRead);
			await expect(page.locator(`#agent-composer-${alpha.agentId}`), "cold navigation must retain the selected child").toBeVisible();
			await page.screenshot({ path: testInfo.outputPath(`subagent-${mode}-child-cold-history.png`) });
			if (mode === "chat") {
				await verifyConversationMotion(page, [alpha, agentByName(completed, SUBAGENT_FIXTURE.betaName)], testInfo);
				expect(model.requests.length, "switching children and motion preferences must not call a model").toBe(beforeColdRead);
				await verifyNativeWindowLayout(app, testInfo);
				expect(model.requests.length, "layout and theme changes must not call a model").toBe(beforeColdRead);
			}

			await saveSubagentEvidence(testInfo, `subagent-${mode}-model.json`, modelRequestSummary(model));
			await saveSubagentEvidence(testInfo, `subagent-${mode}-agents.json`, completed);
			await saveSubagentEvidence(
				testInfo,
				`subagent-${mode}-parent-items.json`,
				await readSessionItems(page, parentId),
			);
		} finally {
			if (app) {
				await app.page.screenshot({ path: testInfo.outputPath("subagent-last.png") }).catch(() => undefined);
				await saveSubagentEvidence(testInfo, "subagent-last-model.json", modelRequestSummary(model)).catch(
					() => undefined,
				);
				await closeSubagentApp(app).catch(() => undefined);
			}
			await model.close();
			await removeSubagentEnvironment(environment);
		}
	});
}

for (const target of ["child", "root"] as const) {
	test(`stop from ${target} conversation prevents automatic model turns`, async ({}, testInfo) => {
		test.setTimeout(120_000);
		const model = await createSubagentModelServer();
		const environment = await createSubagentEnvironment({
			providerId: PROVIDER_ID,
			modelId: MODEL_ID,
			baseUrl: `http://127.0.0.1:${model.port}/v1`,
			apiKey: "subagent-fixture-key",
		});
		let app: Awaited<ReturnType<typeof launchSubagentApp>> | undefined;
		try {
			app = await launchSubagentApp(environment);
			await upsertFixtureRole(app.page);
			const parentId = await createSubagentSession(app.page, environment, "chat", "subagent stop parent");
			const page = app.page;

			await sendParentPrompt(page, SUBAGENT_FIXTURE.stop);
			const running = await waitForAgents(
				page,
				parentId,
				(agents) => agents.length === 1 && agents[0]?.status === "running",
				30_000,
			);
			const child = running[0]!;
			await openAgentConversation(page, child.name);
			const childConversation = page.locator(`[data-agent-id="${child.agentId}"]`);
			await expect(childConversation).toBeVisible();
			if (target === "child") {
				const draft = page.locator(`#agent-composer-${child.agentId}`);
				await expect(draft).toHaveAttribute("contenteditable", "true");
				await draft.fill("Keep this unsent draft when the task stops");
				const stop = childConversation.getByRole("button", { name: "Stop agent", exact: true });
				await expect(stop).toBeVisible();
				await expect(stop).toBeEnabled();
				await stop.click();
				await expect(draft).toHaveText("Keep this unsent draft when the task stops");
			}
			else await controlSubagent(page, parentId, parentId, "stop", "subtree");

			const stopped = await waitForAgents(
				page,
				parentId,
				(agents) => agents.every((agent) => agent.status === "stopped"),
				15_000,
			);
			expect(stopped[0]?.runControl).toBe("user_paused");
			await page.waitForTimeout(500);
			const requestsAfterStop = model.requests.length;
			await page.waitForTimeout(4_000);
			expect(
				model.requests.length,
				"a user stop must not trigger an automatic parent or child model turn",
			).toBe(requestsAfterStop);

			if (target === "root") {
				await expect(controlSubagent(page, parentId, child.agentId, "resume", "self")).rejects.toThrow();
				await controlSubagent(page, parentId, parentId, "resume", "self");
				expect((await listSubagents(page, parentId))[0]?.runControl).toBe("user_paused");
			}
			await controlSubagent(page, parentId, child.agentId, "resume", "self");
			const resumed = await waitForAgents(
				page,
				parentId,
				(agents) => agents.every((agent) => agent.runControl === "enabled" || agent.status === "running"),
				15_000,
			);
			expect(resumed[0]?.runControl).toBe("enabled");
			await saveSubagentEvidence(testInfo, "subagent-stop-model.json", modelRequestSummary(model));
			await page.screenshot({ path: testInfo.outputPath("subagent-stop.png") });
		} finally {
			if (app) {
				await app.page.screenshot({ path: testInfo.outputPath("subagent-stop-last.png") }).catch(() => undefined);
				await closeSubagentApp(app).catch(() => undefined);
			}
			await model.close();
			await removeSubagentEnvironment(environment);
		}
	});

}

for (const mode of ["chat", "code"] as const) {
	test(`${mode}: displays a provider failure and retains the safe notice after recovery and reload`, async ({}, testInfo) => {
		test.setTimeout(90_000);
		const model = await createSubagentModelServer();
		const environment = await createSubagentEnvironment({
			providerId: PROVIDER_ID,
			modelId: MODEL_ID,
			baseUrl: `http://127.0.0.1:${model.port}/v1`,
			apiKey: "subagent-fixture-key",
		});
		const noticeText = "The model provider could not complete the request. Try again or choose another configured model.";
		let app: Awaited<ReturnType<typeof launchSubagentApp>> | undefined;
		try {
			app = await launchSubagentApp(environment);
			const page = app.page;
			const sessionId = await createSubagentSession(page, environment, mode, `${mode} provider failure`);
			await sendParentPrompt(page, SUBAGENT_FIXTURE.providerFailure);
			await waitForModelRequest(model, (request) =>
				!request.isChild && !request.system.includes("conversation title generator") &&
				request.userTexts.at(-1)?.includes(SUBAGENT_FIXTURE.providerFailure) === true, 15_000);
			await expect.poll(async () => (await readSessionItems(page, sessionId)).some((item) =>
				item.role === "assistant" && item.state === "interrupted" &&
				item.content.some((block) => block.type === "notice" && block.level === "error" && block.text === noticeText)),
				{ timeout: 20_000 }).toBe(true);
			const failure = (await readSessionItems(page, sessionId)).find((item) =>
				item.content.some((block) => block.type === "notice" && block.text === noticeText))!;
			const transcript = page.locator(".transcript:visible");
			await expect(transcript.locator(".notice-error")).toHaveText(noticeText);
			await expect(transcript.locator("[data-transcript-answer]")).toHaveCount(0);
			await expect(transcript).not.toContainText("Fixture provider unavailable");
			expect(model.requests.filter((request) => !request.isChild &&
				!request.system.includes("conversation title generator") &&
				request.userTexts.at(-1)?.includes(SUBAGENT_FIXTURE.providerFailure))).toHaveLength(1);

			await sendParentPrompt(page, SUBAGENT_FIXTURE.providerRecovery);
			await expect(transcript.locator("[data-transcript-answer]")).toHaveText("provider-recovery-complete");
			await expect(transcript.locator(".notice-error")).toHaveText(noticeText);
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForServerReady(page);
			if (mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
			await expect(page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
			await expect(transcript.locator(".notice-error")).toHaveText(noticeText);
			await expect(transcript.locator("[data-transcript-answer]")).toHaveText("provider-recovery-complete");
			expect((await readSessionItems(page, sessionId)).find((item) => item.itemId === failure.itemId)?.content)
				.toContainEqual({ type: "notice", level: "error", text: noticeText });
			await saveSubagentEvidence(testInfo, `provider-failure-${mode}-model.json`, modelRequestSummary(model));
			await page.screenshot({ path: testInfo.outputPath(`provider-failure-${mode}.png`) });
		} finally {
			if (app) await closeSubagentApp(app).catch(() => undefined);
			await model.close();
			await removeSubagentEnvironment(environment);
		}
	});
}
