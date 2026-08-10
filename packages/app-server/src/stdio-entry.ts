import { getAgentDir } from "@metis/coding-agent";
import { AppServer } from "./app-server.ts";
import { StdioTransport } from "./transport/stdio-transport.ts";
import { bindAppServerTransport } from "./transport/transport.ts";

async function main(): Promise<void> {
	const server = await AppServer.create({ agentDir: getAgentDir() });
	const binding = bindAppServerTransport(server, new StdioTransport(process.stdin, process.stdout));
	await binding.closed;
}

void main().catch(() => {
	console.error("Metis app server failed to start or shut down cleanly.");
	process.exitCode = 1;
});
