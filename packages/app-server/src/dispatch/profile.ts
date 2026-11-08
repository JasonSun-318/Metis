import type { ClientRpcRequest } from "@metis/app-protocol";
import type { ProfileSummaryCache } from "../profile-summary.ts";
import type { SessionRef } from "../session-runtime-host.ts";

export interface ProfileDispatchContext {
	readonly profileSummary: ProfileSummaryCache;
	allSessionRefs(): readonly SessionRef[];
}

export function isProfileRequest(request: ClientRpcRequest): boolean {
	return request.method === "profile/get" || request.method === "usage/get";
}

export async function dispatchProfileRequest(
	request: ClientRpcRequest,
	context: ProfileDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "profile/get":
			return context.profileSummary.summarize(context.allSessionRefs());
		case "usage/get":
			return context.profileSummary.usage(context.allSessionRefs(), request.params.rangeDays);
		default:
			throw new Error(`Unhandled profile request: ${request.method}`);
	}
}
