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
