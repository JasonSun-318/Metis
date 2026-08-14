import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type ClientParams, type ClientResult, MAX_PUBLIC_TEXT_UTF8_BYTES } from "@metis/app-protocol";
import { readSingleLinkTextFileSync, replaceFileAtomicallySync } from "@metis/coding-agent";

export class PersonalizationService {
	private readonly instructionsPath: string;

	constructor(agentDir: string) {
		this.instructionsPath = join(agentDir, "AGENTS.md");
	}

	view(): ClientResult<"personalization/get"> {
		return {
			instructions:
				readSingleLinkTextFileSync(this.instructionsPath, { maxBytes: MAX_PUBLIC_TEXT_UTF8_BYTES }) ?? "",
		};
	}

	update(params: ClientParams<"personalization/update">): ClientResult<"personalization/update"> {
		if (Buffer.byteLength(params.instructions, "utf8") > MAX_PUBLIC_TEXT_UTF8_BYTES) {
			throw new Error("Global instructions exceed the 64 KiB limit");
		}
		try {
			const existing = lstatSync(this.instructionsPath);
			if (!existing.isFile() || existing.nlink !== 1) {
				throw new Error("Global instructions must be a regular single-link file");
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		replaceFileAtomicallySync(this.instructionsPath, params.instructions, { mode: 0o600 });
		return { instructions: params.instructions };
	}
}
