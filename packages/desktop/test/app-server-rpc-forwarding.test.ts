import { describe, expect, it, vi } from "vitest";
import {
	createDesktopRpcForwarders,
	DESKTOP_RPC_FORWARDING,
	DESKTOP_RPC_FORWARDING_CHANNELS,
} from "../src/shared/app-server-rpc-forwarding.ts";
import { DESKTOP_IPC_CHANNELS } from "../src/shared/desktop-api.ts";

describe("desktop App Server RPC forwarding", () => {
	it("keeps declaration names and channels one-to-one", () => {
		expect(Object.keys(DESKTOP_RPC_FORWARDING_CHANNELS)).toEqual(Object.keys(DESKTOP_RPC_FORWARDING));
		expect(new Set(Object.values(DESKTOP_RPC_FORWARDING_CHANNELS)).size).toBe(
			Object.keys(DESKTOP_RPC_FORWARDING_CHANNELS).length,
		);
		for (const [name, channel] of Object.entries(DESKTOP_RPC_FORWARDING_CHANNELS)) {
			expect(DESKTOP_IPC_CHANNELS[name as keyof typeof DESKTOP_IPC_CHANNELS]).toBe(channel);
		}
	});

	it("normalizes none and optional inputs and forwards required inputs unchanged", async () => {
		const invoke = vi.fn().mockResolvedValue({});
		const api = createDesktopRpcForwarders(invoke);
		const skill = { cwd: null, source: "system" as const, name: "pdf" };

		await Reflect.apply(api.getProfile, undefined, [{ ignored: true }]);
		await api.listSessions();
		await api.getSkill(skill);

		expect(invoke.mock.calls.map(([definition, input]) => [definition.method, input])).toEqual([
			["profile/get", {}],
			["session/list", {}],
			["skill/get", skill],
		]);
	});
});
