import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DomainEvent, ItemView } from "@metis/app-protocol";
import { expect, type TestInfo } from "@playwright/test";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeBrowserAgentApp,
	createBrowserAgentEnvironment,
	launchBrowserAgentApp,
	type RunningBrowserAgentApp,
	removeBrowserAgentEnvironment,
	sendFixturePrompt,
} from "./browser-agent-fixture.ts";

export interface RecordedModelMessage {
	role: string;
	model?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	content: Array<{
		type: string;
		text?: string;
		id?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>;
}

export interface BrowserModelSession {
	app: RunningBrowserAgentApp;
	items: Map<string, ItemView>;
	run(prompt: string): Promise<void>;
	messages(): Promise<RecordedModelMessage[]>;
	save(name: string, value: unknown): Promise<void>;
}

export async function withBrowserModel(
	testInfo: TestInfo,
	accept: (session: BrowserModelSession) => Promise<void>,
): Promise<void> {
	const configDir = process.env.METIS_BROWSER_MODEL_CONFIG_DIR;
	if (!configDir || !path.isAbsolute(configDir)) throw new Error("METIS_BROWSER_MODEL_CONFIG_DIR must be absolute");
	const [models, settings, auth] = await Promise.all(
		["models.json", "settings.json", "auth.json"].map(async (name) =>
			JSON.parse(await readFile(path.join(configDir, name), "utf8")),
		),
	);
	const providerId: string = settings.defaultProvider;
	const modelId: string = settings.defaultModel;
	const provider = models.providers[providerId];
	const model = provider?.models?.find((candidate: { id: string }) => candidate.id === modelId);
	const credential = auth[providerId];
	if (!provider || !model || credential?.type !== "api_key" || !credential.key)
		throw new Error("Configured provider/model and API-key credential are required");
	const redact = (value: string) => value.replaceAll(credential.key, "[redacted]");
	const environment = await createBrowserAgentEnvironment(0);
	let app: RunningBrowserAgentApp | undefined;
	const events: DomainEvent[] = [];
	const items = new Map<string, ItemView>();
	const prompts: string[] = [];
	let terminal: Extract<DomainEvent, { type: "turn/completed" | "turn/interrupted" }> | undefined;
	let interaction = false;
	let startedAt = 0;
	const save = async (name: string, value: unknown) =>
		writeFile(testInfo.outputPath(name), redact(JSON.stringify(value, null, 2)));
	const sessionFiles = async () =>
		(await readdir(environment.agentDir, { recursive: true })).filter(
			(file) => file.startsWith(`sessions${path.sep}`) && file.endsWith(".jsonl"),
		);
	const messages = async (): Promise<RecordedModelMessage[]> => {
		const result: RecordedModelMessage[] = [];
		for (const file of await sessionFiles()) {
			const source = await readFile(path.join(environment.agentDir, file), "utf8");
			for (const line of source.trim().split("\n")) {
				const message = JSON.parse(line).message;
				if (message) result.push(message);
			}
		}
		return result;
	};
	try {
		await Promise.all([
			writeFile(
				path.join(environment.agentDir, "models.json"),
				JSON.stringify({
					providers: { [providerId]: { ...provider, models: [model] } },
				}),
				{ mode: 0o600 },
			),
			writeFile(path.join(environment.agentDir, "auth.json"), JSON.stringify({ [providerId]: credential }), {
				mode: 0o600,
			}),
			writeFile(
				path.join(environment.agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: providerId,
					defaultModel: modelId,
					retry: { enabled: false },
				}),
			),
		]);
		app = await launchBrowserAgentApp(environment);
		const running = app;
		await running.page.exposeFunction("recordModelAcceptance", (event: DesktopApiEvent) => {
			if (event.type !== "app-server") return;
			if (event.envelope.method === "interaction/request") {
				interaction = true;
				return;
			}
			for (const entry of event.envelope.params.events) {
				if (entry.type === "item/delta") continue;
				events.push(entry);
				if (entry.type === "item/started" || entry.type === "item/completed") {
					if (entry.item.sessionId !== running.sessionId) continue;
					items.set(entry.item.itemId, entry.item);
					if (entry.type === "item/completed")
						for (const block of entry.item.content) {
							if (block.type === "tool_result")
								console.log(
									JSON.stringify({ tool: block.name, error: block.isError, elapsed: Date.now() - startedAt }),
								);
						}
				}
				if (
					(entry.type === "turn/completed" || entry.type === "turn/interrupted") &&
					entry.turn.sessionId === running.sessionId
				)
					terminal = entry;
			}
		});
		const initial = await running.page.evaluate(async (sessionId) => {
			const globals = globalThis as unknown as {
				metis: MetisDesktopApi;
				recordModelAcceptance(event: DesktopApiEvent): Promise<void>;
			};
			globals.metis.subscribe((event) => {
				void globals.recordModelAcceptance(event);
			});
			return globals.metis.subscribeSession({ sessionId });
		}, running.sessionId);
		expect(initial.model).toMatchObject({ provider: providerId, modelId });
		await save("model.json", { provider: providerId, modelId, api: provider.api, model: initial.model });
		const run = async (prompt: string) => {
			prompts.push(prompt);
			await save("prompts.json", prompts);
			terminal = undefined;
			interaction = false;
			startedAt = Date.now();
			await sendFixturePrompt(running.page, prompt);
			while (!terminal) {
				if (interaction) throw new Error("Model requested an interaction; inspect evidence before approving");
				const calls = [...items.values()]
					.flatMap((item) => item.content)
					.filter((block) => block.type === "tool_call");
				if (calls.length > 80) throw new Error("Model exceeded the 80-call acceptance budget");
				if (Date.now() - startedAt > 600_000) throw new Error("Model exceeded the ten-minute acceptance budget");
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			const completed = terminal as Extract<DomainEvent, { type: "turn/completed" | "turn/interrupted" }>;
			expect(completed.type).toBe("turn/completed");
			expect(completed.turn.error).toBeUndefined();
			const calls = [...items.values()]
				.flatMap((item) => item.content)
				.filter((block) => block.type === "tool_call");
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.every((call) => call.name.startsWith("browser_"))).toBe(true);
			expect([
				...new Set(
					(await messages()).filter((message) => message.role === "assistant").map((message) => message.model),
				),
			]).toEqual([modelId]);
		};
		await accept({ app: running, items, run, messages, save });
	} finally {
		try {
			await save("events.json", events);
			await save("items.json", [...items.values()]);
			for (const file of await sessionFiles())
				await writeFile(
					testInfo.outputPath(path.basename(file)),
					redact(await readFile(path.join(environment.agentDir, file), "utf8")),
				);
			if (app) {
				await app.page.screenshot({ path: testInfo.outputPath("metis-last.png") }).catch(() => undefined);
				let index = 0;
				for (const page of app.browser.contexts().flatMap((context) => context.pages())) {
					if (page !== app.page && /^https?:/u.test(page.url()))
						await page
							.screenshot({ path: testInfo.outputPath(`website-last-${index++}.png`) })
							.catch(() => undefined);
				}
			}
		} finally {
			try {
				if (app) await closeBrowserAgentApp(app);
			} finally {
				await removeBrowserAgentEnvironment(environment);
			}
		}
	}
}
