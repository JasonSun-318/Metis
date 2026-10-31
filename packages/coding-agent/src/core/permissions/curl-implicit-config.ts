import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Curl loads implicit options before argv unless -q is its first argument. */
export function curlImplicitConfigurationReason(
	args: readonly string[],
	environment: Readonly<NodeJS.ProcessEnv> = process.env,
	userHome: string = homedir(),
): string | undefined {
	if (args[0] === "-q") return undefined;
	const candidates = new Set([
		...(environment.CURL_HOME ? [join(environment.CURL_HOME, ".curlrc")] : []),
		...(environment.XDG_CONFIG_HOME ? [join(environment.XDG_CONFIG_HOME, "curlrc")] : []),
		join(userHome, ".curlrc"),
	]);
	for (const candidate of candidates) {
		try {
			statSync(candidate);
			return "curl has implicit configuration; put -q first to use only the displayed command";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return "curl implicit configuration cannot be inspected completely";
			}
		}
	}
	return undefined;
}
