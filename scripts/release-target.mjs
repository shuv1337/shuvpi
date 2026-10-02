export const RELEASE_REPOSITORY = "shuv1337/shuvpi";
export const RELEASE_PACKAGE = "@shuv1337/shuvpi-coding-agent";

/** Refuse publication with upstream identities or a tag from another version. */
export function assertReleaseTarget(packages, { tag = process.env.RELEASE_TAG, repository = process.env.GITHUB_REPOSITORY } = {}) {
	if (!packages.some((pkg) => pkg.name === RELEASE_PACKAGE) || packages.some((pkg) => !pkg.name.startsWith("@shuv1337/shuvpi-"))) {
		throw new Error("Release packages must belong to the Shuvpi CLI dependency closure");
	}
	const versions = [...new Set(packages.map((pkg) => pkg.version))];
	if (versions.length !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(versions[0])) {
		throw new Error(`Release packages are not lockstep stable versions: ${versions.join(", ")}`);
	}
	if (tag !== undefined && tag !== `v${versions[0]}`) throw new Error(`Release tag ${tag} does not match package version ${versions[0]}`);
	if (repository !== undefined && repository !== RELEASE_REPOSITORY) throw new Error(`Release repository must be ${RELEASE_REPOSITORY}`);
	return versions[0];
}
