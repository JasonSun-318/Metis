/**
 * Offline AgentSession harness for prompt-cache lifecycle tests.
 *
 * Creates a real AgentSession (real session journal, real settings, real tools)
 * wired to a fake stream function that captures the provider Context. Tests
 * drive real `session.prompt()` runs and inspect both the durable journal and
 * the exact request context the provider would have seen.
 */

import { join } from "node:path";
import { Agent } from "@metis/agent-core";
import type { Context, Model } from "@metis/ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@metis/ai";
import { getModel } from "@metis/ai/compat";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

export interface CacheSessionFixture {
	readonly session: AgentSession;
	readonly agent: Agent;
	readonly manager: SessionManager;
	readonly settings: SettingsManager;
	readonly auth: AuthStorage;
	/** JSON-deep copies of each Context passed to the fake provider stream. */
	readonly captured: Context[];
	readonly close: () => void;
}

export interface CacheSessionOptions {
	readonly contextWindow?: number;
	readonly configureAgent?: (agent: Agent) => void;
}

export function createCacheSession(root: string, options?: CacheSessionOptions): CacheSessionFixture {
	const model = getModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
	if (options?.contextWindow) model.contextWindow = options.contextWindow;
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: "Test",
			tools: createCodingTools(root),
		},
		getApiKey: () => "test-key",
		// Match the production Agent wiring (sdk.ts) so custom messages such as
		// agent_mailbox deliveries convert to provider-visible user messages.
		convertToLlm,
	});
	options?.configureAgent?.(agent);
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.setPermissionPreset("full");
	const settings = SettingsManager.create(root, root);
	const auth = AuthStorage.create(join(root, "auth.json"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: settings,
		cwd: root,
		modelRegistry: ModelRegistry.create(auth, root),
		resourceLoader: createTestResourceLoader(),
	});
	const captured: Context[] = [];
	agent.streamFn = (requestModel, context) => {
		// JSON clone keeps the request data tests assert on (incl. cacheHints);
		// tool execute callbacks are not part of the wire view anyway.
		captured.push(JSON.parse(JSON.stringify(context)) as Context);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = {
				...fauxAssistantMessage("done"),
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			};
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		});
		return stream;
	};
	session.subscribe(() => {});
	return {
		session,
		agent,
		manager,
		settings,
		auth,
		captured,
		close: () => {
			session.dispose();
			manager.close();
		},
	};
}
