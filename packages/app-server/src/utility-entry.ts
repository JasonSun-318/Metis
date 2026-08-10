import { getAgentDir } from "@metis/coding-agent";
import { AppServer } from "./app-server.ts";
import { bindAppServerTransport } from "./transport/transport.ts";
import {
	requireUtilityParentPort,
	type UtilityParentPort,
	UtilityProcessTransport,
} from "./transport/utility-process-transport.ts";

type ElectronUtilityProcess = { readonly parentPort?: UtilityParentPort | null };

async function main(): Promise<void> {
	const parentPort = requireUtilityParentPort(process as unknown as ElectronUtilityProcess);

	const server = await AppServer.create({ agentDir: getAgentDir() });
	const binding = bindAppServerTransport(server, new UtilityProcessTransport(parentPort));
	const close = () => {
		void binding.close().catch(() => {
			process.exitCode = 1;
		});
	};
	process.once("SIGTERM", close);
	process.once("SIGINT", close);
	process.once("SIGHUP", close);
	try {
		await binding.closed;
	} finally {
		process.off("SIGTERM", close);
		process.off("SIGINT", close);
		process.off("SIGHUP", close);
	}
}

void main().catch(() => {
	console.error("Metis utility app server requires a live Electron parent process.");
	process.exitCode = 1;
});
