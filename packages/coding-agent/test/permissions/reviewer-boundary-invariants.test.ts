import { describe, expect, it, vi } from "vitest";
import {
	normalizePermissionAction,
	type PermissionReviewer,
	type PermissionReviewRequest,
	type PermissionReviewResult,
	PermissionReviewRouter,
	settingsForPreset,
	ToolAuthorizationRuntime,
	UserPermissionReviewer,
} from "../../src/core/permissions/index.ts";
import { buildModelReviewInput } from "../../src/core/permissions/reviewer-input.ts";
import { describeToolAction } from "../../src/core/tool-permission-adapter.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { actionInput, outsideRead, projectDir, sensitiveRead, workspaceWrite } from "./fixtures.ts";
import { highRiskRequest, safeRequest } from "./runtime-fixtures.ts";

function result(kind: "allow" | "deny" | "unavailable", reviewer: "model" | "user"): PermissionReviewResult {
	return Object.freeze(
		kind === "unavailable" ? { kind, reviewer, reason: "unavailable in test" } : { kind, reviewer },
	);
}

function fakeReviewer(decision: PermissionReviewResult): PermissionReviewer & { review: ReturnType<typeof vi.fn> } {
	return { review: vi.fn(async () => decision) };
}

describe("permission reviewer boundary invariants", () => {
	it.each(["ask", "auto"] as const)(
		"reviews the effective Bash command, including runtime prefixes, in %s",
		async (preset) => {
			const args = { command: "officecli --version" };
			const prefix = "readonly METIS_WORK_DIR TMPDIR TMP TEMP";
			const tool = createBashToolDefinition(projectDir, { prepareCommand: (command) => `${prefix}\n${command}` });
			const action = describeToolAction(tool, args, {
				actionId: "office-version",
				cwd: projectDir,
				workspaceRoots: [projectDir],
				provenance: "builtin",
				toolIdentity: "builtin:bash:v1",
			});
			const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
			const model = {
				review: vi.fn(async (request: PermissionReviewRequest) => {
					const input = buildModelReviewInput(request);
					expect(input.action.command).toBe(`${prefix}\n${args.command}`);
					return result("deny", "model");
				}),
			};
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "prefixed-bash",
				reviewerFactory: () =>
					new PermissionReviewRouter({
						model,
						user: new UserPermissionReviewer({ requestApproval }),
						isModelEnabled: () => true,
					}),
			});
			await expect(
				runtime.authorizeAndExecute(
					safeRequest({
						action,
						args,
						settings: settingsForPreset(preset),
						permissionRules: [],
					}),
				),
			).resolves.toBe("executed");
			expect(requestApproval).toHaveBeenCalledWith(
				expect.objectContaining({
					action: expect.objectContaining({ command: `${prefix}\n${args.command}` }),
				}),
			);
			expect(model.review).toHaveBeenCalledTimes(preset === "auto" ? 1 : 0);
		},
	);
	it.each([
		["write", workspaceWrite(), { path: `${projectDir}/out.txt`, content: "hello" }],
		[
			"network",
			normalizePermissionAction(actionInput({ networkEndpoints: [{ hostname: "example.com", port: 443 }] })),
			{ path: `${projectDir}/README.md` },
		],
		[
			"incomplete script",
			normalizePermissionAction(
				actionInput({
					toolName: "bash",
					toolIdentity: "builtin:bash:v1",
					command: "python -c 'print(42)'",
					args: { command: "python -c 'print(42)'" },
					effects: ["unknown"],
					shellAnalysis: { complete: false, disposition: "user", commands: [] },
				}),
			),
			{ command: "python -c 'print(42)'" },
		],
	] as const)("reviews %s before asking the user, and preserves fallback", async (_name, action, args) => {
		for (const modelOutcome of ["allow", "deny", "unavailable"] as const) {
			const model = fakeReviewer(result(modelOutcome, "model"));
			const user = fakeReviewer(result("allow", "user"));
			const execute = vi.fn(async () => "executed");
			const runtime = new ToolAuthorizationRuntime({
				sessionId: `session-${modelOutcome}`,
				reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
			});
			await expect(
				runtime.authorizeAndExecute(safeRequest({ action, args, permissionRules: [], execute })),
			).resolves.toBe("executed");
			expect(model.review).toHaveBeenCalledOnce();
			expect(user.review).toHaveBeenCalledTimes(modelOutcome === "allow" ? 0 : 1);
			expect(execute).toHaveBeenCalledOnce();
			if (modelOutcome !== "allow")
				expect(user.review.mock.calls[0]?.[0]).toMatchObject({ priorModelOutcome: modelOutcome });
		}
	});

	it.each(["host", "extension", "sdk", "mcp"] as const)(
		"keeps unruled %s tools on the human path",
		async (provenance) => {
			for (const scope of [
				{ effects: ["unknown"] },
				{ effects: ["external-side-effect"] },
				{ writePaths: [`${projectDir}/out.txt`] },
				{ networkEndpoints: [{ hostname: "example.com", port: 443 }] },
			] as const) {
				const action = normalizePermissionAction(
					actionInput({
						toolName: "external_action",
						toolIdentity: `${provenance}:external_action:v1`,
						provenance,
						...scope,
					}),
				);
				const model = fakeReviewer(result("allow", "model"));
				const user = fakeReviewer(result("allow", "user"));
				const runtime = new ToolAuthorizationRuntime({
					sessionId: `session-${provenance}`,
					reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
				});
				await expect(runtime.authorizeAndExecute(safeRequest({ action, permissionRules: [] }))).resolves.toBe(
					"executed",
				);
				expect(model.review).not.toHaveBeenCalled();
				expect(user.review).toHaveBeenCalledOnce();
			}
		},
	);

	it("keeps sensitive operations and Ask mode on the human path", async () => {
		for (const request of [
			safeRequest({ action: sensitiveRead() }),
			safeRequest({
				action: workspaceWrite(),
				args: { path: `${projectDir}/out.txt`, content: "hello" },
				settings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
			}),
		]) {
			const model = fakeReviewer(result("allow", "model"));
			const user = fakeReviewer(result("allow", "user"));
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-human",
				reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
			});
			await expect(runtime.authorizeAndExecute(request)).resolves.toBe("executed");
			expect(model.review).not.toHaveBeenCalled();
			expect(user.review).toHaveBeenCalledOnce();
		}
	});

	it("makes zero model and user calls when Auto is off and a rule already allows", async () => {
		const model = fakeReviewer(result("allow", "model"));
		const user = fakeReviewer(result("allow", "user"));
		const reviewerFactory = vi.fn(() => new PermissionReviewRouter({ model, user, isModelEnabled: () => false }));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-rule",
			projectPath: highRiskRequest().action.workspaceRoots[0],
			projectRules: { match: () => ({ decision: "allow" }) },
			reviewerFactory,
		});

		await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		expect(reviewerFactory).not.toHaveBeenCalled();
		expect(model.review).not.toHaveBeenCalled();
		expect(user.review).not.toHaveBeenCalled();
	});

	it("uses the interactive user when Auto is off and no rule applies", async () => {
		const model = fakeReviewer(result("allow", "model"));
		const user = fakeReviewer(result("allow", "user"));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-off",
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => false }),
		});

		await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		expect(model.review).not.toHaveBeenCalled();
		expect(user.review).toHaveBeenCalledOnce();
	});

	it("denies headless Auto candidates without creating a user approval request", async () => {
		const model = fakeReviewer(result("allow", "model"));
		const user = fakeReviewer(result("allow", "user"));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-headless",
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => false }),
		});

		await expect(runtime.authorizeAndExecute(highRiskRequest({ interactive: false }))).rejects.toThrow(
			"Permission denied",
		);
		expect(model.review).not.toHaveBeenCalled();
		expect(user.review).not.toHaveBeenCalled();
	});

	it("does not create user approval after session cancellation", async () => {
		const user = fakeReviewer(result("allow", "user"));
		let runtime!: ToolAuthorizationRuntime;
		const model: PermissionReviewer = {
			review: async () => {
				runtime.invalidate("session");
				return result("unavailable", "model");
			},
		};
		runtime = new ToolAuthorizationRuntime({
			sessionId: "session-cancelled",
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
		});

		await expect(
			runtime.authorizeAndExecute(safeRequest({ action: outsideRead(), execute: async () => "executed" })),
		).rejects.toThrow("Permission denied");
		expect(user.review).not.toHaveBeenCalled();
	});

	it("does not execute a late model approval after configuration invalidation", async () => {
		let release!: (decision: PermissionReviewResult) => void;
		const execute = vi.fn(async () => "executed");
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-late",
			reviewerFactory: () => ({
				review: async () =>
					new Promise<PermissionReviewResult>((resolve) => {
						release = resolve;
					}),
			}),
		});
		const pending = runtime.authorizeAndExecute(highRiskRequest({ execute }));
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));

		runtime.invalidate("settings");
		release(result("allow", "model"));

		await expect(pending).rejects.toThrow("Permission denied");
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps an Auto-off rule allow usable while model review stays disabled", async () => {
		const model = fakeReviewer(result("allow", "model"));
		const user = fakeReviewer(result("allow", "user"));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-safe",
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => false }),
		});

		await expect(runtime.authorizeAndExecute(safeRequest())).resolves.toBe("executed");
		expect(model.review).not.toHaveBeenCalled();
		expect(user.review).not.toHaveBeenCalled();
	});
});
