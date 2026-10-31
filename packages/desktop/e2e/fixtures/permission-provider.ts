import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
	readonly toolChoice: unknown;
	readonly maxTokens: unknown;
	/** Serialized request payload, used only for protocol/redaction assertions. */
	readonly payload: string;
	readonly hasRawSecret: boolean;
}

/** Independent Auto approval model seeded into the temporary agent settings. */
export interface PermissionReviewerSeed {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
	readonly enabled: boolean;
}

export interface PermissionAgentConfigOptions {
	readonly providerId?: string;
	readonly modelId?: string;
	readonly reviewer?: PermissionReviewerSeed;
	readonly extraSettings?: Record<string, unknown>;
}

export const DEFAULT_REVIEWER_PROVIDER = "permission-reviewer";
export const DEFAULT_REVIEWER_MODEL = "reviewer-model";

/** Final verdict contract of the review result tool: allow or deny, nothing else. */
export type ReviewDecision = {
	readonly decision: "allow" | "deny";
};

export type ReviewMode = "json" | "malformed" | "extra-keys" | "trailing-text" | "timeout" | "abort";

const DEFAULT_DENY: ReviewDecision = { decision: "deny" };

function reviewJson(decision: ReviewDecision): string {
	return JSON.stringify(decision);
}

async function mergeSettings(agentDir: string, extra: Record<string, unknown>): Promise<void> {
	const file = path.join(agentDir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
	} catch {
		current = {};
	}
	await writeFile(file, JSON.stringify({ ...current, ...extra }));
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

	get reviewCalls(): readonly PermissionProviderCall[] {
		return this.calls.filter((call) => call.kind === "review");
	}

	async listen(): Promise<number> {
		return listen(this.server);
	}

	/**
	 * Seed the temporary agent directory. The reviewer provider is a distinct
	 * provider/model unless the caller deliberately reuses one; tests assert the
	 * request model rather than treating this fixture as a real model.
	 */
	async writeAgentConfig(agentDir: string, port: number, options: PermissionAgentConfigOptions = {}): Promise<void> {
		const reviewer = options.reviewer;
		if (!reviewer) {
			await writeOfflineProviderConfig(agentDir, port, {
				providerId: options.providerId,
				modelId: options.modelId,
			});
			if (options.extraSettings) await mergeSettings(agentDir, options.extraSettings);
			return;
		}
		const baseUrl = `http://127.0.0.1:${port}/v1`;
		const providers = {
			[options.providerId ?? "permission"]: {
				baseUrl,
				apiKey: "permission-key",
				api: "openai-completions",
				models: [
					{
						id: options.modelId ?? "permission-model",
						name: "Permission Model",
						contextWindow: 128_000,
						maxTokens: 4_096,
						reasoning: true,
					},
				],
			},
			[reviewer.provider]: {
				baseUrl,
				apiKey: "reviewer-key",
				api: "openai-completions",
				models: [
					{
						id: reviewer.modelId,
						name: "Reviewer Model",
						contextWindow: 128_000,
						maxTokens: 4_096,
						reasoning: reviewer.thinkingLevel !== "off",
					},
				],
			},
		};
		await Promise.all([
			writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers })),
			writeFile(
				path.join(agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: options.providerId ?? "permission",
					defaultModel: options.modelId ?? "permission-model",
					retry: { enabled: false },
					autoReviewerEnabled: reviewer.enabled,
					permissionReviewer: {
						provider: reviewer.provider,
						modelId: reviewer.modelId,
						thinkingLevel: reviewer.thinkingLevel,
						timeoutMs: reviewer.timeoutMs,
						maxOutputTokens: reviewer.maxOutputTokens,
					},
					...(options.extraSettings ?? {}),
				}),
			),
		]);
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
				toolChoice: body.tool_choice,
				maxTokens: body.max_tokens ?? body.max_completion_tokens,
				payload: transcript,
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
			respondWithToolCall(response, {
				callId: `review-${this.calls.length}`,
				name: "submit_permission_review",
				arguments: { decision: decision.decision },
			});
			return;
		}

		record("primary");
		const last = payload.messages?.at(-1);
		const marker = lastUserText.match(/case-[a-z0-9-]+/u)?.[0] ?? "plain";
		const completionMarker = lastUserText.match(/case-[^\r\n]*/u)?.[0]?.trim() ?? "plain";
		if (last?.role === "tool") {
			respondWithText(response, `done:${completionMarker}`);
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
		respondWithText(response, `done:${completionMarker}`);
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
	readonly tool_choice?: unknown;
	readonly max_tokens?: unknown;
	readonly max_completion_tokens?: unknown;
	readonly reasoning_effort?: unknown;
	readonly thinking?: unknown;
	readonly reasoning?: unknown;
}
