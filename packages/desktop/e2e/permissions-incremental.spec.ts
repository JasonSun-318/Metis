import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { closeServer, listen } from "./packaged-app-harness.ts";
import { launchPermissionApp, type LaunchPermissionAppOptions, type PermissionAppDirs } from "./fixtures/permission-app.ts";
import type { PermissionToolCall } from "./fixtures/permission-provider.ts";

test.describe.configure({ timeout: 240_000 });

/**
 * Behavior matrix for the incremental permission work. Every row records the
 * decision, reviewer calls, and executions. The fake provider proves the
 * protocol and UI contract only; real-model qualification is recorded
 * separately and never claimed here.
 */

const SECRET_VALUE = "fixture-secret-9d81c";

function bash(command: string): PermissionToolCall {
	return { name: "bash", arguments: { command } };
}

/** Exact source-byte boundaries with stdout only, within the first safe semantic subset. */
function paddedCommand(targetBytes: number): string {
	const head = "printf '%s' '";
	const tail = "'";
	return `${head}${"a".repeat(targetBytes - Buffer.byteLength(head + tail))}${tail}`;
}

function toolFor(marker: string, dirs: PermissionAppDirs): PermissionToolCall | undefined {
	const generatedDir = path.join(dirs.projectDir, "generated");
	const longCommand = (bytes: number) => bash(paddedCommand(bytes));
	const cases: Array<readonly [string, PermissionToolCall]> = [
		["case-safe-read", { name: "read", arguments: { path: path.join(dirs.projectDir, "README.md") } }],
		[
			"case-workspace-write",
			{ name: "write", arguments: { path: path.join(dirs.projectDir, "target.txt"), content: `content:${marker}` } },
		],
		["case-long-257", longCommand(257)],
		["case-long-8k", longCommand(8_192)],
		["case-long-32k", longCommand(32_768)],
		["case-long-oversize", longCommand(32_769)],
		["case-outside-read", bash(`cat ${JSON.stringify(path.join(dirs.outsideDir, "outside.txt"))}`)],
		["case-dedicated-review-read", bash(`cat ${JSON.stringify(path.join(dirs.outsideDir, "outside.txt"))}`)],
		["case-incomplete-var", bash("touch $OUTPUT")],
		["case-tail-danger", bash(`printf 'safe prefix' > ${JSON.stringify(path.join(dirs.projectDir, "prefix.txt"))} && rm -rf ${JSON.stringify(generatedDir)}`)],
		["case-pipeline-danger", bash(`printf ok | (rm -rf ${JSON.stringify(generatedDir)})`)],
		["case-substitution-danger", bash(`printf '%s' "$(rm -rf ${JSON.stringify(generatedDir)})"`)],
		["case-loop-danger", bash(`for item in a; do rm -rf ${JSON.stringify(generatedDir)}; done`)],
		["case-secret-multiline", bash(`API_TOKEN=${SECRET_VALUE} printf '%s\\n' 'safe output' > ${JSON.stringify(path.join(dirs.projectDir, "secret-output.txt"))}\nprintf 'tail-visible'`)],
		["case-ask-append", bash(`printf x >> ${JSON.stringify(path.join(dirs.projectDir, "once.txt").replace(/^\/private\/var\//u, "/var/"))}`)],
		["case-curl-authorized", bash("curl -q --silent --show-error --fail http://127.0.0.1:${METIS_TEST_PORT}/data")],
		["case-curl-denied", bash("curl -q --silent --show-error --fail http://127.0.0.1:${METIS_TEST_DENIED_PORT}/denied")],
		["case-curl-redirect", bash("curl -q --silent --show-error --location --fail http://127.0.0.1:${METIS_TEST_REDIRECT_PORT}/redirect")],
	];
	return cases.find(([token]) => marker.includes(token))?.[1];
}

const tools: LaunchPermissionAppOptions["tools"] = (marker, dirs) => toolFor(marker, dirs);

const reviewerSeed = (enabled: boolean, timeoutMs = 8_000) =>
	({
		provider: "permission-reviewer",
		modelId: "reviewer-model",
		thinkingLevel: "off",
		timeoutMs,
		maxOutputTokens: 512,
		enabled,
	}) as const;

