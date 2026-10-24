import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
	type AgentRecord,
	closeSubagentApp,
	createRealModelProxy,
	createSubagentEnvironment,
	createSubagentSession,
	launchSubagentApp,
	listSubagents,
	loadRealModelConfig,
	modelRequestSummary,
	openAgentConversation,
	readSessionItems,
	readSubagentItems,
	removeSubagentEnvironment,
	saveSubagentEvidence,
	sendParentPrompt,
	sendSubagentCorrection,
	sessionModel,
	type SubagentMode,
	upsertSubagentRole,
	waitForModelRequest,
} from "./subagent-conversations.fixture.ts";
import { waitForServerReady } from "./packaged-app-harness.ts";

const REAL_START = "SUBAGENT_REAL_START";
const REAL_FINAL = "SUBAGENT_REAL_FINAL";
const REAL_ROLE = {
	id: "release-auditor",
	displayName: "Release Auditor",
	description: "Read-only release evidence audit for the real-model subagent acceptance run.",
	allowedTools: ["read", "grep", "bash"],
	systemPrompt:
		"Release auditor: verify evidence with read-only checks. Report concrete sources, observed facts, and remaining uncertainty. Do not modify files or delegate.",
	writePolicy: "deny" as const,
	mayDelegate: false,
} as const;

async function waitForAgents(
	page: Page,
	sessionId: string,
	predicate: (agents: readonly AgentRecord[]) => boolean,
	timeoutMs: number,
): Promise<AgentRecord[]> {
	const deadline = Date.now() + timeoutMs;
	let last: AgentRecord[] = [];
	while (Date.now() < deadline) {
		last = await listSubagents(page, sessionId);
		if (predicate(last)) return last;
		if (last.length === 0) {
			const items = await readSessionItems(page, sessionId);
			if (items.filter((item) => item.role === "assistant").at(-1)?.state === "failed")
				throw new Error("Configured real model failed before creating child conversations; inspect the saved request evidence and provider status.");
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`Timed out waiting for real-model agent state: ${JSON.stringify(last.map((agent) => ({ name: agent.name, status: agent.status, role: agent.agentType })))}`,
	);
}

function isTerminal(agent: AgentRecord): boolean {
	return agent.status === "done" || agent.status === "failed" || agent.status === "stopped";
}

function itemText(item: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }): string {
	return item.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

async function waitForParentFinal(page: Page, sessionId: string, marker: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const items = await readSessionItems(page, sessionId);
		const latestAssistant = items.filter((item) => item.role === "assistant").at(-1);
		if (latestAssistant?.state === "failed")
			throw new Error("Configured real model failed before its final handoff; inspect the saved request evidence and provider status.");
		const assistants = items.filter((item) => item.role === "assistant" && item.state === "completed");
		const latest = assistants.at(-1);
		last = latest ? itemText(latest) : "";
		if (last.includes(marker)) return;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`Parent did not emit ${marker}; last assistant text was:\n${last.slice(-4_000)}`);
}

