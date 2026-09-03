import { describe, expect, it, vi } from "vitest";
import {
	createDesktopRpcForwarders,
	DESKTOP_RPC_FORWARDING,
	DESKTOP_RPC_FORWARDING_CHANNELS,
	desktopRpcIpcFailure,
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

	it("declares Auto command allowlist forwarding", () => {
		expect(DESKTOP_RPC_FORWARDING.getPermissionAutoSettings).toEqual({
			channel: "metis:get-permission-auto-settings",
			method: "permission/auto/get",
			input: "none",
		});
		expect(DESKTOP_RPC_FORWARDING.updatePermissionAutoSettings).toEqual({
			channel: "metis:update-permission-auto-settings",
			method: "permission/auto/update",
			input: "required",
		});
	});

	it("reconstructs a coded RPC error after the structured-clone boundary", async () => {
		const api = createDesktopRpcForwarders(
			vi.fn().mockResolvedValue(desktopRpcIpcFailure(-32011, "Operation failed")),
		);

		const failure = await api
			.renameSession({
				sessionId: "session-1",
				requestId: "11111111-1111-4111-8111-111111111111",
				name: "Renamed",
			})
			.catch((cause: unknown) => cause);

		expect(failure).toMatchObject({ name: "MetisRpcError", message: "Operation failed", code: -32011 });
	});
});
