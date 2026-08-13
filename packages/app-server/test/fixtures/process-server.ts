import { getAgentDir, SessionManager } from "@metis/coding-agent";
import { AppServer } from "../../src/app-server.ts";
import { StdioTransport } from "../../src/transport/stdio-transport.ts";
import { bindAppServerTransport } from "../../src/transport/transport.ts";

const crashPoint = process.env.METIS_TEST_CRASH_POINT;
let crashed = false;

function crash(): void {
	if (crashed) return;
	crashed = true;
	process.kill(process.pid, "SIGKILL");
}

const appendRuntimeControl = SessionManager.prototype.appendRuntimeControl;
SessionManager.prototype.appendRuntimeControl = function (...args) {
	const result = appendRuntimeControl.apply(this, args);
	const entry = args[0];
	if (
		(crashPoint === "accepted_only" &&
			entry.type === "runtime_operation" &&
			entry.kind === "turn" &&
			entry.state === "accepted") ||
		(crashPoint === "turn_start" && entry.type === "runtime_turn" && entry.state === "started") ||
		(crashPoint === "tool_start" && entry.type === "runtime_tool" && entry.state === "started") ||
		(crashPoint === "tool_complete" && entry.type === "runtime_tool" && entry.state === "completed") ||
		(crashPoint === "operation_finish" &&
			entry.type === "runtime_operation" &&
			entry.kind === "turn" &&
			entry.state === "completed")
	) {
		crash();
	}
	return result;
};

// Process recovery tests exercise crash consistency, not interactive permission routing.
// Make the fixture's new session explicit so extension side effects reach each crash point.
const createSession = SessionManager.create;
SessionManager.create = function (cwd, sessionDir, options) {
	return createSession.call(this, cwd, sessionDir, {
		...options,
		permissionMode: "full",
	});
};

const appendMessage = SessionManager.prototype.appendMessage;
SessionManager.prototype.appendMessage = function (...args) {
	const result = appendMessage.apply(this, args);
	const message = args[0];
	if (
		(crashPoint === "assistant_append" && message.role === "assistant") ||
		(crashPoint === "tool_result" && message.role === "toolResult")
	) {
		crash();
	}
	return result;
};

const server = await AppServer.create({
	agentDir: getAgentDir(),
	titleGenerator: { generate: async () => undefined },
});
const binding = bindAppServerTransport(server, new StdioTransport(process.stdin, process.stdout));
await binding.closed;
