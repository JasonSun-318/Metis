import { describe, expect, it, vi } from "vitest";
import {
	ExecutionGrantStore,
	normalizePermissionAction,
	type PermissionAuditEvent,
	PermissionAuditWriter,
	type PermissionReviewer,
	type PermissionReviewResult,
	PermissionReviewRouter,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { actionInput, rootRecursiveDelete, sensitiveRead } from "./fixtures.ts";
import { highRiskRequest, reviewRequest, safeRequest } from "./runtime-fixtures.ts";

function allow(reviewer: "model" | "user" = "model"): PermissionReviewResult {
	return Object.freeze({
		kind: "allow",
		reviewer,
	});
}

function reviewer(result: PermissionReviewResult): PermissionReviewer & { review: ReturnType<typeof vi.fn> } {
	return { review: vi.fn(async () => result) };
}

describe("ToolAuthorizationRuntime", () => {
	it("executes a deterministic allow without constructing a reviewer", async () => {
		const reviewerFactory = vi.fn(() => reviewer(allow()));
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", reviewerFactory });

		await expect(runtime.authorizeAndExecute(safeRequest())).resolves.toBe("executed");
		expect(reviewerFactory).not.toHaveBeenCalled();
	});

	it("denies a sandbox-targeted action when sandbox health is unavailable", async () => {
		const execute = vi.fn(async () => "executed");
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1" });

		await expect(runtime.authorizeAndExecute(safeRequest({ sandboxHealth: "unavailable", execute }))).rejects.toThrow(
			"Sandbox is unavailable",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("binds reviewer arguments to the action digest and redacts them before review", async () => {
		const args = { path: String((actionInput().args as { path: string }).path), token: "secret-value" };
		const action = normalizePermissionAction(
			actionInput({
				args,
				toolName: "publish",
				toolIdentity: "mcp:publisher:publish:v1",
				provenance: "mcp",
				effects: ["external-side-effect"],
			}),
		);
		const review = vi.fn(async (request: Parameters<PermissionReviewer["review"]>[0]) => {
			expect(JSON.stringify(request.redactedArguments)).not.toContain("secret-value");
			return allow();
		});
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-args",
			reviewerFactory: () => ({ review }),
		});

		await expect(runtime.authorizeAndExecute(highRiskRequest({ action, args }))).resolves.toBe("executed");
		expect(review).toHaveBeenCalledOnce();
		await expect(
			runtime.authorizeAndExecute(highRiskRequest({ action, args: { ...args, path: "/changed" } })),
		).rejects.toThrow("Tool arguments changed");
	});

	it("escalates unavailable auto review to the user only when interactive", async () => {
		const model = reviewer({ kind: "unavailable", reviewer: "model", reason: "timeout" });
		const user = reviewer(allow("user"));
		const interactive = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			reviewerFactory: () => new PermissionReviewRouter({ model, user }),
		});

		await expect(interactive.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		expect(user.review).toHaveBeenCalledOnce();

		const headless = new ToolAuthorizationRuntime({
			sessionId: "session-2",
			reviewerFactory: () => new PermissionReviewRouter({ model, user }),
		});
		await expect(headless.authorizeAndExecute(highRiskRequest({ interactive: false }))).rejects.toThrow(
			"Permission denied",
		);
	});

	it("revalidates tool identity after review and before consuming a grant", async () => {
		let current = highRiskRequest().action;
		const fixture = reviewRequest(() => {
			current = Object.freeze({ ...current, toolIdentity: "mcp:publisher:publish:v2" });
		});
		const execute = vi.fn(async () => "executed");
		const request = {
			...fixture.request,
			get action() {
				return current;
			},
			execute,
		};
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			reviewerFactory: () => ({
				review: async () => {
					fixture.onReview();
					return allow();
				},
			}),
		});

		await expect(runtime.authorizeAndExecute(request)).rejects.toThrow("Tool identity changed");
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([
		["cwd", "Working directory changed"],
		["settings", "Permission settings changed"],
		["rule", "rule.deny"],
		["sandbox-health", "Sandbox health changed"],
	] as const)("rejects a %s change made while review is pending", async (change, expected) => {
		const base = highRiskRequest();
		let currentAction = base.action;
		let currentSettings = base.settings;
		let sandboxHealth = base.sandboxHealth;
		let rule: "deny" | undefined;
		const execute = vi.fn(async () => "executed");
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			projectPath: base.action.workspaceRoots[0],
			projectRules: { match: () => (rule ? { decision: rule } : undefined) },
			reviewerFactory: () => ({
				review: async () => {
					if (change === "cwd") {
						currentAction = Object.freeze({ ...currentAction, cwd: `${currentAction.cwd}/changed` });
					} else if (change === "settings") {
						currentSettings = Object.freeze({ ...currentSettings, approvalPolicy: "user" });
					} else if (change === "rule") {
						rule = "deny";
					} else {
						sandboxHealth = "unavailable";
					}
					return allow();
				},
			}),
		});
		const request = {
			...base,
			get action() {
				return currentAction;
			},
			get settings() {
				return currentSettings;
			},
			get sandboxHealth() {
				return sandboxHealth;
			},
			execute,
		};

		await expect(runtime.authorizeAndExecute(request)).rejects.toThrow(expected);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([
		"settings",
		"cwd",
		"model",
		"tool-registry",
		"provenance",
		"project-rules",
		"session",
		"sandbox-health",
	] as const)("invalidates a pending review after a %s lifecycle change", async (reason) => {
		const execute = vi.fn(async () => "executed");
		let runtime: ToolAuthorizationRuntime;
		runtime = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			reviewerFactory: () => ({
				review: async () => {
					runtime.invalidate(reason);
					return allow();
				},
			}),
		});

		await expect(runtime.authorizeAndExecute(highRiskRequest({ execute }))).rejects.toThrow("Permission denied");
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps hard denies above remembered rules and reviewer decisions", async () => {
		const execute = vi.fn(async () => "executed");
		const rules = { match: vi.fn(() => ({ decision: "allow" as const })) };
		const reviewerFactory = vi.fn(() => reviewer(allow("user")));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			projectPath: rootRecursiveDelete().workspaceRoots[0],
			projectRules: rules,
			reviewerFactory,
		});

		await expect(
			runtime.authorizeAndExecute(
				safeRequest({
					action: rootRecursiveDelete(),
					settings: { sandboxPolicy: "danger-full-access", approvalPolicy: "user" },
					execute,
				}),
			),
		).rejects.toThrow("Permission denied");
		expect(rules.match).not.toHaveBeenCalled();
		expect(reviewerFactory).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("applies exact remembered deny and allow before opening review", async () => {
		const reviewerFactory = vi.fn(() => reviewer(allow()));
		const action = highRiskRequest().action;
		const denied = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			projectPath: action.workspaceRoots[0],
			projectRules: { match: () => ({ decision: "deny" }) },
			reviewerFactory,
		});
		await expect(denied.authorizeAndExecute(highRiskRequest())).rejects.toThrow("Permission denied");

		const allowed = new ToolAuthorizationRuntime({
			sessionId: "session-2",
			projectPath: action.workspaceRoots[0],
			projectRules: { match: () => ({ decision: "allow" }) },
			reviewerFactory,
		});
		await expect(allowed.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		expect(reviewerFactory).not.toHaveBeenCalled();
	});

	it("never lets a remembered rule bypass a fresh critical-risk user decision", async () => {
		const action = sensitiveRead();
		const model = reviewer(allow());
		const user = reviewer(allow("user"));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			projectPath: action.workspaceRoots[0],
			projectRules: { match: () => ({ decision: "allow" }) },
			reviewerFactory: () => new PermissionReviewRouter({ model, user }),
		});

		await expect(runtime.authorizeAndExecute(safeRequest({ action }))).resolves.toBe("executed");
		expect(model.review).not.toHaveBeenCalled();
		expect(user.review).toHaveBeenCalledOnce();
	});

	it("detects in-place action mutation and writes only redacted bounded audit events", async () => {
		const mutable = {
			...normalizePermissionAction(actionInput()),
			workspaceRoots: [...normalizePermissionAction(actionInput()).workspaceRoots],
		};
		const events: PermissionAuditEvent[] = [];
		const audit = new PermissionAuditWriter({
			append: (event) => {
				events.push(event);
			},
		});
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-1",
			audit,
			createEventId: (() => {
				let id = 0;
				return () => `event-${++id}`;
			})(),
		});
		const execute = vi.fn(async () => "executed");
		const request = safeRequest({ action: mutable, execute });
		const pending = runtime.authorizeAndExecute(request);
		mutable.workspaceRoots[0] = `${mutable.workspaceRoots[0]}/changed`;

		await expect(pending).rejects.toThrow("Workspace roots changed");
		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(events)).not.toMatch(/Perform this exact requested action|secret|base64/i);
	});

	it("revokes authority after execution failure and reports cancellation as denial", async () => {
		const grants = new ExecutionGrantStore({ createId: () => "grant-1" });
		const revoke = vi.spyOn(grants, "revoke");
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", grants });
		await expect(
			runtime.authorizeAndExecute(
				safeRequest({
					execute: async () => {
						throw new Error("adapter failed");
					},
				}),
			),
		).rejects.toThrow("adapter failed");
		expect(revoke).toHaveBeenCalledWith("grant-1");

		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(runtime.authorizeAndExecute(safeRequest({ signal: controller.signal }))).rejects.toThrow(
			"Permission denied",
		);
	});

	function bashOutside(command: string) {
		return normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command },
				command,
				readPaths: ["/tmp"],
				writePaths: [],
			}),
		);
	}

	it.each(["ls /tmp", "git status --short"] as const)(
		"executes allowlisted %s without constructing a reviewer",
		async (command) => {
			const reviewerFactory = vi.fn(() => reviewer(allow()));
			const grants = new ExecutionGrantStore();
			const consumeExact = vi.spyOn(grants, "consumeExact");
			const execute = vi.fn(async () => "executed");
			const runtime = new ToolAuthorizationRuntime({ sessionId: "session-allowlist", reviewerFactory, grants });
			const prefix = command.startsWith("git") ? "git status" : "ls";

			await expect(
				runtime.authorizeAndExecute(
					safeRequest({
						action: bashOutside(command),
						args: { command },
						autoCommandRules: [{ command: prefix, allowNetwork: false }],
						execute,
					}),
				),
			).resolves.toBe("executed");
			expect(reviewerFactory).not.toHaveBeenCalled();
			expect(execute).toHaveBeenCalledOnce();
			expect(consumeExact).toHaveBeenCalledOnce();
		},
	);

	it("denies a stale Auto command rule before consuming the grant", async () => {
		let rules = [{ command: "ls", allowNetwork: false }];
		const grants = new ExecutionGrantStore();
		const issue = grants.issue.bind(grants);
		vi.spyOn(grants, "issue").mockImplementation((input) => {
			const grant = issue(input);
			rules = [];
			return grant;
		});
		const execute = vi.fn(async () => "executed");
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-stale-rules", grants });

		await expect(
			runtime.authorizeAndExecute({
				...safeRequest({
					action: bashOutside("ls /tmp"),
					args: { command: "ls /tmp" },
					execute,
				}),
				get autoCommandRules() {
					return rules;
				},
			}),
		).rejects.toThrow("Auto command rules changed");
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not allowlist a complex outside-workspace command", async () => {
		const model = reviewer(allow());
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-complex",
			reviewerFactory: () => model,
		});

		await expect(
			runtime.authorizeAndExecute(
				safeRequest({
					action: bashOutside("ls /tmp | cat"),
					args: { command: "ls /tmp | cat" },
					autoCommandRules: [{ command: "ls", allowNetwork: false }],
				}),
			),
		).resolves.toBe("executed");
		expect(model.review).toHaveBeenCalledOnce();
	});
});