const withGeneratedDir = async (dirs: PermissionAppDirs): Promise<void> => {
	await mkdir(path.join(dirs.projectDir, "generated"), { recursive: true });
	await writeFile(path.join(dirs.projectDir, "generated", "marker.txt"), "keep");
};

const withOutsideSeedFile = async (dirs: PermissionAppDirs): Promise<void> => {
	await writeFile(path.join(dirs.outsideDir, "outside.txt"), "outside");
};

async function pressEnter(page: Page): Promise<void> {
	await page.keyboard.press("Enter");
}

test.describe("Auto command rules and long commands", () => {
	test("rule-allowed complete long commands execute with zero model calls", async () => {
		const app = await launchPermissionApp({ preset: "auto", tools, seed: withOutsideSeedFile });
		try {
			// One short rule prefix; the executed source uses the independent
			// long-command budget instead of the 256-byte rule edit limit.
			await app.page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					updatePermissionAutoSettings(input: Record<string, unknown>): Promise<unknown>;
				} }).metis;
				await api.updatePermissionAutoSettings({
					requestId: crypto.randomUUID(),
					rules: [{ command: "printf", allowNetwork: false }],
				});
			});

			for (const [marker, bytes, file] of [["case-long-257", 257, "long-257.txt"], ["case-long-8k", 8192, "long-8k.txt"], ["case-long-32k", 32768, "long-32k.txt"]] as const) {
				await app.submit(marker);
				await app.waitDone(marker);
				const payload = JSON.parse(app.provider.calls.filter((call) => call.kind === "primary").at(-1)!.payload) as { messages: Array<{ role: string; content: unknown }> };
				const result = payload.messages.filter((message) => message.role === "tool").at(-1);
				expect(JSON.stringify(result?.content)).toContain("a".repeat(bytes - Buffer.byteLength("printf '%s' ''")));
				expect(existsSync(path.join(app.projectDir, file))).toBe(false);
			}
			await expect(app.approval).toHaveCount(0);
			expect(app.provider.reviewCount).toBe(0);
		} finally {
			await app.close();
		}
	});

	test("a command past 32 KiB asks to split, never enters the panel, and has no side effect", async () => {
		const app = await launchPermissionApp({ preset: "auto", tools });
		try {
			await app.submit("case-long-oversize");
			await app.waitDone("case-long-oversize");
			await expect(app.approval).toHaveCount(0);
			expect(app.provider.reviewCount).toBe(0);
			// The oversized source surfaces the split-and-retry requirement instead of
			// a truncated approval.
			await expect(app.page.getByText(/32|split|拆分|exceed/iu).first()).toBeVisible();
			expect(existsSync(path.join(app.projectDir, "long-oversize.txt"))).toBe(false);
		} finally {
			await app.close();
		}
	});
});

test.describe("manual boundaries stay unrememberable", () => {
	test("incomplete actions ask without persistent options and dangerous tails are blocked", async () => {
		const app = await launchPermissionApp({ preset: "auto", tools, seed: withGeneratedDir });
		try {
			// Dynamic/incomplete target: no reusable scope, no remember entries.
			await app.submit("case-incomplete-var");
			let panel = app.approval;
			await expect(panel).toBeVisible();
			await expect(app.page.getByRole("button", { name: "More approval options", exact: true })).toHaveCount(0);
			await app.reject();
			await app.waitDone("case-incomplete-var");

			// A safe prefix must not cover the dangerous tail.
			await app.submit("case-tail-danger");
			await app.waitDone("case-tail-danger");
			await expect(app.approval).toHaveCount(0);
			expect(existsSync(path.join(app.projectDir, "prefix.txt"))).toBe(false);
			for (const marker of ["case-pipeline-danger", "case-substitution-danger", "case-loop-danger"]) {
				await app.submit(marker);
				await expect.poll(async () =>
					(await app.approval.count()) > 0 || (await app.page.getByText(`done:${marker}`, { exact: true }).count()) > 0,
				).toBe(true);
				if (await app.approval.isVisible()) await app.reject();
				await app.waitDone(marker);
			}
			expect(await readFile(path.join(app.projectDir, "generated", "marker.txt"), "utf8")).toBe("keep");
			expect(app.provider.reviewCount).toBe(0);
		} finally {
			await app.close();
		}
	});
});

