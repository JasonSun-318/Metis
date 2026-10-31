import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	digestCanonical,
	digestPermissionAction,
	ExecutionGrantStore,
	normalizePermissionAction,
	type PermissionAuditEvent,
	PermissionAuditWriter,
	type PermissionReviewer,
	type PermissionReviewResult,
	PermissionReviewRouter,
	ProjectPermissionRuleStore,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { SessionPermissionRuleStore } from "../../src/core/permissions/session-rules.ts";
import { analyzeShellCommand } from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { actionInput, outsideRead, projectDir, rootRecursiveDelete, sensitiveRead } from "./fixtures.ts";
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

beforeAll(async () => initializeShellAnalysis());

describe("ToolAuthorizationRuntime", () => {
	it.each(["model", "user"] as const)("reports the final %s source after exact authorization", async (source) => {
		const onDecision = vi.fn();
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-source",
			onDecision,
			reviewerFactory: () => reviewer(allow(source)),
		});
		const request = safeRequest({ action: outsideRead() });
		await runtime.authorizeAndExecute(request);
		expect(onDecision).toHaveBeenCalledExactlyOnceWith({
			actionId: request.action.actionId,
			toolName: request.action.toolName,
			source,
		});
	});

	it("reports rule/full sources and never reports denied or cancelled actions", async () => {
		const onDecision = vi.fn();
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-source", onDecision });
		await runtime.authorizeAndExecute(safeRequest());
		expect(onDecision).toHaveBeenLastCalledWith(expect.objectContaining({ source: "rule" }));
		await runtime.authorizeAndExecute(
			safeRequest({ settings: { sandboxPolicy: "danger-full-access", approvalPolicy: "never" } }),
		);
		expect(onDecision).toHaveBeenLastCalledWith(expect.objectContaining({ source: "full" }));
		onDecision.mockClear();
		await expect(runtime.authorizeAndExecute(safeRequest({ sandboxHealth: "unavailable" }))).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(runtime.authorizeAndExecute(safeRequest({ signal: controller.signal }))).rejects.toThrow();
		expect(onDecision).not.toHaveBeenCalled();
	});

	it("does not read either rule configuration on the Full access path", async () => {
		const runtime = new ToolAuthorizationRuntime({ sessionId: "full-rules" });
		const request = safeRequest({ settings: { sandboxPolicy: "danger-full-access", approvalPolicy: "never" } });
		Object.defineProperties(request, {
			permissionRules: {
				get: () => {
					throw new Error("Invalid rules");
				},
			},
			autoCommandRules: {
				get: () => {
					throw new Error("Invalid legacy rules");
				},
			},
		});
		await expect(runtime.authorizeAndExecute(request)).resolves.toBe("executed");
	});

	it("cannot execute after an observer invalidates authorization", async () => {
		const execute = vi.fn(async () => "executed");
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "session-source",
			onDecision: () => runtime.invalidate("settings"),
		});
		await expect(runtime.authorizeAndExecute(safeRequest({ execute }))).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
	});

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
			return allow("user");
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
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
		});

		await expect(interactive.authorizeAndExecute(safeRequest({ action: outsideRead() }))).resolves.toBe("executed");
		expect(model.review).toHaveBeenCalledOnce();
		expect(user.review).toHaveBeenCalledOnce();

		const headless = new ToolAuthorizationRuntime({
			sessionId: "session-2",
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
		});
		await expect(
			headless.authorizeAndExecute(safeRequest({ action: outsideRead(), interactive: false })),
		).rejects.toThrow("Permission denied");
		expect(model.review).toHaveBeenCalledTimes(2);
		expect(user.review).toHaveBeenCalledOnce();
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
					return allow("user");
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
					return allow("user");
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
					return allow("user");
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
			reviewerFactory: () => new PermissionReviewRouter({ model, user, isModelEnabled: () => true }),
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
		const analysis = analyzeShellCommand({
			command,
			cwd: projectDir,
			workspaceRoots: [projectDir],
			shellPath: "/bin/bash",
		});
		return normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command },
				command,
				readPaths: ["/tmp"],
				writePaths: [],
				shellAnalysis: {
					disposition: analysis.disposition,
					complete: analysis.complete,
					commands: analysis.commands,
				},
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

	describe("session permission rules", () => {
		async function captureReviewRule(
			store: SessionPermissionRuleStore,
			projectPath: string,
			summary: readonly { readonly label: string; readonly value: string }[] = [],
		): Promise<void> {
			// Session rules bind to the real project directory; make sure it exists.
			mkdirSync(projectPath, { recursive: true });
			let captured: Parameters<PermissionReviewer["review"]>[0] | undefined;
			const reviewed = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules: store,
				reviewerFactory: () => ({
					review: async (request) => {
						captured = request;
						return allow("user");
					},
				}),
			});
			await expect(reviewed.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			if (!captured) throw new Error("review did not run");
			store.rememberAllow({
				projectPath,
				actionDigest: digestPermissionAction(captured.action),
				grantDigest: digestCanonical(captured.decision.grant),
				toolName: captured.action.toolName,
				toolIdentity: captured.action.toolIdentity,
				riskLevel: captured.decision.riskLevel,
				summary,
			});
		}

		it("reuses an exact session allow without another reviewer round-trip", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath);

			const reused = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules,
				reviewerFactory: () => {
					throw new Error("a remembered session allow must not open a review");
				},
			});
			await expect(reused.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		});

		it("reports the real exact session rule identity and scope", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath, [{ label: "Tool", value: "publish" }]);
			const [rule] = sessionRules.list(projectPath);
			const onDecision = vi.fn();

			const reused = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules,
				onDecision,
				reviewerFactory: () => {
					throw new Error("a remembered session allow must not open a review");
				},
			});
			await expect(reused.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			expect(onDecision).toHaveBeenCalledWith({
				actionId: action.actionId,
				toolName: "publish",
				source: "rule",
				ruleIds: [rule.id],
				matchedRule: { id: rule.id, name: "publish", scope: "session" },
			});
		});

		it("reports the real exact project rule identity and scope", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			mkdirSync(projectPath, { recursive: true });
			const agentDir = mkdtempSync(join(tmpdir(), "metis-project-rule-"));
			try {
				const projectRules = new ProjectPermissionRuleStore(agentDir);
				let captured: Parameters<PermissionReviewer["review"]>[0] | undefined;
				const reviewed = new ToolAuthorizationRuntime({
					sessionId: "session-1",
					projectPath,
					projectRules,
					reviewerFactory: () => ({
						review: async (request) => {
							captured = request;
							return allow("user");
						},
					}),
				});
				await reviewed.authorizeAndExecute(highRiskRequest());
				if (!captured) throw new Error("review did not run");
				projectRules.rememberAllow({
					projectPath,
					actionDigest: digestPermissionAction(captured.action),
					grantDigest: digestCanonical(captured.decision.grant),
					toolName: captured.action.toolName,
					toolIdentity: captured.action.toolIdentity,
					riskLevel: captured.decision.riskLevel,
					summary: [{ label: "Tool", value: "publish" }],
				});
				const [rule] = projectRules.list(projectPath);
				const onDecision = vi.fn();
				const reused = new ToolAuthorizationRuntime({
					sessionId: "session-1",
					projectPath,
					projectRules,
					onDecision,
					reviewerFactory: () => {
						throw new Error("a remembered project allow must not open a review");
					},
				});

				await expect(reused.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
				expect(onDecision).toHaveBeenCalledWith({
					actionId: action.actionId,
					toolName: "publish",
					source: "rule",
					ruleIds: [rule.id],
					matchedRule: { id: rule.id, name: "publish", scope: "project" },
				});
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		});

		it("does not fabricate rule details for a matcher that only returns a decision", async () => {
			const action = highRiskRequest().action;
			const onDecision = vi.fn();
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath: action.workspaceRoots[0],
				projectRules: { match: () => ({ decision: "allow" }) },
				onDecision,
				reviewerFactory: () => {
					throw new Error("a remembered allow must not open a review");
				},
			});

			await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			expect(onDecision).toHaveBeenCalledWith({
				actionId: action.actionId,
				toolName: "publish",
				source: "rule",
			});
		});

		it("does not reuse a session allow from another session", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath);

			const review = vi.fn(async () => allow("user"));
			const other = new ToolAuthorizationRuntime({
				sessionId: "session-2",
				projectPath,
				sessionRules: new SessionPermissionRuleStore("session-2"),
				reviewerFactory: () => ({ review }),
			});
			await expect(other.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			expect(review).toHaveBeenCalledOnce();
		});

		it("keeps an exact project deny above a session allow", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath);

			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				projectRules: { match: () => ({ decision: "deny" }) },
				sessionRules,
				reviewerFactory: () => {
					throw new Error("a project deny must short-circuit before review");
				},
			});
			await expect(runtime.authorizeAndExecute(highRiskRequest())).rejects.toThrow("rule.deny");
		});

		it("keeps a one-shot allow out of the session rule store", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules,
				reviewerFactory: () => reviewer(allow("user")),
			});

			await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			expect(sessionRules.list(projectPath)).toEqual([]);
		});

		it("requires review again after a remembered session allow is revoked", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath);

			const review = vi.fn(async () => allow("user"));
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules,
				reviewerFactory: () => ({ review }),
			});
			await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			expect(review).not.toHaveBeenCalled();

			const [rule] = sessionRules.list(projectPath);
			expect(sessionRules.delete(projectPath, rule.id)).toBe(true);
			runtime.invalidate("project-rules");
			await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
			expect(review).toHaveBeenCalledOnce();
		});

		it("fails an outstanding exact grant when its session allow is deleted", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath);
			const [rule] = sessionRules.list(projectPath);
			const execute = vi.fn(async () => "executed");
			let runtime!: ToolAuthorizationRuntime;
			const audit = new PermissionAuditWriter({
				append: (event) => {
					if (event.stage === "grant-issued") {
						expect(sessionRules.delete(projectPath, rule.id)).toBe(true);
						runtime.invalidate("project-rules");
					}
				},
			});
			runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules,
				audit,
				reviewerFactory: () => {
					throw new Error("a remembered session allow must not open a review");
				},
			});

			await expect(runtime.authorizeAndExecute(highRiskRequest({ execute }))).rejects.toThrow("Permission denied");
			expect(execute).not.toHaveBeenCalled();
		});

		it("keeps session allows across reviewer and mode changes but not tool identity changes", async () => {
			const action = highRiskRequest().action;
			const projectPath = action.workspaceRoots[0];
			const sessionRules = new SessionPermissionRuleStore("session-1");
			await captureReviewRule(sessionRules, projectPath);

			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath,
				sessionRules,
				reviewerFactory: () => {
					throw new Error("reviewer changes must keep remembered session allows");
				},
			});
			runtime.invalidate("model");
			runtime.invalidate("settings");
			await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");

			runtime.invalidate("tool-registry");
			await expect(runtime.authorizeAndExecute(highRiskRequest())).rejects.toThrow("review.unavailable");
			expect(sessionRules.list(projectPath)).toEqual([]);
		});

		it("does not reuse a remembered allow when the action scope is incomplete", async () => {
			const action = normalizePermissionAction(
				actionInput({
					toolName: "custom_tool",
					toolIdentity: "mcp:custom:v1",
					provenance: "mcp",
					effects: ["unknown"],
					networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
				}),
			);
			const review = vi.fn(async () => allow("user"));
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath: action.workspaceRoots[0],
				projectRules: { match: () => ({ decision: "allow" }) },
				sessionRules: { match: () => ({ decision: "allow" }) },
				reviewerFactory: () => ({ review }),
			});

			await expect(
				runtime.authorizeAndExecute(
					safeRequest({ action, settings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" } }),
				),
			).resolves.toBe("executed");
			expect(review).toHaveBeenCalledOnce();
		});

		it("does not read session rules on the Full access path", async () => {
			const match = vi.fn(() => ({ decision: "allow" as const }));
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "session-1",
				projectPath: highRiskRequest().action.workspaceRoots[0],
				projectRules: { match },
				sessionRules: { match },
				reviewerFactory: () => {
					throw new Error("Full access must not open a review");
				},
			});

			await expect(
				runtime.authorizeAndExecute(
					highRiskRequest({ settings: { sandboxPolicy: "danger-full-access", approvalPolicy: "never" } }),
				),
			).resolves.toBe("executed");
			expect(match).not.toHaveBeenCalled();
		});
	});
});
