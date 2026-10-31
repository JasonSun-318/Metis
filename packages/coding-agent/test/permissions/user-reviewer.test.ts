import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionApprovalRequest, RequestPermissionApproval } from "../../src/core/permissions/approval.ts";
import {
	digestCanonical,
	digestPermissionAction,
	normalizePermissionAction,
	ProjectPermissionRuleStore,
	UserPermissionReviewer,
} from "../../src/core/permissions/index.ts";
import { buildModelReviewInput } from "../../src/core/permissions/reviewer-input.ts";
import { SessionPermissionRuleStore } from "../../src/core/permissions/session-rules.ts";
import { actionInput } from "./fixtures.ts";
import { reviewInput } from "./reviewer-fixtures.ts";

type ApprovalResponse = Awaited<ReturnType<RequestPermissionApproval>>;

function reviewerRequest(projectPath: string, overrides: Parameters<typeof reviewInput>[0] = {}) {
	const defaultAction = normalizePermissionAction(
		actionInput({
			cwd: projectPath,
			workspaceRoots: [projectPath],
			toolName: "write_file",
			toolIdentity: "builtin:write_file:v1",
			args: { path: join(projectPath, "out.txt"), content: "hello" },
			readPaths: [],
			writePaths: [join(projectPath, "out.txt")],
		}),
	);
	const action = overrides.action ?? defaultAction;
	return reviewInput({
		action,
		decision: {
			kind: "review",
			riskLevel: "medium",
			minimumReviewer: "user",
			reason: "User review is required",
			grant: {
				executionTarget: "sandbox",
				readRoots: action.readPaths,
				writeRoots: action.writePaths,
				protectedRoots: [],
				networkEndpoints: action.networkEndpoints,
			},
		},
		redactedArguments: { path: join(projectPath, "out.txt"), token: "secret-value" },
		...overrides,
	});
}

function interaction(response: ApprovalResponse | unknown): {
	readonly calls: PermissionApprovalRequest[];
	readonly requestApproval: RequestPermissionApproval;
} {
	const calls: PermissionApprovalRequest[] = [];
	return {
		calls,
		requestApproval: async (approval) => {
			calls.push(approval);
			return response as ApprovalResponse;
		},
	};
}