test.describe("reviewer lifecycle", () => {
	test("cancelling the turn during a model review leaves nothing executed", async () => {
		const app = await launchPermissionApp({
			preset: "auto",
			tools,
			decide: () => ({ decision: "allow" }),
			reviewDelayMs: 8_000,
			reviewer: reviewerSeed(true),
			seed: withOutsideSeedFile,
		});
		try {
			await app.submit("case-outside-read");
			await expect(app.page.getByText("Checking security…")).toBeVisible();
			await app.interrupt();
			await expect(app.page.getByText("Checking security…")).toHaveCount(0, { timeout: 15_000 });
			await expect(app.approval).toHaveCount(0);
			// The stale verdict must not run the command after cancellation.
			expect(app.provider.reviewCount).toBeLessThanOrEqual(1);
		} finally {
			await app.close();
		}
	});
});

test.describe("exact session and project rules", () => {
	test("session allow hits only its session; project deny wins; revoke restores the prompt", async () => {
		const app = await launchPermissionApp({ preset: "ask", tools });
		try {
			const clearRules = (scope: "project" | "session") =>
				app.page.evaluate(
					async ({ session, ruleScope }) => {
						const api = (globalThis as unknown as { metis: {
							clearPermissionRules(input: Record<string, unknown>): Promise<unknown>;
						} }).metis;
						await api.clearPermissionRules({
							requestId: crypto.randomUUID(),
							scope: ruleScope,
							sessionId: session,
						});
					},
					{ session: app.sessionId, ruleScope: scope },
				);

			// 1. Session A allows the exact write for this session.
			await app.submit("case-workspace-write exact");
			let panel = app.approval;
			await expect(panel).toBeVisible();
			await app.chooseApprovalOption("Allow for this session");
			await app.waitDone("case-workspace-write exact");
			expect(await readFile(path.join(app.projectDir, "target.txt"), "utf8")).toContain("exact");

			// 2. The same exact action auto-executes in session A without a panel.
			await app.submit("case-workspace-write exact");
			await app.waitDone("case-workspace-write exact");
			await expect(app.approval).toHaveCount(0);

			// 3. A second session does not inherit the session rule.
			const sessionB = await app.createSession("ask");
			await app.submit("case-workspace-write exact");
			panel = app.approval;
			await expect(panel).toBeVisible();
			await app.reject(); // deny once in B; no rule is created yet
			await app.waitDone("case-workspace-write exact");

			// 4. A remembered project deny from session B wins over session A's allow.
			await app.submit("case-workspace-write exact");
			await expect(app.approval).toBeVisible();
			await app.chooseApprovalOption("Deny for this project");
			await app.waitDone("case-workspace-write exact");
			void sessionB;
			await app.openSession(app.sessionId);
			await app.submit("case-workspace-write exact");
			await app.waitDone("case-workspace-write exact");
			await expect(app.approval).toHaveCount(0);
			expect(await readFile(path.join(app.projectDir, "target.txt"), "utf8")).toContain("exact");

			// 5. Removing the project deny revives the session allow.
			await clearRules("project");
			await app.submit("case-workspace-write exact");
			await app.waitDone("case-workspace-write exact");
			await expect(app.approval).toHaveCount(0);

			// 6. Revoking session rules restores the manual prompt.
			await clearRules("session");
			await app.submit("case-workspace-write exact");
			await expect(app.approval).toBeVisible();
			await app.reject();
			await app.waitDone("case-workspace-write exact");
		} finally {
			await app.close();
		}
	});

	test("the permission settings page lists and revokes remembered session rules", async () => {
		const app = await launchPermissionApp({ preset: "ask", tools });
		try {
			await app.submit("case-workspace-write remember");
			await expect(app.approval).toBeVisible();
			await app.chooseApprovalOption("Allow for this session");
			await app.waitDone("case-workspace-write remember");

			await app.openSettings("Permissions");
			const page = app.page;
			for (const heading of [
				"Auto model approvals",
				"Allowed commands",
				"Remembered permissions",
				"Sandbox environment",
			]) {
				await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
			}
			await page.getByRole("button", { name: "Manage remembered permissions" }).click();
			const sessionGroup = page.getByRole("dialog", { name: "Remembered permissions", exact: true });
			await expect(sessionGroup).toContainText("target.txt");
			await sessionGroup.getByRole("button", { name: /Revoke/u }).first().click();
			await expect(sessionGroup.getByRole("button", { name: /Revoke/u })).toHaveCount(0);
			await page.keyboard.press("Escape");
			await app.closeSettings();

			await app.submit("case-workspace-write remember");
			await expect(app.approval).toBeVisible();
			await app.reject();
			await app.waitDone("case-workspace-write remember");
		} finally {
			await app.close();
		}
	});
});

