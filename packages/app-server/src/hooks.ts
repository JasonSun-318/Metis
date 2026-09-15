import type { ClientParams, ClientResult } from "@metis/app-protocol";
import {
	type DeclarativeHook,
	loadDeclarativeHooks,
	readPluginSnapshot,
	saveDeclarativeHooks,
} from "@metis/coding-agent/host";
import { AppServerError } from "./session-runtime-host.ts";

/**
 * Manages the declarative user-level hooks config (~/.metis/agent/hooks.json).
 *
 * Writes take effect when the next session starts; running sessions keep the
 * hooks they were created with.
 */
export class HooksService {
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	view(): ClientResult<"hooks/list"> {
		const { hooks, errors } = loadDeclarativeHooks(this.agentDir);
		let pluginHooks: DeclarativeHook[] = [];
		try {
			const snapshot = readPluginSnapshot(this.agentDir);
			pluginHooks = snapshot.hooks.map((h) => ({
				...h.definition,
				pluginOwner: h.owner,
			}));
		} catch {
			// ignore missing or corrupt plugin snapshot
		}
		return { hooks: [...hooks, ...pluginHooks], loadErrors: errors };
	}

	upsert(params: ClientParams<"hooks/upsert">): ClientResult<"hooks/list"> {
		if (params.hook.pluginOwner) {
			throw new AppServerError("OPERATION_FAILED");
		}
		try {
			const snapshot = readPluginSnapshot(this.agentDir);
			if (snapshot.hooks.some((h) => h.definition.id === params.hook.id)) {
				throw new AppServerError("OPERATION_FAILED");
			}
		} catch (err) {
			if (err instanceof AppServerError) throw err;
		}
		const { hooks } = loadDeclarativeHooks(this.agentDir);
		const incoming = normalizeHook(params.hook);
		const index = hooks.findIndex((hook) => hook.id === incoming.id);
		if (index >= 0) hooks[index] = incoming;
		else hooks.push(incoming);
		try {
			saveDeclarativeHooks(this.agentDir, hooks);
		} catch {
			throw new AppServerError("OPERATION_FAILED");
		}
		return this.view();
	}

	delete(params: ClientParams<"hooks/delete">): ClientResult<"hooks/list"> {
		try {
			const snapshot = readPluginSnapshot(this.agentDir);
			if (snapshot.hooks.some((h) => h.definition.id === params.id)) {
				throw new AppServerError("OPERATION_FAILED");
			}
		} catch (err) {
			if (err instanceof AppServerError) throw err;
		}
		const { hooks } = loadDeclarativeHooks(this.agentDir);
		const remaining = hooks.filter((hook) => hook.id !== params.id);
		if (remaining.length === hooks.length) {
			throw new AppServerError("NOT_FOUND");
		}
		try {
			saveDeclarativeHooks(this.agentDir, remaining);
		} catch {
			throw new AppServerError("OPERATION_FAILED");
		}
		return this.view();
	}
}

/** Drop protocol-only defaults so the persisted file stays minimal and canonical. */
function normalizeHook(hook: ClientParams<"hooks/upsert">["hook"]): DeclarativeHook {
	return {
		id: hook.id,
		name: hook.name,
		enabled: hook.enabled,
		event: hook.event,
		...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
		runMode: hook.runMode,
		command: hook.command,
		...(hook.protocol !== undefined ? { protocol: hook.protocol } : {}),
		...(hook.args !== undefined && hook.args.length > 0 ? { args: hook.args } : {}),
		...(hook.timeoutSeconds !== undefined ? { timeoutSeconds: hook.timeoutSeconds } : {}),
		...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {}),
		...(hook.metadata !== undefined ? { metadata: hook.metadata } : {}),
	};
}
