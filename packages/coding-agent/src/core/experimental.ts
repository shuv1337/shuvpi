export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.SHUVPI_EXPERIMENTAL === "1";
}