test.describe("approval card ergonomics", () => {
	test("inline approval preserves focus, Enter allows once, and Escape dismisses only the focused surface", async () => {
		const app = await launchPermissionApp({ preset: "ask", tools });
		try {
			// Inline cards preserve composer focus; their shortcuts require focus in the card.
			await app.submit("case-ask-append enter");
			const panel = app.approval;
			await expect(panel).toBeVisible();
			await expect(panel).not.toBeFocused();
			await pressEnter(app.page);
			await expect(panel).toBeVisible();
			expect(existsSync(path.join(app.projectDir, "once.txt"))).toBe(false);
			await panel.focus();
			await expect(panel).toBeFocused();
			await pressEnter(app.page);
			await app.waitDone("case-ask-append enter");
			const toolResult = JSON.parse(app.provider.calls.filter((call) => call.kind === "primary").at(-1)?.payload ?? "{}").messages?.findLast(
				(message: { role: string }) => message.role === "tool",
			);
			expect(existsSync(path.join(app.projectDir, "once.txt")), JSON.stringify(toolResult)).toBe(true);
			expect(await readFile(path.join(app.projectDir, "once.txt"), "utf8")).toBe("x");

			// A double click on Allow once must not submit two decisions.
			await app.submit("case-ask-append double");
			await expect(panel).toBeVisible();
			await app.page.getByRole("button", { name: "Allow once", exact: true }).dblclick();
			await app.waitDone("case-ask-append double");
			expect(await readFile(path.join(app.projectDir, "once.txt"), "utf8")).toBe("xx");
			await expect(app.page.getByText("This approval is no longer available.")).toHaveCount(0);

			// Escape inside the dropdown closes only the menu; the panel stays.
			await app.submit("case-ask-append menu");
			await expect(panel).toBeVisible();
			await app.page.getByRole("button", { name: "More approval options", exact: true }).click();
			await expect(app.page.getByRole("listbox", { name: "More approval options", exact: true })).toBeVisible();
			await app.page.keyboard.press("Escape");
			await expect(app.page.getByRole("listbox", { name: "More approval options", exact: true })).toHaveCount(0);
			await expect(panel).toBeVisible();
			await app.page.keyboard.press("Escape");
			await app.waitDone("case-ask-append menu");
			// The menu escape neither approved nor denied early.
			expect(await readFile(path.join(app.projectDir, "once.txt"), "utf8")).toBe("xx");
		} finally {
			await app.close();
		}
	});

	test("the Chinese approval card shows the complete redacted command with its tail", async () => {
		const app = await launchPermissionApp({ preset: "ask", tools, locale: "zh-CN" });
		try {
			await app.submit("case-secret-multiline");
			const panel = app.approval;
			await expect(panel).toBeVisible();
			await expect(panel.getByRole("heading", { name: "允许 Metis 执行以下命令吗？", exact: true })).toBeVisible();
			const headingBox = await panel.getByRole("heading").boundingBox();
			const panelBox = await panel.boundingBox();
			expect(headingBox!.width).toBeGreaterThan(panelBox!.width * 0.7);
			const text = (await panel.locator(".permission-approval-command").textContent()) ?? "";
			expect(text).toContain("API_TOKEN=<redacted>");
			expect(text).toContain("tail-visible");
			expect(text).toContain("\n");
			expect(text).not.toContain(SECRET_VALUE);
			await panel.screenshot({ path: test.info().outputPath("approval.zh-CN.png") });
			await panel.focus();
			await pressEnter(app.page);
			await app.waitDone("case-secret-multiline");
			await expect(panel).toHaveCount(0);
			// The approval surface was verified before execution; transcript rendering has its own existing contract.
		} finally {
			await app.close();
		}
	});
});

