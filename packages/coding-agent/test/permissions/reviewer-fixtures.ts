import type { PermissionReviewRequest, TrustedUserMessage } from "../../src/core/permissions/index.ts";
import { workspaceWrite } from "./fixtures.ts";

export function directUserMessage(index: number): TrustedUserMessage {
	return { messageId: `user-${index}`, text: `Please perform exact action ${index}` };
}

export function reviewInput(overrides: Partial<PermissionReviewRequest> = {}): PermissionReviewRequest {
	const action = workspaceWrite();
	return {
		action,
		decision: {
			kind: "review",
			riskLevel: "medium",
			minimumReviewer: "model",
			reason: "Outside deterministic safe set",
			grant: {
				executionTarget: "sandbox",
				readRoots: action.readPaths,
				writeRoots: action.writePaths,
				protectedRoots: [],
				networkEndpoints: [],
			},
		},
		trustedUserMessages: [directUserMessage(0)],
		redactedArguments: { path: action.writePaths[0] },
		interactive: true,
		signal: new AbortController().signal,
		...overrides,
	};
}

export const request = () => reviewInput();

export function validJson(
	overrides: Partial<{
		decision: "allow" | "deny";
		assessedRisk: "low" | "medium" | "high" | "critical";
		userAuthorization: "unknown" | "low" | "medium" | "high";
		scopeComplete: boolean;
		rationale: string;
	}> = {},
): string {
	return JSON.stringify({
		decision: "allow",
		assessedRisk: "medium",
		userAuthorization: "medium",
		scopeComplete: true,
		rationale: "The direct user message authorizes this exact action.",
		...overrides,
	});
}
