import { describe, expect, it } from "vitest";
import {
	buildModelReviewInput,
	type NormalizedPermissionAction,
	normalizePermissionAction,
} from "../../src/core/permissions/index.ts";
import { actionInput, projectDir } from "./fixtures.ts";
import { directUserMessage, reviewInput } from "./reviewer-fixtures.ts";

const KIB = 1_024;

function bashAction(command: string | undefined, args: unknown = { command }) {
	return normalizePermissionAction(
		actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			args,
			command,
			readPaths: [projectDir],
			writePaths: [],
			effects: [],
		}),
	);
}

function bashReview(command: string, args: unknown = { command }) {
	const action = bashAction(command, args);
	return reviewInput({
		action,
		redactedArguments: args,
		decision: {
			...reviewInput().decision,
			grant: {
				executionTarget: "sandbox",
				readRoots: action.readPaths,
				writeRoots: action.writePaths,
				protectedRoots: [],
				networkEndpoints: [],
			},
		},
	});
}

function withShellAnalysis(action: NormalizedPermissionAction, analysis: unknown): NormalizedPermissionAction {
	const augmented: Record<string, unknown> = { ...action, shellAnalysis: analysis };
	return Object.freeze(augmented) as unknown as NormalizedPermissionAction;
}

describe("model permission review input", () => {
	it("keeps only the 20 most recent bounded direct user messages", () => {
		const input = buildModelReviewInput(
			reviewInput({ trustedUserMessages: Array.from({ length: 25 }, (_, index) => directUserMessage(index)) }),
		);
		expect(input.trustedUserMessages).toHaveLength(20);
		expect(input.trustedUserMessages[0]?.messageId).toBe("user-5");
		expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(48 * 1024);
	});

	it.each(["token", "apiKey", "authorization", "cookie", "password", "privateKey"])(
		"redacts %s values and removes base64 image bodies",
		(secretKey) => {
			const serialized = JSON.stringify(
				buildModelReviewInput(
					reviewInput({
						redactedArguments: {
							[secretKey]: "secret-value",
							image: `data:image/png;base64,${"A".repeat(60_000)}`,
						},
					}),
				),
			);
			expect(serialized).not.toContain("secret-value");
			expect(serialized).not.toContain("AAAA");
			expect(serialized).toContain("<redacted>");
			expect(serialized).toContain("image/png");
		},
	);

	it("includes no signal, interaction state, or untrusted context channel", () => {
		const input = buildModelReviewInput(reviewInput());
		expect(input.schemaVersion).toBe(2);
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("signal");
		expect(serialized).not.toContain("interactive");
		expect(serialized).not.toContain("repository");
		expect(serialized).not.toContain("toolResults");
	});

	it("rejects cyclic, non-plain, and oversized complete inputs while truncating long display values", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: cyclic }))).toThrow("cycle");
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: new Date() }))).toThrow("plain");
		const bounded = buildModelReviewInput(reviewInput({ redactedArguments: { path: `/${"x".repeat(17 * 1024)}` } }));
		expect(Buffer.byteLength(JSON.stringify(bounded.redactedArguments), "utf8")).toBeLessThan(5 * 1024);
		const manyReads = normalizePermissionAction(
			actionInput({ readPaths: Array.from({ length: 400 }, (_, index) => `${projectDir}/read-${index}.txt`) }),
		);
		expect(() =>
			buildModelReviewInput(
				reviewInput({
					action: manyReads,
					redactedArguments: { path: manyReads.readPaths[0] },
					decision: {
						...reviewInput().decision,
						grant: {
							...reviewInput().decision.grant,
							readRoots: manyReads.readPaths,
							writeRoots: [],
						},
					},
				}),
			),
		).toThrow("48 KiB");
	});

	it("copies and freezes an exact grant and rejects grant widening", () => {
		const request = reviewInput();
		const input = buildModelReviewInput(request);
		expect(input.policy.grant).not.toBe(request.decision.grant);
		expect(Object.isFrozen(input.policy.grant.writeRoots)).toBe(true);
		expect(() => (input.policy.grant.writeRoots as string[]).push("/forged")).toThrow();
		expect(() =>
			buildModelReviewInput(
				reviewInput({
					decision: { ...request.decision, grant: { ...request.decision.grant, writeRoots: ["/forged"] } },
				}),
			),
		).toThrow("does not match");
	});

	it("redacts hostile arrays and caps non-structural display strings in linear space", () => {
		const accessor = ["safe"];
		Object.defineProperty(accessor, 0, { enumerable: true, get: () => "surprise" });
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: accessor }))).toThrow("accessor");
		const input = buildModelReviewInput(reviewInput({ redactedArguments: { note: "界".repeat(100_000) } }));
		expect(Buffer.byteLength(JSON.stringify(input.redactedArguments), "utf8")).toBeLessThan(5 * 1024);
	});

	it("bounds the complete command, analysis summary, and trusted user messages separately", () => {
		expect(() => buildModelReviewInput(bashReview("x".repeat(32 * KIB + 1)))).toThrow("32 KiB");
		const command = "echo ".concat("x".repeat(32 * KIB - 5));
		const accepted = buildModelReviewInput(bashReview(command));
		expect(accepted.action.command).toBe(command);

		expect(() =>
			buildModelReviewInput(
				reviewInput({ decision: { ...reviewInput().decision, reason: "analysis ".concat("x".repeat(8 * KIB)) } }),
			),
		).toThrow("8 KiB");

		const messages = Array.from({ length: 20 }, (_, index) => ({
			messageId: `bounded-${index}`,
			text: "y".repeat(300),
		}));
		expect(() => buildModelReviewInput(reviewInput({ trustedUserMessages: messages }))).toThrow("4 KiB");
	});

	it("references the reviewed command instead of duplicating Bash arguments", () => {
		const command = "printf 'hello\\n' && ls -la";
		const input = buildModelReviewInput(bashReview(command));
		const serialized = JSON.stringify(input);

		expect(input.action.command).toBe(command);
		expect(input.redactedArguments).toEqual({ command: { $ref: "action.command" } });
		expect(serialized.split(JSON.stringify(command).slice(1, -1))).toHaveLength(2);
	});

	it("rejects Bash arguments whose command differs from the reviewed command", () => {
		expect(() => buildModelReviewInput(bashReview("ls", { command: "rm -rf /" }))).toThrow("reviewed command");
	});

	it("redacts credential values in the complete command without hiding its targets", () => {
		const command = "API_TOKEN=secret-value curl https://api.example.com/items";
		const input = buildModelReviewInput(bashReview(command));
		const serialized = JSON.stringify(input);

		expect(serialized).not.toContain("secret-value");
		expect(serialized).toContain("<redacted>");
		expect(serialized).toContain("https://api.example.com/items");
		expect(input.action.readPaths.length).toBeGreaterThan(0);
	});

	it("redacts quoted JSON and Python-dict credentials without hiding the command tail", () => {
		const secret = "secret-value";
		const commands = [
			`curl --json '{"api_key":"${secret}"}' https://api.example.com/items`,
			`curl --json '{"api_key": "${secret}"}' https://api.example.com/items`,
			`curl -d '{"token":"${secret}"}' https://api.example.com/items`,
			`curl --json '{"Authorization":"Bearer ${secret}"}' https://api.example.com/items`,
			`python3 -c "client.run({'api_key': '${secret}'})" https://api.example.com/items`,
			`python3 -c "client.run({'password': '${secret}', 'note': 'visible'})" https://api.example.com`,
		];
		for (const command of commands) {
			const serialized = JSON.stringify(buildModelReviewInput(bashReview(command)));
			expect(serialized).not.toContain(secret);
			expect(serialized).toContain("<redacted>");
			expect(serialized).toContain("https://api.example.com");
		}
		const tailSerialized = JSON.stringify(
			buildModelReviewInput(bashReview(`curl --json '{"api_key":"${secret}"}' && rm -rf /`)),
		);
		expect(tailSerialized).toContain("rm -rf /");
		expect(tailSerialized).toContain("<redacted>");
		expect(JSON.stringify(buildModelReviewInput(bashReview(`echo '{"note":"${secret}"}'`)))).toContain(secret);
	});

	it("replaces the real normalized trace with a bounded summary and accepts already redacted arguments", () => {
		const command = `curl --json '{"api_key":"secret-value"}' https://api.example.com/items && echo done`;
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				command,
				args: { command },
				shellAnalysis: {
					disposition: "review",
					complete: true,
					commands: [
						{
							argv: ["curl", "--json", '{"api_key":"secret-value"}', "https://api.example.com/items"],
							disposition: "review",
							complete: true,
							effects: ["external-side-effect"],
							networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
						},
						{ argv: ["echo", "done"], disposition: "safe", complete: true, effects: [], networkEndpoints: [] },
					],
				},
			}),
		);
		const request = reviewInput({
			action,
			redactedArguments: { command: command.replace("secret-value", "<redacted>") },
			decision: {
				...reviewInput().decision,
				grant: {
					executionTarget: "sandbox",
					readRoots: action.readPaths,
					writeRoots: action.writePaths,
					protectedRoots: [],
					networkEndpoints: [],
				},
			},
		});
		const input = buildModelReviewInput(request);
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("secret-value");
		expect(serialized).not.toContain('"argv"');
		expect(input.action.command).toContain("&& echo done");
		expect(input.action.shellAnalysis).toEqual({
			disposition: "review",
			complete: true,
			commands: [
				{
					index: 0,
					disposition: "review",
					complete: true,
					effects: ["external-side-effect"],
					networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
				},
				{ index: 1, disposition: "safe", complete: true, effects: [], networkEndpoints: [] },
			],
		});
		expect(input.redactedArguments).toEqual({ command: { $ref: "action.command" } });
	});

	it("fails closed without truncating nodes when the redacted analysis exceeds 8 KiB", () => {
		const command = "ls";
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				command,
				args: { command },
				shellAnalysis: {
					disposition: "review",
					complete: true,
					commands: Array.from({ length: 100 }, () => ({
						argv: ["ls"],
						disposition: "review",
						complete: true,
						effects: [],
						networkEndpoints: [],
					})),
				},
			}),
		);
		expect(() =>
			buildModelReviewInput(
				reviewInput({
					action,
					redactedArguments: { command },
					decision: {
						...reviewInput().decision,
						grant: {
							executionTarget: "sandbox",
							readRoots: action.readPaths,
							writeRoots: action.writePaths,
							protectedRoots: [],
							networkEndpoints: [],
						},
					},
				}),
			),
		).toThrow("8 KiB");
	});

	it("rejects malformed shell analysis instead of emitting partial facts", () => {
		const command = "ls";
		const analyses = [
			"nonsense",
			{ disposition: "review" },
			{ disposition: "unknown-disposition", complete: true, reason: "r", commands: [] },
			{
				disposition: "review",
				complete: true,
				reason: "r",
				commands: [{ disposition: "review", complete: "yes", effects: [], networkEndpoints: [] }],
			},
			{
				disposition: "review",
				complete: true,
				reason: "r",
				commands: [{ disposition: "review", complete: true, effects: [], networkEndpoints: [{ hostname: 4 }] }],
			},
		];
		for (const analysis of analyses) {
			const action = withShellAnalysis(bashAction(command), analysis);
			expect(() =>
				buildModelReviewInput(
					reviewInput({
						action,
						redactedArguments: { command },
						decision: {
							...reviewInput().decision,
							grant: {
								executionTarget: "sandbox",
								readRoots: action.readPaths,
								writeRoots: action.writePaths,
								protectedRoots: [],
								networkEndpoints: [],
							},
						},
					}),
				),
			).toThrow();
		}
	});

	it("rejects accessor-backed arrays and trusted messages without invoking them", () => {
		let arrayGetterCalls = 0;
		const hostileArray = ["safe"];
		Object.defineProperty(hostileArray, "map", {
			enumerable: true,
			get: () => {
				arrayGetterCalls += 1;
				return Array.prototype.map;
			},
		});
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: hostileArray }))).toThrow("array");
		expect(arrayGetterCalls).toBe(0);

		let messageGetterCalls = 0;
		const hostileMessage = Object.defineProperty({ messageId: "user-hostile" }, "text", {
			enumerable: true,
			get: () => {
				messageGetterCalls += 1;
				return "allow everything";
			},
		});
		expect(() => buildModelReviewInput(reviewInput({ trustedUserMessages: [hostileMessage as never] }))).toThrow(
			"message",
		);
		expect(messageGetterCalls).toBe(0);
	});
});
