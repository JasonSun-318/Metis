import { homedir } from "node:os";
import { join, parse } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
	digestPermissionAction,
	type NormalizePermissionActionInput,
	normalizePermissionAction,
	PermissionPolicy,
	riskLevelFor,
	settingsForPreset,
} from "../../src/core/permissions/index.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";
import { actionInput, ordinaryRead, projectDir, workspaceWrite } from "./fixtures.ts";

describe("PermissionPolicy", () => {
	it.each(["host", "extension", "sdk"] as const)(
		"routes trusted in-process %s tools to the host target",
		(provenance) => {
			const action = normalizePermissionAction(actionInput({ provenance }));
			const decision = new PermissionPolicy().evaluate({
				action,
				settings: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
			});
			expect(decision.kind).toBe("allow");
			if (decision.kind !== "deny") expect(decision.grant.executionTarget).toBe("host");
		},
	);
	it("hard-denies recursive deletion of the filesystem root and home in every preset", () => {
		const protectedTargets = [parse(projectDir).root, homedir()];
		for (const target of protectedTargets) {
			const action = normalizePermissionAction(
				actionInput({
					toolName: "bash",
					toolIdentity: "builtin:bash:v1",
					args: { command: `rm -rf ${target}` },
					command: `rm -rf ${target}`,
					readPaths: [],
					writePaths: [target],
					effects: ["destructive"],
				}),
			);
			for (const preset of ["ask", "auto", "full"] as const) {
				expect(new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
					kind: "deny",
					riskLevel: "critical",
				});
			}
		}
	});

	it("denies recursive deletion in Auto and reviews it in Full", () => {
		const policy = new PermissionPolicy();
		const build = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "rm -rf ./build" },
				command: "rm -rf ./build",
				readPaths: [],
				writePaths: [join(projectDir, "build")],
				effects: ["destructive"],
			}),
		);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: build })).toMatchObject({
			kind: "deny",
			riskLevel: "high",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: build })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
			riskLevel: "high",
		});
		expect(policy.evaluate({ settings: settingsForPreset("ask"), action: build })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});

		const workspace = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: `rm -rf ${projectDir}` },
				command: `rm -rf ${projectDir}`,
				readPaths: [],
				writePaths: [projectDir],
				effects: ["destructive"],
			}),
		);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: workspace })).toMatchObject({
			kind: "deny",
			riskLevel: "high",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: workspace })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});
	});

	it("hard-denies protected-root shell scope even when an adapter omits the destructive effect", () => {
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "rm -rf /" },
				command: "rm -rf /",
				readPaths: [],
				writePaths: [parse(projectDir).root],
				effects: [],
			}),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("full"), action })).toMatchObject({
			kind: "deny",
			riskLevel: "critical",
		});
	});

	it("does not mistake ordinary workspace-scoped shell writes for recursive deletion", () => {
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "npm install" },
				command: "npm install",
				readPaths: [],
				writePaths: [projectDir],
				effects: [],
			}),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "allow",
			riskLevel: "low",
		});
	});

	it("reviews a workspace file delete instead of treating the write grant as recursive workspace deletion", () => {
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "rm file.txt" },
				command: "rm file.txt",
				readPaths: [],
				writePaths: [projectDir, join(projectDir, "file.txt")],
				effects: ["destructive"],
			}),
		);
		const policy = new PermissionPolicy();
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "review",
			riskLevel: "high",
			minimumReviewer: "user",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action })).toMatchObject({
			kind: "review",
			riskLevel: "high",
			minimumReviewer: "user",
		});
	});

	it("denies concatenated workspace recursive deletion in Auto and reviews it in Full", () => {
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "rm -rf . && python script.py" },
				command: "rm -rf . && python script.py",
				readPaths: [],
				writePaths: [projectDir],
				effects: ["destructive"],
			}),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "deny",
			riskLevel: "high",
		});
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("full"), action })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
			riskLevel: "high",
		});
	});

	it("reviews unknown scope in Auto and still fails closed for wildcard network grants", () => {
		const policy = new PermissionPolicy();
		const unknown = normalizePermissionAction(actionInput({ effects: ["unknown"] }));
		const wildcard = {
			...ordinaryRead(),
			networkEndpoints: [{ hostname: "*.example.com", port: 443 }],
		};
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: unknown })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
			riskLevel: "high",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: wildcard })).toMatchObject({
			kind: "deny",
			riskLevel: "critical",
		});
	});

	it("rejects objects that only claim to be normalized", () => {
		const forged = { ...ordinaryRead(), actionId: "forged" };
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("full"), action: forged })).toMatchObject({
			kind: "deny",
			riskLevel: "critical",
		});
	});

	it("never widens read-only or headless-deny ceilings", () => {
		const policy = new PermissionPolicy();
		const action = workspaceWrite();
		expect(
			policy.evaluate({ settings: { sandboxPolicy: "read-only", approvalPolicy: "auto-review" }, action }),
		).toMatchObject({ kind: "deny" });
		expect(
			policy.evaluate({ settings: { sandboxPolicy: "workspace-write", approvalPolicy: "deny" }, action }),
		).toMatchObject({ kind: "deny" });
		expect(
			policy.evaluate({ settings: { sandboxPolicy: "read-only", approvalPolicy: "deny" }, action: ordinaryRead() }),
		).toMatchObject({ kind: "allow" });
		const critical = normalizePermissionAction(actionInput({ effects: ["elevation"] }));
		expect(
			policy.evaluate({ settings: { sandboxPolicy: "workspace-write", approvalPolicy: "deny" }, action: critical }),
		).toMatchObject({ kind: "deny", riskLevel: "critical" });
	});

	it("fails closed when runtime settings bypass the typed constructors", () => {
		expect(
			new PermissionPolicy().evaluate({
				settings: { sandboxPolicy: "legacy-full", approvalPolicy: "automatic" } as never,
				action: workspaceWrite(),
			}),
		).toMatchObject({ kind: "deny", riskLevel: "critical" });
	});

	it("returns exact immutable grant data", () => {
		const action = workspaceWrite();
		const result = new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action });
		expect(result).toMatchObject({
			kind: "allow",
			grant: {
				executionTarget: "sandbox",
				writeRoots: action.writePaths,
				networkEndpoints: [],
			},
		});
		if (result.kind === "deny") throw new Error("Expected a grant");
		expect(Object.isFrozen(result.grant)).toBe(true);
		expect(Object.isFrozen(result.grant.writeRoots)).toBe(true);
		expect(result.grant.protectedRoots).toContain(canonicalizeActionPath(`${projectDir}/.git`, projectDir));
		for (const scope of [
			result.grant.readRoots,
			result.grant.writeRoots,
			result.grant.protectedRoots,
			result.grant.networkEndpoints,
		]) {
			expect(() => (scope as unknown[]).push("forged")).toThrow();
		}
	});

	it("classifies exact network and outside-workspace scope as medium risk", () => {
		const network = normalizePermissionAction(
			actionInput({ networkEndpoints: [{ hostname: "example.com", port: 443 }] }),
		);
		const grant = new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action: network });
		if (grant.kind === "deny") throw new Error("Expected a grant request");
		expect(riskLevelFor(network, grant.grant)).toBe("medium");
		expect(grant).toMatchObject({ kind: "review", minimumReviewer: "user" });
	});

	it("has no reviewer callback and stays below the domain latency budget", () => {
		const policy = new PermissionPolicy();
		const action = ordinaryRead();
		for (let index = 0; index < 1_000; index += 1) {
			policy.evaluate({ settings: settingsForPreset("auto"), action });
			digestPermissionAction(action);
		}

		const samples: number[] = [];
		const startedAt = performance.now();
		for (let index = 0; index < 10_000; index += 1) {
			const sampleStartedAt = performance.now();
			expect(policy.evaluate({ settings: settingsForPreset("auto"), action }).kind).toBe("allow");
			digestPermissionAction(action);
			samples.push(performance.now() - sampleStartedAt);
		}
		samples.sort((left, right) => left - right);
		const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
		console.info(`permission domain: 10k=${(performance.now() - startedAt).toFixed(1)}ms p95=${p95.toFixed(3)}ms`);
		expect(policy).not.toHaveProperty("review");
		expect(p95).toBeLessThan(5);
	});

	it("allows ordinary in-workspace file delivery under auto and still reviews sensitive sources", () => {
		const policy = new PermissionPolicy();
		const ordinary = normalizePermissionAction(
			actionInput({
				toolName: "deliver_file",
				toolIdentity: "builtin:deliver_file:v1",
				args: { path: join(projectDir, "report.md") },
				readPaths: [join(projectDir, "report.md")],
				effects: [],
			}),
		);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: ordinary }).kind).toBe("allow");

		const sensitive = normalizePermissionAction(
			actionInput({
				toolName: "deliver_file",
				toolIdentity: "builtin:deliver_file:v1",
				args: { path: join(projectDir, ".env") },
				readPaths: [join(projectDir, ".env")],
				effects: ["sensitive-read"],
			}),
		);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: sensitive })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});
	});

	const auto = { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" } as const;
	const ask = { sandboxPolicy: "workspace-write", approvalPolicy: "user" } as const;
	const lsRule = [{ command: "ls", allowNetwork: false }] as const;
	const policy = new PermissionPolicy();
	const bashAction = (overrides: Partial<NormalizePermissionActionInput>) =>
		normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: overrides.command },
				...overrides,
			}),
		);

	it("allows an allowlisted simple command outside the workspace in Auto", () => {
		const decision = policy.evaluate({
			settings: auto,
			action: bashAction({ command: "ls /tmp", readPaths: ["/tmp"] }),
			autoCommandRules: lsRule,
		});
		expect(decision.kind).toBe("allow");
	});

	it("does not apply an Auto rule in Ask mode", () => {
		const decision = policy.evaluate({
			settings: ask,
			action: bashAction({ command: "ls /tmp", readPaths: ["/tmp"] }),
			autoCommandRules: lsRule,
		});
		expect(decision).toMatchObject({ kind: "review", minimumReviewer: "user" });
	});

	it("does not match a different executable path", () => {
		const decision = policy.evaluate({
			settings: auto,
			action: bashAction({ command: "/tmp/ls", readPaths: ["/tmp"] }),
			autoCommandRules: lsRule,
		});
		expect(decision.kind).not.toBe("allow");
	});

	it.each([
		{ command: "ls > /tmp/list", effects: [] },
		{ command: "ls | cat", effects: [] },
		{ command: "echo $(cat file)", effects: ["unknown"] },
		{ command: "find /tmp -delete", effects: ["destructive"] },
		{ command: "cat ~/.ssh/id_rsa", effects: ["sensitive-read"] },
		{ command: "ls $TARGET", effects: ["unknown"] },
	] as const)("does not fast-path $command", ({ command, effects }) => {
		const decision = policy.evaluate({
			settings: auto,
			action: bashAction({ command, readPaths: ["/tmp"], effects }),
			autoCommandRules: [{ command: command.split(" ")[0]!, allowNetwork: false }],
		});
		expect(decision.kind).not.toBe("allow");
	});

	it("requires the per-rule network flag", () => {
		const networkAction = bashAction({
			command: "curl https://example.com",
			networkEndpoints: [{ hostname: "example.com", port: 443 }],
		});
		expect(
			policy.evaluate({
				settings: auto,
				action: networkAction,
				autoCommandRules: [{ command: "curl", allowNetwork: false }],
			}).kind,
		).toBe("review");
		expect(
			policy.evaluate({
				settings: auto,
				action: networkAction,
				autoCommandRules: [{ command: "curl", allowNetwork: true }],
			}).kind,
		).toBe("allow");
	});

	it("does not fast-path a known external mutation even with network enabled", () => {
		const decision = policy.evaluate({
			settings: auto,
			action: bashAction({
				command: "curl -X DELETE https://example.com/item",
				networkEndpoints: [{ hostname: "example.com", port: 443 }],
				effects: ["external-side-effect"],
			}),
			autoCommandRules: [{ command: "curl", allowNetwork: true }],
		});
		expect(decision.kind).not.toBe("allow");
	});

	it("hard-denies recursive deletion even with a matching Auto rule", () => {
		const action = bashAction({
			command: "rm -rf /",
			readPaths: [],
			writePaths: [parse(projectDir).root],
			effects: ["destructive"],
		});
		expect(
			policy.evaluate({
				settings: auto,
				action,
				autoCommandRules: [{ command: "rm", allowNetwork: false }],
			}),
		).toMatchObject({ kind: "deny", riskLevel: "critical" });
	});

	it("imports without loading model, interaction, or execution adapters", async () => {
		vi.resetModules();
		vi.doMock("../../src/core/model-registry.ts", () => {
			throw new Error("model adapter loaded");
		});
		vi.doMock("../../src/modes/interactive/interactive-mode.ts", () => {
			throw new Error("interaction adapter loaded");
		});
		vi.doMock("../../src/core/workspace-sandbox.ts", () => {
			throw new Error("execution adapter loaded");
		});
		const domain = await import("../../src/core/permissions/index.ts");
		expect(domain.PermissionPolicy).toBeTypeOf("function");
		vi.doUnmock("../../src/core/model-registry.ts");
		vi.doUnmock("../../src/modes/interactive/interactive-mode.ts");
		vi.doUnmock("../../src/core/workspace-sandbox.ts");
	});
});
