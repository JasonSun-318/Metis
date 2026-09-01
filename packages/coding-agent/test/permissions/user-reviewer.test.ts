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
import { actionInput } from "./fixtures.ts";
import { reviewInput } from "./reviewer-fixtures.ts";

type ApprovalResponse = Awaited<ReturnType<RequestPermissionApproval>>;

function reviewerRequest(projectPath: string, overrides: Parameters<typeof reviewInput>[0] = {}) {
	const action = normalizePermissionAction(
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
});
