import { describe, expect, it } from "vitest";
import { getShellEnv } from "../src/utils/shell.ts";

describe("shell environment", () => {
	it("keeps bundled OfficeCLI offline and non-resident", () => {
		const previousResidentFlush = process.env.OFFICECLI_RESIDENT_FLUSH;
		process.env.OFFICECLI_RESIDENT_FLUSH = "each";
		try {
			const env = getShellEnv();

			expect(env.OFFICECLI_SKIP_UPDATE).toBe("1");
			expect(env.OFFICECLI_NO_AUTO_INSTALL).toBe("1");
			expect(env.OFFICECLI_NO_AUTO_RESIDENT).toBe("1");
			expect(env.OFFICECLI_RESIDENT_FLUSH).toBeUndefined();
		} finally {
			if (previousResidentFlush === undefined) delete process.env.OFFICECLI_RESIDENT_FLUSH;
			else process.env.OFFICECLI_RESIDENT_FLUSH = previousResidentFlush;
		}
	});
});
