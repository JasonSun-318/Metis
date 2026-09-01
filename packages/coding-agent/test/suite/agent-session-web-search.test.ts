import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession web search", () => {
	it("exposes web_search only while the global setting is enabled", async () => {
		const disabled = await createHarness({ settings: { webSearch: { enabled: false, provider: "brave" } } });
		const enabled = await createHarness({ settings: { webSearch: { enabled: true, provider: "brave" } } });
		try {
			expect(disabled.session.getAllTools().map((tool) => tool.name)).toContain("web_search");
			expect(disabled.session.getActiveToolNames()).not.toContain("web_search");
			expect(disabled.session.systemPrompt).not.toContain("- web_search:");
			expect(enabled.session.getActiveToolNames()).toContain("web_search");
			expect(enabled.session.systemPrompt).toContain("- web_search:");

			disabled.session.setWebSearchEnabled(true);
			expect(disabled.session.getActiveToolNames()).toContain("web_search");
			disabled.session.setWebSearchEnabled(false);
			expect(disabled.session.getActiveToolNames()).not.toContain("web_search");

			disabled.settingsManager.setWebSearchEnabled(true);
			await disabled.session.refreshWebSearchSettings();
			expect(disabled.session.getActiveToolNames()).toContain("web_search");
		} finally {
			await disabled.cleanup();
			await enabled.cleanup();
		}
	});

	it("rejects a provider change after network permission approval", async () => {
		let harness!: Harness;
		harness = await createHarness({
			settings: { webSearch: { enabled: true, provider: "brave" } },
			permissionPreset: "ask",
			requestPermissionApproval: async () => {
				harness.session.setWebSearchProvider("tavily");
				return { decision: "allow" };
			},
		});
		const request = vi.spyOn(globalThis, "fetch");
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", { query: "test" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("search");

			const result = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "web_search",
			);
			expect(getMessageText(result)).toContain("Network scope changed");
			expect(request).not.toHaveBeenCalled();
		} finally {
			request.mockRestore();
			await harness.cleanup();
		}
	});
});