test.describe("tool decision labels", () => {
	test("rule and model actions stay free of diagnostic labels after reconnect", async () => {
		const app = await launchPermissionApp({
			preset: "auto",
			tools,
			decide: () => ({ decision: "allow" }),
			reviewer: reviewerSeed(true),
			seed: withOutsideSeedFile,
		});
		try {
			await app.submit("case-safe-read");
			await app.waitDone("case-safe-read");
			await app.submit("case-outside-read");
			await app.waitDone("case-outside-read");
			await expect(app.page.getByText("Allowed by rule")).toHaveCount(0);
			await expect(app.page.getByText("Approved by model")).toHaveCount(0);

			await app.relaunch();
			await expect(app.page.getByText("Allowed by rule")).toHaveCount(0);
			await expect(app.page.getByText("Approved by model")).toHaveCount(0);
		} finally {
			await app.close();
		}
	});

	test("user-approved Ask actions and Full host runs carry no automatic badge", async () => {
		const app = await launchPermissionApp({ preset: "ask", tools });
		try {
			await app.submit("case-workspace-write user");
			await expect(app.approval).toBeVisible();
			await app.allowOnce();
			await app.waitDone("case-workspace-write user");
			await expect(app.page.getByText("Allowed by rule")).toHaveCount(0);
			await expect(app.page.getByText("Approved by model")).toHaveCount(0);
		} finally {
			await app.close();
		}

		const full = await launchPermissionApp({ preset: "full", tools });
		try {
			await full.submit("case-safe-read");
			await full.waitDone("case-safe-read");
			await expect(full.page.getByText("Allowed by rule")).toHaveCount(0);
			await expect(full.page.getByText("Approved by model")).toHaveCount(0);
		} finally {
			await full.close();
		}
	});
});

test.describe("network scope", () => {
	test("curl executes only the approved endpoint; other endpoints and redirects stay blocked", async () => {
		const hits = { authorized: 0, denied: 0, redirect: 0 };
		const authorized = createServer((_request, response) => {
			hits.authorized += 1;
			response.writeHead(200, { "content-type": "text/plain" }).end("authorized-body");
		});
		const denied = createServer((_request, response) => {
			hits.denied += 1;
			response.writeHead(200).end("denied-body");
		});
		const redirectPortHolder = { port: 0 };
		const deniedPortHolder = { port: 0 };
		const redirect = createServer((_request, response) => {
			hits.redirect += 1;
			response.writeHead(302, { location: `http://127.0.0.1:${deniedPortHolder.port}/denied` }).end();
		});
		const authorizedPort = await listen(authorized);
		const deniedPort = await listen(denied);
		deniedPortHolder.port = deniedPort;
		redirectPortHolder.port = await listen(redirect);

		const app = await launchPermissionApp({
			preset: "auto",
			tools: (marker, dirs) => {
				const base = toolFor(marker, dirs);
				if (!base) return undefined;
				const command = String((base.arguments as { command?: string }).command ?? "")
					.replaceAll("${METIS_TEST_PORT}", String(authorizedPort))
					.replaceAll("${METIS_TEST_DENIED_PORT}", String(deniedPort))
					.replaceAll("${METIS_TEST_REDIRECT_PORT}", String(redirectPortHolder.port));
				return { name: "bash", arguments: { command } };
			},
		});
		try {
			// Approved endpoint: manual approval first, then a successful sandboxed run.
			await app.submit("case-curl-authorized");
			const panel = app.approval;
			await expect(panel).toBeVisible();
			await expect(panel).toContainText("curl");
			await app.allowOnce();
			await app.waitDone("case-curl-authorized");
			expect(hits.authorized).toBe(1);
			expect(hits.denied).toBe(0);

			// A distinct endpoint needs its own approval; rejection creates no request.
			await app.submit("case-curl-denied");
			const deniedPanel = app.approval;
			await expect(deniedPanel).toBeVisible();
			await app.reject();
			await app.waitDone("case-curl-denied");
			expect(hits.denied).toBe(0);

			// Following a redirect must not widen the grant to the second endpoint.
			await app.submit("case-curl-redirect");
			const redirectPanel = app.approval;
			await expect(redirectPanel).toBeVisible();
			await redirectPanel.getByRole("button", { name: "Allow once", exact: true }).click();
			await app.waitDone("case-curl-redirect");
			expect(hits.redirect).toBe(1);
			expect(hits.denied).toBe(0);
			expect(hits.authorized).toBe(1);
		} finally {
			await app.close();
			await closeServer(authorized);
			await closeServer(denied);
			await closeServer(redirect);
		}
	});
});

