import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { registerFauxProvider } from "@metis/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { permissionClaim, permissionDescriptor } from "../src/core/tool-permission-adapter.ts";
import { type CacheSessionFixture, createCacheSession } from "./cache-session-fixtures.ts";

describe("prompt-cache configuration stability", () => {
	let root: string;
	let fixture: CacheSessionFixture | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-cache-config-"));
	});
	afterEach(() => {
		fixture?.close();
		fixture = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps unchanged system and tools stable across a refresh", async () => {
		const h = createCacheSession(root);
		fixture = h;
		await h.session.prompt("first");
		const first = h.session.agent.state.systemPrompt;
		h.session.refreshSystemPrompt();
		expect(h.session.agent.state.systemPrompt).toBe(first);
		await h.session.prompt("second");
		expect(h.captured[0]!.tools).toEqual(h.captured[1]!.tools);
	});

	it("re-renders the request tools when the tool set actually changes", async () => {
		const h = createCacheSession(root);
		fixture = h;
		await h.session.prompt("first");
		h.session.installHostTools([
			{
				name: "host_extra",
				label: "host_extra",
				description: "extra host tool",
				parameters: Type.Object({}),
				permission: permissionDescriptor(() => permissionClaim()),
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
			},
		]);
		await h.session.prompt("second");
		expect(h.captured).toHaveLength(2);
		const secondToolNames = (h.captured[1]!.tools ?? []).map((tool) => tool.name);
		expect(secondToolNames).toContain("host_extra");
		expect(h.captured[1]!.tools).not.toEqual(h.captured[0]!.tools);
	});

	it("denies a write mid-run after the permission preset is revoked", async () => {
		const h = createCacheSession(root);
		fixture = h;
		const allowedPath = join(root, "allowed.txt");
		const deniedPath = join(root, "denied.txt");
		let call = 0;
		h.agent.streamFn = (requestModel, _context) => {
			call += 1;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (call === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: fauxAssistantMessage(
							[fauxToolCall("write", { path: allowedPath, content: "a" }, { id: "call-allow" })],
							{ stopReason: "toolUse" },
						),
					});
				} else if (call === 2) {
					// Revoke while the run is still in flight: the next tool call must be
					// evaluated against the new settings, not a stale snapshot.
					h.manager.setPermissionPreset("ask");
					stream.push({
						type: "done",
						reason: "toolUse",
						message: fauxAssistantMessage(
							[fauxToolCall("write", { path: deniedPath, content: "b" }, { id: "call-deny" })],
							{ stopReason: "toolUse" },
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("done"),
							api: requestModel.api,
							provider: requestModel.provider,
							model: requestModel.id,
						},
					});
				}
				stream.end();
			});
			return stream;
		};

		await h.session.prompt("run");

		const results = h.session.agent.state.messages.filter((m) => m.role === "toolResult");
		const allowResult = results.find((r) => r.toolCallId === "call-allow");
		const denyResult = results.find((r) => r.toolCallId === "call-deny");
		expect(allowResult?.isError).toBe(false);
		expect(denyResult?.isError).toBe(true);
		expect(existsSync(allowedPath)).toBe(true);
		expect(existsSync(deniedPath)).toBe(false);
	});

	it("applies an extension system override for one turn, then restores the base", async () => {
		const h = createCacheSession(root);
		fixture = h;
		await h.session.prompt("baseline");
		const base = h.session.agent.state.systemPrompt;
		expect(base).not.toContain("EXT-OVERRIDE");

		let override = true;
		(h.session as unknown as { _extensionRunner: unknown })._extensionRunner = {
			hasHandlers: () => false,
			emit: async () => {},
			emitMessageEnd: async () => undefined,
			emitToolCall: async () => undefined,
			emitToolResult: async () => undefined,
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async (
				_prompt: string,
				_images: unknown,
				_systemPrompt: string,
				_options: BuildSystemPromptOptions,
			) => (override ? { systemPrompt: "EXT-OVERRIDE" } : undefined),
			invalidate: () => {},
		};

		await h.session.prompt("overridden");
		expect(h.session.agent.state.systemPrompt).toBe("EXT-OVERRIDE");
		expect(h.captured[1]!.systemPrompt).toBe("EXT-OVERRIDE");

		override = false;
		await h.session.prompt("restored");
		expect(h.session.agent.state.systemPrompt).toBe(base);
		expect(h.captured[2]!.systemPrompt).toBe(base);
	});

	it("completes a normal request on a provider without cache support", async () => {
		const faux = registerFauxProvider();
		try {
			const h = createCacheSession(root, {
				configureAgent: (agent) => {
					agent.state.model = faux.getModel();
				},
			});
			fixture = h;
			h.auth.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			await h.session.prompt("hello");
			expect(h.captured).toHaveLength(1);
			const last = h.session.agent.state.messages.at(-1);
			expect(last?.role).toBe("assistant");
		} finally {
			faux.unregister();
		}
	});
});
