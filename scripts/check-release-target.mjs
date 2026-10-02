import { existsSync, readFileSync } from "node:fs";
import { getReleasePackages } from "./release-packages.mjs";
import { assertReleaseTarget } from "./release-target.mjs";

if (!process.env.RELEASE_TAG) throw new Error("RELEASE_TAG is required");
const version = assertReleaseTarget(getReleasePackages());
if (version === "1.0.0") {
	const notes = "release-notes/1.0.0.md";
	if (!existsSync(notes) || !readFileSync(notes, "utf8").trim()) throw new Error(`Initial release requires reviewed ${notes}`);
}
console.log(`Verified Shuvpi release target ${process.env.RELEASE_TAG}`);