for (const mode of ["chat", "code"] as const) {
	test(`${mode}: configured deepseek-v4.1-flash autonomously creates and reconciles audited children`, async ({}, testInfo) => {
		test.skip(
			process.env.METIS_SUBAGENT_REAL_MODEL_TEST !== "1",
			"Explicit opt-in for a real configured model and quota",
		);
		test.setTimeout(1_200_000);

		const configDir = process.env.METIS_SUBAGENT_MODEL_CONFIG_DIR;
		expect(configDir, "METIS_SUBAGENT_MODEL_CONFIG_DIR is required").toBeTruthy();
		expect(path.isAbsolute(configDir ?? ""), "METIS_SUBAGENT_MODEL_CONFIG_DIR must be absolute").toBe(true);
		const real = await loadRealModelConfig(configDir!);
		expect(real.modelId, "the real subagent acceptance model is fixed by the plan").toBe("deepseek-v4.1-flash");

		const proxy = await createRealModelProxy(real.provider.baseUrl);
		const environment = await createSubagentEnvironment({
			providerId: real.providerId,
			modelId: real.modelId,
			baseUrl: proxy.url,
			...(real.provider.apiKey === undefined ? {} : { apiKey: real.provider.apiKey }),
			providerConfig: real.providerConfig,
			modelConfig: real.modelConfig,
			credential: real.credential,
		});
		let app: Awaited<ReturnType<typeof launchSubagentApp>> | undefined;
		let selectedAgents: AgentRecord[] = [];
		let correctionToken = "";
		let parentContinuedWhileChildRunning = false;
		let userCorrectionReachedSelectedChild = false;
		let finalResultReflectedCorrection = false;
		let modelCallsFromHistoryNavigation = 0;
		try {
			app = await launchSubagentApp(environment);
			const page = app.page;
			await upsertSubagentRole(page, REAL_ROLE);
			const parentId = await createSubagentSession(
				page,
				environment,
				mode as SubagentMode,
				`${mode} real subagent acceptance`,
			);
			const actualModel = await sessionModel(page, parentId);
			expect(actualModel).toMatchObject({ provider: real.providerId, modelId: real.modelId });

			const prompt = `${REAL_START}
You are the parent agent in a ${mode} subagent acceptance run. Work only inside ${environment.projectDir}.
Follow the role catalog in your system context and choose the narrowest fitting role for each child yourself. Create exactly two persistent children asynchronously, then continue useful independent work while they run; do not block immediately in wait_agents.
One child must be assigned the configured custom role "${REAL_ROLE.id}" because its purpose is the required read-only evidence audit. The other child should use whichever built-in role is narrowest for its assignment.
Child assignments:
1. Audit ${path.join(environment.projectDir, "README.md")}: report the alpha evidence marker, the corrected marker, and the sources you actually read.
2. Audit the same fixture independently for the beta evidence marker and report verification limits.
Each child must actually read the workspace before reporting. A trusted human may send a correction containing a token beginning REAL-CORRECTION- directly to a child; if that happens, the child must reconcile it and include the exact token in its final handoff. Treat that correction as higher priority than your original assignment.
When both children are complete, integrate their results and finish with exactly ${REAL_FINAL} followed by a short summary. Do not use web search, external networks, or modify user files.`;
			await sendParentPrompt(page, prompt);

			selectedAgents = await waitForAgents(
				page,
				parentId,
				(agents) => agents.length >= 2,
				300_000,
			);
			const directAgents = selectedAgents.filter((agent) => agent.parentSessionId === parentId);
			expect(directAgents.length, "the model must create at least two direct children").toBeGreaterThanOrEqual(2);
			expect(directAgents.every((agent) => agent.model?.provider === real.providerId)).toBe(true);
			expect(directAgents.every((agent) => agent.model?.modelId === real.modelId)).toBe(true);
			expect(
				directAgents.some((agent) => agent.agentType === REAL_ROLE.id),
				"the model must choose the custom release-auditor role for the read-only audit",
			).toBe(true);
			expect(
				directAgents.some((agent) => agent.agentType !== "default"),
				"the model must choose a narrower role than default when one fits",
			).toBe(true);

			const parentIndependent = await waitForModelRequest(
				proxy,
				(request) =>
					!request.isChild && request.spawnNames.includes("spawn_agent") && request.mailboxEvents.length === 0,
				300_000,
			);
			await waitForModelRequest(proxy, (request) => request.isChild, 180_000);
			const activeWhileParentWorks = await waitForAgents(
				page,
				parentId,
				(agents) => agents.some((agent) => agent.status === "running" || agent.status === "queued"),
				60_000,
			);
			parentContinuedWhileChildRunning = activeWhileParentWorks.some(
				(agent) => agent.status === "running" || agent.status === "queued",
			);
			expect(parentContinuedWhileChildRunning, "parent work must continue while a child is still active").toBe(true);

			const runningChild = await waitForAgents(
				page,
				parentId,
				(agents) =>
					agents.some((agent) => agent.parentSessionId === parentId && agent.status === "running"),
				180_000,
			).then((agents) =>
				agents.find((agent) => agent.parentSessionId === parentId && agent.status === "running"),
			);
			expect(runningChild, "a running child is required for the user correction").toBeTruthy();
			correctionToken = `REAL-CORRECTION-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
			const receipt = await sendSubagentCorrection(
				page,
				parentId,
				runningChild!.agentId,
				`${correctionToken}: use the corrected alpha evidence marker; this human correction takes precedence.`,
			);
			expect(receipt.delivery, "the user correction must steer the running child task").toBe("steer");
			expect(receipt.instructionRevision).toBeGreaterThanOrEqual(2);

			const mailboxRequest = await waitForModelRequest(
				proxy,
				(request) =>
					!request.isChild &&
					request.mailboxEvents.some(
						(event) => event.type === "intervention" && event.text?.includes(correctionToken),
					),
				300_000,
			);
			const mailboxEvent = mailboxRequest.mailboxEvents.find(
				(event) => event.type === "intervention" && event.text?.includes(correctionToken),
			);
			expect(mailboxEvent?.messageId).toBe(receipt.messageId);
			expect(mailboxEvent?.instructionRevision).toBe(receipt.instructionRevision);

			const correctionChildRequest = await waitForModelRequest(
				proxy,
				(request) =>
					request.isChild &&
					request.agentId === runningChild!.agentId &&
					request.userTexts.some((text) => text.includes(correctionToken)),
				180_000,
			);
			expect(correctionChildRequest.agentId).toBe(runningChild!.agentId);

			await expect
				.poll(
					async () => {
						const items = await readSubagentItems(page, parentId, runningChild!.agentId);
						return (
							items.find(
								(item) => item.role === "user" && itemText(item).includes(correctionToken),
							)?.instructionRevision ?? 0
						);
					},
					{ timeout: 60_000 },
				)
				.toBeGreaterThanOrEqual(receipt.instructionRevision);

			const targetItems = await readSubagentItems(page, parentId, runningChild!.agentId);
			const firstUserItem = targetItems.find((item) => item.role === "user");
			expect(firstUserItem?.origin).toMatchObject({ kind: "agent", sessionId: parentId });
			const correctionItem = targetItems.find(
				(item) => item.role === "user" && itemText(item).includes(correctionToken),
			);
			expect(correctionItem?.origin).toMatchObject({ kind: "user" });
			expect(correctionItem?.agentMessageId).toBe(receipt.messageId);
			userCorrectionReachedSelectedChild =
				correctionItem !== undefined &&
				(correctionItem.instructionRevision ?? 0) >= receipt.instructionRevision;
			expect(userCorrectionReachedSelectedChild).toBe(true);

			await waitForParentFinal(page, parentId, REAL_FINAL, 900_000);
			const finished = await waitForAgents(page, parentId, (agents) => agents.every(isTerminal), 120_000);
			expect(finished.every((agent) => agent.status === "done"), "both audits must finish successfully, including any same-child retries").toBe(true);
			const finishedTarget = finished.find((agent) => agent.agentId === runningChild!.agentId);
			const targetTask = finishedTarget?.tasks.find((task) => task.taskId === receipt.taskId);
			expect(targetTask?.consumedInstructionRevision).toBeGreaterThanOrEqual(receipt.instructionRevision);
			finalResultReflectedCorrection = [
				finishedTarget?.latestTask?.finalMessage,
				finishedTarget?.currentTask?.finalMessage,
			].some((message) => message?.includes(correctionToken));
			expect(finalResultReflectedCorrection, "the child final handoff must reflect the human correction").toBe(true);
			const targetAssistantItems = (await readSubagentItems(page, parentId, runningChild!.agentId)).filter(
				(item) => item.role === "assistant",
			);
			expect(itemText(targetAssistantItems.at(-1)!)).toContain(correctionToken);

			const parentStart = proxy.requests.find(
				(request) => !request.isChild && request.userTexts.some((text) => text.includes(REAL_START)),
			);
			expect(parentStart, "the parent model request was not captured").toBeTruthy();
			expect(parentStart?.system).toContain("<agent_coordination>");
			for (const role of ["default", "explorer", "worker", "reviewer", REAL_ROLE.id])
				expect(parentStart?.system).toContain(`${role}:`);
			for (const agent of directAgents) {
				const childRequest = proxy.requests.find(
					(request) => request.isChild && request.agentId === agent.agentId,
				);
				expect(childRequest, `missing child model request for ${agent.name}`).toBeTruthy();
				expect(childRequest?.system).toContain("<agent_contract>");
				expect(childRequest?.system).toContain(`"name":"${agent.agentType}"`);
				expect(agent.parentSessionId).toBe(parentId);
				expect(childRequest?.system).toContain(agent.agentId);
				expect(childRequest?.system).toContain(parentId);
				expect(childRequest?.system).toContain("<agent_type>");
				if (agent.agentType === REAL_ROLE.id) {
					expect(childRequest?.system).toContain("<agent_role_instructions>");
					expect(childRequest?.system).toContain(REAL_ROLE.systemPrompt);
				}
				expect(childRequest?.toolNames).toEqual(expect.arrayContaining([...(agent.tools ?? [])]));
				if (agent.writePolicy === "deny") expect(agent.tools).not.toContain("write");
				expect(childRequest?.userTexts.join("\n")).toMatch(/README\.md/u);
				expect(proxy.requests.filter((request) => request.isChild && request.agentId === agent.agentId)
					.some((request) => request.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("fixture-beta"))),
					`child ${agent.name} must actually read fixture evidence through a tool`).toBe(true);
			}
			const substantiveRequests = proxy.requests.filter(
				(request) =>
					request.isChild ||
					request.userTexts.some((text) => text.includes(REAL_START)) ||
					request.mailboxEvents.length > 0,
			);
			expect(substantiveRequests.length).toBeGreaterThan(0);
			for (const request of substantiveRequests) {
				expect(request.model).toBe(real.modelId);
				expect(JSON.stringify(request.messages), "real model must receive working packaged native tools").not.toContain("Incomplete Metis installation");
			}

			await page.waitForTimeout(2_000);
			const beforeColdRead = proxy.requests.length;
			await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
			await waitForServerReady(page);
			if (mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
			await expect(page.locator(`[data-active-session-id="${parentId}"]`)).toBeVisible();
			await openAgentConversation(page, runningChild!.name);
			await expect(page.locator(`[data-agent-id="${runningChild!.agentId}"]`)).toBeVisible();
			await readSubagentItems(page, parentId, runningChild!.agentId);
			await readSessionItems(page, parentId);
			await listSubagents(page, parentId);
			await page.waitForTimeout(2_000);
			modelCallsFromHistoryNavigation = proxy.requests.length - beforeColdRead;
			expect(modelCallsFromHistoryNavigation, "cold history navigation must not call the model").toBe(0);
			await expect(page.locator(`#agent-composer-${runningChild!.agentId}`), "cold reads and a late mode switch must preserve the selected child").toBeVisible();
			await page.screenshot({ path: testInfo.outputPath(`subagent-real-${mode}.png`) });

			await saveSubagentEvidence(testInfo, `subagent-real-${mode}-evidence.json`, {
				provider: real.providerId,
				modelId: real.modelId,
				api: real.provider.api ?? "openai-completions",
				requestCount: proxy.requests.length,
				parentContinuedWhileChildRunning,
				userCorrectionReachedSelectedChild,
				finalResultReflectedCorrection,
				modelCallsFromHistoryNavigation,
				roleCatalogRoles: ["default", "explorer", "worker", "reviewer", REAL_ROLE.id],
				agents: finished.map((agent) => ({
					agentId: agent.agentId,
					name: agent.name,
					agentType: agent.agentType,
					depth: agent.depth,
					tools: agent.tools,
					writePolicy: agent.writePolicy,
					mayDelegate: agent.mayDelegate,
					model: agent.model,
					tasks: agent.tasks.map((task) => ({
						taskId: task.taskId,
						status: task.status,
						instructionRevision: task.instructionRevision,
						consumedInstructionRevision: task.consumedInstructionRevision,
					})),
				})),
			});
		} finally {
			await saveSubagentEvidence(testInfo, "subagent-real-requests.json", modelRequestSummary(proxy));
			if (app) {
				await app.page.screenshot({ path: testInfo.outputPath("subagent-real-last.png") }).catch(() => undefined);
				await closeSubagentApp(app).catch(() => undefined);
			}
			await proxy.close();
			await removeSubagentEnvironment(environment);
		}
	});
}
