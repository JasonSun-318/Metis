import { getMetisEnv } from "../config.ts";

export function areExperimentalFeaturesEnabled(): boolean {
	return getMetisEnv("EXPERIMENTAL") === "1";
}