test.describe("settings and model surfaces", () => {
	test("the model page tests the saved reviewer profile with the real contract samples", async () => {
		const app = await launchPermissionApp({
			preset: "auto", tools, reviewer: reviewerSeed(false),
			decide: (payload) => ({ decision: JSON.parse(payload).action.command === "pwd" ? "allow" : "deny" }),
		});
		try {
			await app.openSettings("Model");
			const page = app.page;
			await expect(page.getByRole("heading", { name: "Approval model", exact: true })).toBeVisible();
			await expect(page.getByText(/Approval model configured/u)).toBeVisible();
			const reviewerSection = page.locator(".reviewer-model-section");
			await reviewerSection.scrollIntoViewIfNeeded();
			await reviewerSection.screenshot({ path: test.info().outputPath("reviewer-model-settings.png") });

			// The compact card keeps the form in a native dialog.
			await reviewerSection.getByRole("button", { name: "Edit", exact: true }).click();
			const reviewerDialog = page.getByRole("dialog", { name: "Approval model", exact: true });
			await expect(reviewerDialog).toBeVisible();
			await expect(reviewerDialog.getByRole("button", { name: "Connection type", exact: true })).toBeVisible();
			await reviewerDialog.screenshot({ path: test.info().outputPath("reviewer-model-dialog.png") });

			// The saved profile is exactly the five strict fields; the chat model is untouched.
			const settings = await page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					getModelSettings(): Promise<{
						defaultModel: { provider: string; modelId: string } | null;
						permissionReviewer: { config: Record<string, unknown> | null; status: string };
					}>;
				} }).metis;
				return api.getModelSettings();
			});
			expect(settings.permissionReviewer.status).toBe("configured");
			expect(settings.permissionReviewer.config).toMatchObject({
				provider: "permission-reviewer",
				modelId: "reviewer-model",
				thinkingLevel: "off",
				timeoutMs: 8_000,
				maxOutputTokens: 512,
			});
			expect(settings.defaultModel).toEqual({ provider: "permission", modelId: "permission-model" });

			// "Test approval model" runs the real review protocol for two fixed
			// samples (read allow, destructive deny) and never executes either.
			const projectBefore = await readdir(app.projectDir);
			await reviewerDialog.getByRole("button", { name: "Test approval model", exact: true }).click();
			await expect(page.getByText(/Approval model test succeeded/u)).toBeVisible({ timeout: 30_000 });
			expect(app.provider.reviewCalls.length).toBe(2);
			const [readSample, denySample] = app.provider.reviewCalls;
			const reviewedCommand = (payload: string | undefined) => {
				const messages = JSON.parse(payload ?? "{}").messages as Array<{ role: string; content: string | Array<{ text: string }> }>;
				const user = [...messages].reverse().find((message) => message.role === "user")!;
				return JSON.parse(typeof user.content === "string" ? user.content : user.content.map((part) => part.text).join("\n")).action.command;
			};
			expect(reviewedCommand(readSample?.payload)).toBe("pwd");
			expect(reviewedCommand(denySample?.payload)).toBe("rm -rf /");
			for (const call of app.provider.reviewCalls) {
				expect(call.model).toBe("reviewer-model");
				expect(call.maxTokens).toBe(512);
				expect(call.toolChoice).toBe("required"); // thinking off forces the verdict tool
				const toolsList = call.tools as readonly { function?: { name?: string } }[];
				expect(toolsList).toHaveLength(1);
				expect(toolsList[0]?.function?.name).toBe("submit_permission_review");
			}
			expect(await readdir(app.projectDir)).toEqual(projectBefore);

			// Cancel without edits closes the dialog without writing anything.
			await reviewerDialog.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(reviewerDialog).toHaveCount(0);

			// Testing is user-initiated and must not flip the Auto switch.
			const auto = await page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					getPermissionAutoSettings(): Promise<{ reviewerEnabled: boolean }>;
				} }).metis;
				return api.getPermissionAutoSettings();
			});
			expect(auto.reviewerEnabled).toBe(false);
			await app.closeSettings();
		} finally {
			await app.close();
		}
	});

	test("a dedicated reviewer connection configured through the UI reviews a real read-only action", async () => {
		const app = await launchPermissionApp({
			preset: "auto",
			tools,
			// The contract samples need pwd=allow and rm -rf /=deny; the real read is allowed.
			decide: (payload) => ({
				decision: JSON.parse(payload).action.command === "rm -rf /" ? "deny" : "allow",
			}),
		});
		try {
			await app.openSettings("Model");
			const page = app.page;
			const providersBefore = await page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					getModelSettings(): Promise<{ providers: readonly { provider: string }[] }>;
				} }).metis;
				return (await api.getModelSettings()).providers.map((provider) => provider.provider);
			});
			const reviewerSection = page.locator(".reviewer-model-section");
			await reviewerSection.scrollIntoViewIfNeeded();
			await reviewerSection.getByRole("button", { name: "Configure", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Approval model", exact: true });
			await expect(dialog).toBeVisible();

			await dialog.getByRole("button", { name: "Connection type", exact: true }).click();
			await page.getByRole("option", { name: "Dedicated connection", exact: true }).click();
			await dialog.getByLabel("Name", { exact: true }).fill("Independent reviewer");
			await dialog.getByLabel("Base URL", { exact: true }).fill(app.providerBaseUrl);
			await dialog.getByLabel("Model ID", { exact: true }).fill("reviewer-model");
			await dialog.getByLabel("API key", { exact: true }).fill("dedicated-review-key");
			await expect(dialog.getByRole("button", { name: "API format", exact: true })).toContainText(
				"OpenAI Completions",
			);
			await dialog.screenshot({ path: test.info().outputPath("reviewer-model-dialog-dedicated.png") });
			await dialog.getByRole("button", { name: "Save approval model", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(reviewerSection.getByText("Independent reviewer", { exact: true })).toBeVisible();
			await reviewerSection.screenshot({
				path: test.info().outputPath("reviewer-model-card-dedicated.png"),
			});

			const settings = await page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					getModelSettings(): Promise<{
						defaultModel: { provider: string; modelId: string } | null;
						providers: readonly { provider: string }[];
						permissionReviewer: {
							config: Record<string, unknown> | null;
							status: string;
							authConfigured?: boolean;
						};
					}>;
				} }).metis;
				return api.getModelSettings();
			});
			expect(settings.permissionReviewer.status).toBe("configured");
			expect(settings.permissionReviewer.authConfigured).toBe(true);
			expect(settings.permissionReviewer.config).toMatchObject({
				source: "dedicated",
				name: "Independent reviewer",
				api: "openai-completions",
				baseUrl: app.providerBaseUrl,
				modelId: "reviewer-model",
				thinkingLevel: "off",
				timeoutMs: 8_000,
				maxOutputTokens: 512,
				reasoningMode: "off",
			});
			expect(settings.permissionReviewer.config).not.toHaveProperty("provider");
			expect(settings.permissionReviewer.config).not.toHaveProperty("apiKey");
			expect(JSON.stringify(settings.permissionReviewer)).not.toContain("dedicated-review-key");
			// A dedicated connection never enters the chat catalog or changes chat defaults.
			expect(settings.defaultModel).toEqual({ provider: "permission", modelId: "permission-model" });
			expect(settings.providers.map((provider) => provider.provider)).toEqual(providersBefore);

			// Testing is limited to the saved connection and the fixed samples.
			await reviewerSection.getByRole("button", { name: "Edit", exact: true }).click();
			await expect(dialog).toBeVisible();
			await dialog.getByRole("button", { name: "Test approval model", exact: true }).click();
			await expect(page.getByText(/Approval model test succeeded/u)).toBeVisible({ timeout: 30_000 });
			expect(app.provider.reviewCalls).toHaveLength(2);
			for (const call of app.provider.reviewCalls) {
				expect(call.model).toBe("reviewer-model");
				expect(call.payload).not.toContain("dedicated-review-key");
			}
			const autoAfterTest = await page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					getPermissionAutoSettings(): Promise<{ reviewerEnabled: boolean }>;
				} }).metis;
				return api.getPermissionAutoSettings();
			});
			expect(autoAfterTest.reviewerEnabled).toBe(false);
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(dialog).toHaveCount(0);

			// The permission page mirrors the dedicated summary and owns the Auto switch.
			await page
				.getByRole("navigation", { name: "Settings pages" })
				.getByRole("button", { name: "Permissions", exact: true })
				.click();
			await expect(page.getByText(/Independent reviewer/u)).toBeVisible();
			const toggle = page.getByRole("checkbox", {
				name: "Use the approval model in Auto mode",
				exact: true,
			});
			await expect(toggle).not.toBeChecked();
			await page.locator(".permission-approval-toggle").click();
			await expect(toggle).toBeChecked();
			await app.closeSettings();

			// One real Auto action goes to the dedicated connection and executes without a prompt.
			await app.submit("case-dedicated-review-read");
			await app.waitDone("case-dedicated-review-read");
			await expect(app.approval).toHaveCount(0);
			expect(app.provider.reviewCalls).toHaveLength(3);
			const review = app.provider.reviewCalls.at(-1)!;
			expect(review.model).toBe("reviewer-model");
			const messages = JSON.parse(review.payload).messages as Array<{
				role: string;
				content: string | Array<{ text: string }>;
			}>;
			const user = [...messages].reverse().find((message) => message.role === "user")!;
			const command = JSON.parse(
				typeof user.content === "string" ? user.content : user.content.map((part) => part.text).join("\n"),
			).action.command as string;
			expect(command).toContain("outside.txt");
			expect(review.payload).not.toContain("dedicated-review-key");
			expect(review.hasRawSecret).toBe(false);
		} finally {
			await app.close();
		}
	});

	test("the permission page mirrors reviewer state, links to model settings, and stays read-only on health", async () => {
		const app = await launchPermissionApp({ preset: "auto", tools, reviewer: reviewerSeed(false) });
		try {
			await app.openSettings("Permissions");
			const page = app.page;
			const toggle = page.getByRole("checkbox", { name: "Use the approval model in Auto mode", exact: true });
			await expect(toggle).not.toBeChecked();
			const toggleTrack = await page.locator(".permission-approval-toggle .auto-command-allowlist-toggle-track").boundingBox();
			expect(toggleTrack!.width).toBeGreaterThanOrEqual(28);
			expect(toggleTrack!.height).toBeGreaterThanOrEqual(16);
			await expect(page.getByText(/Approval model configured/u)).toBeVisible();
			await page.screenshot({ path: test.info().outputPath("permissions-settings.png") });

			await page.locator(".permission-approval-toggle").click();
			await expect(toggle).toBeChecked();
			// Toggling writes the single persisted switch, not a second copy.
			const auto = await page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: {
					getPermissionAutoSettings(): Promise<{ reviewerEnabled: boolean }>;
				} }).metis;
				return api.getPermissionAutoSettings();
			});
			expect(auto.reviewerEnabled).toBe(true);

			await page.getByRole("button", { name: "Edit approval model", exact: true }).click();
			const reviewerDialog = page.getByRole("dialog", { name: "Approval model", exact: true });
			await expect(reviewerDialog).toBeVisible();
			await expect(reviewerDialog.getByRole("button", { name: "Save approval model", exact: true })).toBeVisible();
			await reviewerDialog.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(reviewerDialog).toHaveCount(0);

			// Explicit self-test uses temporary fixtures and preserves the permission settings.
			await page.getByRole("button", { name: "Run sandbox self-test", exact: true }).click();
			await expect(page.locator(".sandbox-environment-status").filter({ hasText: /^Available$/ })).toBeVisible({ timeout: 30_000 });
			await expect(page.getByRole("button", { name: "Repair Windows sandbox", exact: true })).toHaveCount(0);
		} finally {
			await app.close();
		}
	});
});
