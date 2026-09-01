import { createServer, type IncomingMessage, type Server } from "node:http";
import {
	closeServer,
	listen,
	messageText,
	readOpenAiChatRequest,
	respondWithText,
	respondWithToolCall,
	writeOfflineProviderConfig,
} from "../packaged-app-harness.ts";

export const MODEL_REVIEW_PROMPT_MARKER = "You are an isolated permission reviewer.";

export interface PermissionToolCall {
	readonly name: string;
	readonly arguments: object;
}

export interface PermissionProviderCall {
	readonly kind: "primary" | "review" | "title";
	readonly model: string | undefined;
	readonly thinking: unknown;
	readonly tools: unknown;
	readonly hasRawSecret: boolean;
}

export type ReviewDecision = {
	readonly decision: "allow" | "deny";
	readonly assessedRisk: "low" | "medium" | "high" | "critical";
	readonly userAuthorization: "unknown" | "low" | "medium" | "high";
	readonly scopeComplete: boolean;
	readonly rationale: string;
};

export type ReviewMode = "json" | "malformed" | "extra-keys" | "trailing-text" | "timeout" | "abort";

const DEFAULT_DENY: ReviewDecision = {
	decision: "deny",
	assessedRisk: "medium",
	userAuthorization: "unknown",
	scopeComplete: true,
	rationale: "Fixture denied the reviewed action.",
};

function reviewJson(decision: ReviewDecision): string {
	return JSON.stringify(decision);
}

export class PermissionProvider {
	readonly calls: PermissionProviderCall[] = [];
	reviewMode: ReviewMode = "json";
	reviewDelayMs = 0;
	private readonly server: Server;
	private readonly tools: (marker: string) => PermissionToolCall | undefined;
	private readonly decide: (payload: string) => ReviewDecision;
	private closed = false;

	constructor(options: {
		readonly tools: (marker: string) => PermissionToolCall | undefined;
		readonly decide?: (payload: string) => ReviewDecision;
	}) {
		this.tools = options.tools;
		this.decide = options.decide ?? (() => DEFAULT_DENY);
		this.server = createServer((request, response) => {
			void this.handle(request, response);
		});
	}

	get reviewCount(): number {
		return this.calls.filter((call) => call.kind === "review").length;
	}

	get primaryCount(): number {
		return this.calls.filter((call) => call.kind === "primary").length;
	}

	async listen(): Promise<number> {
		return listen(this.server);
	}

	async writeAgentConfig(agentDir: string, port: number): Promise<void> {
		await writeOfflineProviderConfig(agentDir, port);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await closeServer(this.server);
	}

	private async handle(request: IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const payload = await readOpenAiChatRequest(request);
		const body = payload as OpenAiChatBody;
		const transcript = JSON.stringify(payload);
		const hasRawSecret = /super-secret-token|sk-live-|BEGIN PRIVATE KEY/u.test(transcript);
		const lastUser = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user");
		const lastUserText = messageText(lastUser?.content ?? "");
		const record = (kind: PermissionProviderCall["kind"]): void => {
			this.calls.push({
				kind,
				model: body.model,
				thinking: body.reasoning_effort ?? body.thinking ?? body.reasoning,
				tools: body.tools,
				hasRawSecret,
			});
		};

		if (transcript.includes("conversation title generator")) {
			record("title");
			respondWithText(response, "Permission test");
			return;
		}

		if (this.isReviewRequest(transcript, body.tools, lastUserText)) {
			record("review");
			if (this.reviewMode === "abort") {
				response.destroy();
				return;
			}
			if (this.reviewMode === "timeout") {
				return;
			}
			if (this.reviewDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, this.reviewDelayMs));
			}
			if (this.reviewMode === "malformed") {
				respondWithText(response, "not-json");
				return;
			}
			const decision = this.decide(lastUserText);
			if (this.reviewMode === "extra-keys") {
				respondWithText(response, JSON.stringify({ ...decision, extra: true }));
				return;
			}
			if (this.reviewMode === "trailing-text") {
				respondWithText(response, `${reviewJson(decision)}\nnote`);
				return;
			}
			respondWithText(response, reviewJson(decision));
			return;
		}

		record("primary");
		const last = payload.messages?.at(-1);
		const marker = lastUserText.match(/case-[a-z0-9-]+/u)?.[0] ?? "plain";
		if (last?.role === "tool") {
			respondWithText(response, `done:${marker}`);
			return;
		}
		const tool = this.tools(lastUserText);
		if (tool) {
			respondWithToolCall(response, {
				callId: `call-${this.calls.length}-${marker}`,
				name: tool.name,
				arguments: tool.arguments,
			});
			return;
		}
		respondWithText(response, `done:${marker}`);
	}

	private isReviewRequest(transcript: string, tools: unknown, lastUserText: string): boolean {
		if (transcript.includes(MODEL_REVIEW_PROMPT_MARKER)) return true;
		if (transcript.includes("minimumReviewer") && transcript.includes("redactedArguments")) return true;
		if (Array.isArray(tools) && tools.length === 0 && transcript.includes("schemaVersion")) return true;
		const trimmed = lastUserText.trim();
		if (!trimmed.startsWith("{")) return false;
		try {
			return (JSON.parse(trimmed) as { schemaVersion?: unknown }).schemaVersion === 1;
		} catch {
			return false;
		}
	}
}

interface OpenAiChatBody {
	readonly model?: string;
	readonly tools?: unknown;
	readonly reasoning_effort?: unknown;
	readonly thinking?: unknown;
	readonly reasoning?: unknown;
}
