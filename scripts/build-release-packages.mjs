#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { getReleasePackages } from "./release-packages.mjs";

const offline = process.argv.includes("--offline-model-data");
if (process.argv.slice(2).some((arg) => arg !== "--offline-model-data")) throw new Error("Usage: build-release-packages.mjs [--offline-model-data]");
function run(args) {
	console.log(`$ npm ${args.join(" ")}`);
	const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit" });
	if (result.status !== 0) throw new Error(`Release package build failed: npm ${args.join(" ")}`);
}
if (!offline) run(["run", "generate:models"]);
for (const pkg of getReleasePackages()) {
	run(["--prefix", pkg.directory, "run", "clean"]);
	run(["--prefix", pkg.directory, "run", pkg.directory.replaceAll("\\", "/").endsWith("/ai") ? "build:offline" : "build"]);
}
