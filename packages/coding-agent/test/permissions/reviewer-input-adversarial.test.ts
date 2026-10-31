import { describe, expect, it } from "vitest";
import { normalizePermissionAction } from "../../src/core/permissions/normalize.ts";
import { buildModelReviewInput, redactPermissionCommand } from "../../src/core/permissions/reviewer-input.ts";
import { actionInput } from "./fixtures.ts";
import { reviewInput } from "./reviewer-fixtures.ts";

const requestFor = (command: string) => {
	const action = normalizePermissionAction(
		actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			command,
			args: { command },
			writePaths: [],
			effects: [],
		}),
	);
	return reviewInput({
		action,
		redactedArguments: { command },
		decision: {
			...reviewInput().decision,
			grant: {
				executionTarget: "sandbox",
				readRoots: action.readPaths,
				writeRoots: [],
				protectedRoots: [],
				networkEndpoints: [],
			},
		},
	});
};

describe("independent reviewer secret redaction", () => {
	it.each(["TOKEN", "SECRET", "PASSWORD", "API_KEY", "MY_API_TOKEN"])("redacts an exact %s assignment", (name) => {
		const serialized = JSON.stringify(
			buildModelReviewInput(requestFor(`${name}=fixture-sensitive-value cat README.md`)),
		);
		expect(serialized).not.toContain("fixture-sensitive-value");
		expect(serialized).toContain("README.md");
	});

	it("redacts URL credentials while preserving the target hostname", () => {
		const serialized = JSON.stringify(
			buildModelReviewInput(requestFor("curl -q https://fixture-user:fixture-sensitive-value@example.test/data")),
		);
		expect(serialized).not.toContain("fixture-sensitive-value");
		expect(serialized).toContain("example.test/data");
	});

	it("redacts known credentials in the bounded user intent as well as the command", () => {
		const request = requestFor("cat README.md");
		const serialized = JSON.stringify(
			buildModelReviewInput({
				...request,
				trustedUserMessages: [
					{ messageId: "user-intent", text: "Use API_TOKEN=fixture-sensitive-value and read the documentation." },
				],
			}),
		);
		expect(serialized).not.toContain("fixture-sensitive-value");
		expect(serialized).toContain("read the documentation");
	});
	it("does not hide a following operation while redacting an unquoted header", () => {
		const input = buildModelReviewInput(
			requestFor("curl -q -H Authorization:Bearer-fixture https://example.test; printf tail-marker"),
		);
		expect(input.action.command).toContain("; printf tail-marker");
		expect(input.action.command).not.toContain("Bearer-fixture");
	});
	it("redacts quoted cookies without hiding the following operation", () => {
		const input = buildModelReviewInput(
			requestFor(
				"curl -q -H 'Cookie: a=fixture-sensitive-value; b=second-secret' https://example.test && printf tail-marker",
			),
		);
		expect(input.action.command).toContain("&& printf tail-marker");
		expect(input.action.command).not.toContain("fixture-sensitive-value");
		expect(input.action.command).not.toContain("second-secret");
	});
});

describe("encoded literal credential boundaries", () => {
	it.each([
		String.raw`curl --json "{\"api_key\":\"nested-secret\"}" https://example.test && rm -rf /`,
		String.raw`curl --json "{\"password\":\"quote\\\"nested-secret\"}" https://example.test ; rm -rf /`,
		`python3 -c 'print({"token": "nested-secret"})' && rm -rf /`,
	])("redacts encoded credentials without hiding the command tail", (command) => {
		const redacted = redactPermissionCommand(command);
		expect(redacted).not.toContain("nested-secret");
		expect(redacted).toContain("<redacted>");
		expect(redacted).toContain("rm -rf /");
	});
});

it("redacts credential query values idempotently while preserving URL scope and shell tails", () => {
	const command = "curl 'https://api.example.test/path?api%5Fkey=url-secret&count=1' && rm -rf /";
	const redacted = redactPermissionCommand(command);
	expect(redacted).not.toContain("url-secret");
	expect(redacted).toContain("https://api.example.test/path?api%5Fkey=<redacted>&count=1");
	expect(redacted).toContain("&& rm -rf /");
	expect(redactPermissionCommand(redacted)).toBe(redacted);
});