describe("UserPermissionReviewer", () => {
	let root: string;
	let agentDir: string;
	let projectPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-user-reviewer-"));
		agentDir = join(root, "agent");
		projectPath = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(projectPath);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each([
		[{ decision: "allow" }, "allow"],
		[{ decision: "deny" }, "deny"],
	] as const)("returns the exact one-shot decision for %o", async (choice, expected) => {
		const ui = interaction(choice);
		const store = new ProjectPermissionRuleStore(agentDir);
		const reviewer = new UserPermissionReviewer({
			requestApproval: ui.requestApproval,
			projectRules: store,
			projectPath,
		});

		expect(await reviewer.review(reviewerRequest(projectPath))).toMatchObject({
			kind: expected,
			reviewer: "user",
		});
		expect(store.list(projectPath)).toEqual([]);
	});

	it.each(["allow", "deny"] as const)(
		"opens human fallback for oversized model analysis and respects the user's %s",
		async (decision) => {
			const command = 'for name in a b c; do ls -ld "$name"; done';
			const action = normalizePermissionAction(
				actionInput({
					cwd: projectPath,
					workspaceRoots: [projectPath],
					toolName: "bash",
					toolIdentity: "builtin:bash:v1",
					args: { command },
					command,
					readPaths: [projectPath],
					writePaths: [],
					shellAnalysis: {
						disposition: "review",
						complete: true,
						commands: Array.from({ length: 116 }, () => ({
							argv: ["ls", "-ld"],
							disposition: "review" as const,
							complete: true,
							effects: [],
							networkEndpoints: [],
						})),
					},
				}),
			);
			const request = reviewerRequest(projectPath, {
				action,
				redactedArguments: { command, token: "secret-value" },
				priorModelOutcome: "unavailable",
			});
			expect(() => buildModelReviewInput(request)).toThrow("8 KiB");
			const ui = interaction({ decision });
			const reviewer = new UserPermissionReviewer({ requestApproval: ui.requestApproval, projectPath });

			expect(await reviewer.review(request)).toMatchObject({
				kind: decision,
				reviewer: "user",
				manualReason: "model-unavailable",
			});
			expect(ui.calls).toHaveLength(1);
			expect(ui.calls[0]?.action.command).toBe(command);
			expect(ui.calls[0]?.action.paths).toEqual(action.readPaths);
			expect(ui.calls[0]?.args).toMatchObject({ automaticReview: "unavailable", readPaths: action.readPaths });
			expect(JSON.stringify(ui.calls[0])).not.toContain("secret-value");
		},
	);

	it("persists only the exact rule after an explicit remember choice", async () => {
		const ui = interaction({ decision: "allow", remember: "project" });
		const store = new ProjectPermissionRuleStore(agentDir);
		const request = reviewerRequest(projectPath);
		const reviewer = new UserPermissionReviewer({
			requestApproval: ui.requestApproval,
			projectRules: store,
			projectPath,
		});

		expect(await reviewer.review(request)).toMatchObject({ kind: "allow", reviewer: "user" });
		const exactInput = {
			projectPath,
			actionDigest: digestPermissionAction(request.action),
			grantDigest: digestCanonical(request.decision.grant),
			toolName: request.action.toolName,
			toolIdentity: request.action.toolIdentity,
			riskLevel: request.decision.riskLevel,
			summary: store.list(projectPath)[0]?.summary ?? [],
		};
		expect(store.match(exactInput)).toMatchObject({ decision: "allow" });
		expect(store.match({ ...exactInput, actionDigest: digestCanonical("different") })).toBeUndefined();
		expect(store.match({ ...exactInput, grantDigest: digestCanonical("different") })).toBeUndefined();
	});

	it("persists an exact deny rule after Always deny", async () => {
		const ui = interaction({ decision: "deny", remember: "project" });
		const store = new ProjectPermissionRuleStore(agentDir);
		const request = reviewerRequest(projectPath);
		const reviewer = new UserPermissionReviewer({
			requestApproval: ui.requestApproval,
			projectRules: store,
			projectPath,
		});

		expect(await reviewer.review(request)).toMatchObject({ kind: "deny", reviewer: "user" });
		expect(
			store.match({
				projectPath,
				actionDigest: digestPermissionAction(request.action),
				grantDigest: digestCanonical(request.decision.grant),
				toolName: request.action.toolName,
				toolIdentity: request.action.toolIdentity,
				riskLevel: request.decision.riskLevel,
				summary: store.list(projectPath)[0]?.summary ?? [],
			}),
		).toMatchObject({ decision: "deny" });
	});

	it("does not override an existing exact deny rule", async () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const request = reviewerRequest(projectPath);
		const exactInput = {
			projectPath,
			actionDigest: digestPermissionAction(request.action),
			grantDigest: digestCanonical(request.decision.grant),
			toolName: request.action.toolName,
			toolIdentity: request.action.toolIdentity,
			riskLevel: request.decision.riskLevel,
			summary: [{ label: "Risk", value: request.decision.riskLevel }],
		};
		store.rememberDeny(exactInput);
		const reviewer = new UserPermissionReviewer({
			requestApproval: interaction({ decision: "allow", remember: "project" }).requestApproval,
			projectRules: store,
			projectPath,
		});

		expect(await reviewer.review(request)).toMatchObject({ kind: "unavailable", reviewer: "user" });
		expect(store.match(exactInput)).toMatchObject({ decision: "deny" });
	});

	it("sends only bounded redacted structured details to the interaction", async () => {
		const ui = interaction({ decision: "deny" });
		const reviewer = new UserPermissionReviewer({ requestApproval: ui.requestApproval, projectPath });

		await reviewer.review(reviewerRequest(projectPath));

		const approval = ui.calls[0];
		const serialized = JSON.stringify(approval);
		const reviewed = reviewerRequest(projectPath);
		expect(serialized).not.toContain("secret-value");
		expect(approval).toMatchObject({
			executionTarget: "sandbox",
			rememberProjectEligible: false,
			action: {
				toolName: "write_file",
				paths: reviewed.action.writePaths,
			},
			args: {
				reviewer: "user",
				deterministicRisk: "medium",
				provenance: "builtin",
			},
		});
		expect(serialized).toContain("<redacted>");
	});

	it.each(["deny", "unavailable"] as const)("projects the prior model %s without rationale", async (outcome) => {
		const ui = interaction({ decision: "deny" });
		const reviewer = new UserPermissionReviewer({ requestApproval: ui.requestApproval, projectPath });
		const request = reviewerRequest(projectPath, {
			decision: { ...reviewerRequest(projectPath).decision, minimumReviewer: "model" },
			priorModelOutcome: outcome,
		});

		await reviewer.review(request);

		expect(ui.calls[0]?.args).toMatchObject({ automaticReview: outcome });
		expect(JSON.stringify(ui.calls[0])).not.toContain("rationale");
	});

	async function manualReasonFor(overrides: Parameters<typeof reviewerRequest>[1] = {}) {
		const ui = interaction({ decision: "allow" });
		const reviewer = new UserPermissionReviewer({ requestApproval: ui.requestApproval, projectPath });
		const result = await reviewer.review(reviewerRequest(projectPath, overrides));
		expect(result).toMatchObject({ kind: "allow", reviewer: "user" });
		return result.kind === "allow" ? result.manualReason : undefined;
	}

	it("reports writes, sensitive reads, and incomplete analysis from the reviewed action", async () => {
		expect(await manualReasonFor()).toBe("write");
		expect(
			await manualReasonFor({
				action: normalizePermissionAction(
					actionInput({
						cwd: projectPath,
						workspaceRoots: [projectPath],
						readPaths: [join(projectPath, ".env")],
						effects: ["sensitive-read"],
					}),
				),
			}),
		).toBe("sensitive");
		expect(
			await manualReasonFor({
				action: normalizePermissionAction(
					actionInput({
						cwd: projectPath,
						workspaceRoots: [projectPath],
						toolName: "bash",
						toolIdentity: "builtin:bash:v1",
						args: { command: "python script.py" },
						command: "python script.py",
						readPaths: [],
						writePaths: [],
						effects: [],
					}),
				),
				redactedArguments: { command: "python script.py" },
			}),
		).toBe("analysis-incomplete");
	});

	it("reports the prior model routing outcome and timeout fact", async () => {
		expect(await manualReasonFor({ priorModelOutcome: "deny" })).toBe("model-denied");
		expect(
			await manualReasonFor({
				priorModelOutcome: "unavailable",
				priorModelReason: "Permission review was cancelled or timed out",
			}),
		).toBe("model-timeout");
		expect(
			await manualReasonFor({
				priorModelOutcome: "unavailable",
				priorModelReason: "The configured permission reviewer model is unavailable",
			}),
		).toBe("model-unavailable");
	});

	it.each([
		["closed", () => Promise.reject(new Error("closed"))],
		["disconnected", () => Promise.reject(new Error("disconnected"))],
		["invalid decision", () => Promise.resolve({ decision: "maybe" } as never)],
		["extra field", () => Promise.resolve({ decision: "allow", unexpected: true } as never)],
	] as const)("returns unavailable when the interaction is %s", async (_label, requestApproval) => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const reviewer = new UserPermissionReviewer({ requestApproval, projectRules: store, projectPath });

		expect(await reviewer.review(reviewerRequest(projectPath))).toMatchObject({
			kind: "unavailable",
			reviewer: "user",
		});
		expect(store.list(projectPath)).toEqual([]);
	});

	it("returns unavailable when aborted before or during the interaction", async () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const before = new AbortController();
		before.abort();
		const notCalled = vi.fn<RequestPermissionApproval>();
		const first = new UserPermissionReviewer({ requestApproval: notCalled, projectRules: store, projectPath });
		expect(await first.review(reviewerRequest(projectPath, { signal: before.signal }))).toMatchObject({
			kind: "unavailable",
		});
		expect(notCalled).not.toHaveBeenCalled();

		const during = new AbortController();
		const second = new UserPermissionReviewer({
			projectPath,
			projectRules: store,
			requestApproval: async () => {
				during.abort();
				return { decision: "allow" };
			},
		});
		expect(await second.review(reviewerRequest(projectPath, { signal: during.signal }))).toMatchObject({
			kind: "unavailable",
		});
		expect(store.list(projectPath)).toEqual([]);
	});

	it("does not remember an action under a different project", async () => {
		const otherProject = join(root, "other-project");
		mkdirSync(otherProject);
		const store = new ProjectPermissionRuleStore(agentDir);
		const reviewer = new UserPermissionReviewer({
			requestApproval: interaction({ decision: "allow", remember: "project" }).requestApproval,
			projectRules: store,
			projectPath: otherProject,
		});

		expect(await reviewer.review(reviewerRequest(projectPath))).toMatchObject({
			kind: "unavailable",
			reviewer: "user",
		});
		expect(store.list(projectPath)).toEqual([]);
		expect(store.list(otherProject)).toEqual([]);
	});

	it.each([
		["incomplete", { effects: ["unknown"] as const, riskLevel: "high" as const }],
		["critical", { effects: ["destructive"] as const, riskLevel: "critical" as const }],
	] as const)("refuses to persist an exact rule for %s scope", async (_label, scenario) => {
		const base = reviewerRequest(projectPath);
		const action = normalizePermissionAction(
			actionInput({
				cwd: projectPath,
				workspaceRoots: [projectPath],
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "danger" },
				command: "danger",
				readPaths: [],
				writePaths: [join(projectPath, "out.txt")],
				effects: scenario.effects,
			}),
		);
		const request = reviewerRequest(projectPath, {
			action,
			decision: {
				...base.decision,
				riskLevel: scenario.riskLevel,
				grant: { ...base.decision.grant, writeRoots: action.writePaths },
			},
		});
		const store = new ProjectPermissionRuleStore(agentDir);
		const reviewer = new UserPermissionReviewer({
			requestApproval: interaction({ decision: "allow", remember: "project" }).requestApproval,
			projectRules: store,
			projectPath,
		});

		expect(await reviewer.review(request)).toMatchObject({ kind: "unavailable", reviewer: "user" });
		expect(store.list(projectPath)).toEqual([]);
	});

	it("remembers an exact session allow when explicitly chosen", async () => {
		const ui = interaction({ decision: "allow", remember: "session" });
		const projectStore = new ProjectPermissionRuleStore(agentDir);
		const sessionStore = new SessionPermissionRuleStore("session-1");
		const request = reviewerRequest(projectPath);
		const reviewer = new UserPermissionReviewer({
			requestApproval: ui.requestApproval,
			projectRules: projectStore,
			sessionRules: sessionStore,
			projectPath,
		});

		expect(await reviewer.review(request)).toMatchObject({ kind: "allow", reviewer: "user" });
		expect(ui.calls[0]).toMatchObject({ rememberProjectEligible: true, rememberSessionEligible: true });
		const exactInput = {
			projectPath,
			actionDigest: digestPermissionAction(request.action),
			grantDigest: digestCanonical(request.decision.grant),
			toolName: request.action.toolName,
			toolIdentity: request.action.toolIdentity,
			riskLevel: request.decision.riskLevel,
			summary: sessionStore.list(projectPath)[0]?.summary ?? [],
		};
		expect(sessionStore.match(exactInput)).toMatchObject({ decision: "allow", sessionId: "session-1" });
		expect(sessionStore.match({ ...exactInput, grantDigest: digestCanonical("different") })).toBeUndefined();
		expect(projectStore.list(projectPath)).toEqual([]);
	});

	it("does not offer a session remember without a session store", async () => {
		const ui = interaction({ decision: "allow", remember: "session" });
		const reviewer = new UserPermissionReviewer({
			requestApproval: ui.requestApproval,
			projectRules: new ProjectPermissionRuleStore(agentDir),
			projectPath,
		});

		expect(await reviewer.review(reviewerRequest(projectPath))).toMatchObject({
			kind: "unavailable",
			reviewer: "user",
		});
		expect(ui.calls[0]).toMatchObject({ rememberProjectEligible: true, rememberSessionEligible: false });
	});

	it("refuses to remember a session allow for ineligible scope", async () => {
		const base = reviewerRequest(projectPath);
		const action = normalizePermissionAction(
			actionInput({
				cwd: projectPath,
				workspaceRoots: [projectPath],
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "danger" },
				command: "danger",
				readPaths: [],
				writePaths: [join(projectPath, "out.txt")],
				effects: ["unknown"],
			}),
		);
		const request = reviewerRequest(projectPath, {
			action,
			decision: {
				...base.decision,
				riskLevel: "high",
				grant: { ...base.decision.grant, writeRoots: action.writePaths },
			},
		});
		const sessionStore = new SessionPermissionRuleStore("session-1");
		const reviewer = new UserPermissionReviewer({
			requestApproval: interaction({ decision: "allow", remember: "session" }).requestApproval,
			sessionRules: sessionStore,
			projectPath,
		});

		expect(await reviewer.review(request)).toMatchObject({ kind: "unavailable", reviewer: "user" });
		expect(uiCalls(sessionStore, projectPath)).toEqual([]);
	});

	it("rejects a session remember on a deny decision", async () => {
		const sessionStore = new SessionPermissionRuleStore("session-1");
		const reviewer = new UserPermissionReviewer({
			requestApproval: interaction({ decision: "deny", remember: "session" }).requestApproval,
			sessionRules: sessionStore,
			projectPath,
		});

		expect(await reviewer.review(reviewerRequest(projectPath))).toMatchObject({
			kind: "unavailable",
			reviewer: "user",
		});
		expect(uiCalls(sessionStore, projectPath)).toEqual([]);
	});

	it("refuses an oversized command without opening the approval interaction", async () => {
		const oversized = `echo ${"a".repeat(32 * 1024)}`;
		const base = reviewerRequest(projectPath);
		const action = normalizePermissionAction(
			actionInput({
				cwd: projectPath,
				workspaceRoots: [projectPath],
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: oversized },
				command: oversized,
				readPaths: [],
				writePaths: [],
			}),
		);
		const requestApproval = vi.fn<RequestPermissionApproval>();
		const reviewer = new UserPermissionReviewer({
			requestApproval,
			sessionRules: new SessionPermissionRuleStore("session-1"),
			projectPath,
		});

		const outcome = await reviewer.review(
			reviewerRequest(projectPath, {
				action,
				decision: { ...base.decision, grant: { ...base.decision.grant, writeRoots: action.writePaths } },
			}),
		);
		expect(outcome).toMatchObject({ kind: "unavailable", reviewer: "user" });
		expect(outcome.kind === "unavailable" && outcome.reason).toContain("split it into smaller commands and retry");
		expect(requestApproval).not.toHaveBeenCalled();
	});

	function uiCalls(store: SessionPermissionRuleStore, project: string) {
		return store.list(project);
	}
});
