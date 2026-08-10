import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
	const previous = process.env.METIS_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "metis-coding-agent-tests-"));
	process.env.METIS_CODING_AGENT_DIR = agentDir;

	return () => {
		if (previous === undefined) delete process.env.METIS_CODING_AGENT_DIR;
		else process.env.METIS_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	};
}
