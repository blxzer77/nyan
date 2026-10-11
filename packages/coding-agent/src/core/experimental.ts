export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.NYAN_EXPERIMENTAL === "1";
}
