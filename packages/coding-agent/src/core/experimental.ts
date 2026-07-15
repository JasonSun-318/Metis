export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.ARCMIND_EXPERIMENTAL === "1";
}
