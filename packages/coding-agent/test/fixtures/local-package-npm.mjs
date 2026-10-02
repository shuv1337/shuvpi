import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Route one fixture's registry operations to packed local versions; npm still performs installs/removal.
const [controlPath, , ...args] = process.argv.slice(2);
const control = JSON.parse(readFileSync(controlPath, "utf8"));
appendFileSync(control.log, `${JSON.stringify(args)}\n`);
if (args[0] === "view" && args[1] === control.name) {
	process.stdout.write(JSON.stringify(control.version));
} else if (args[0] === "root" && args[1] === "-g") {
	process.stdout.write(join(control.root, "empty-global"));
} else if (args[0] === "install" || args[0] === "uninstall") {
	if (args[0] === "install") {
		if (args[1] !== control.name && args[1] !== `${control.name}@latest`) {
			throw new Error(`Unexpected package spec: ${args[1]}`);
		}
		args[1] = control.tarball;
	}
	const result = spawnSync("npm", [
		...args, "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
		"--cache", join(control.root, "cache"), "--userconfig", control.userconfig,
		"--registry", "http://127.0.0.1:9",
	], { cwd: control.root, stdio: "inherit" });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} else {
	throw new Error(`Unexpected npm operation: ${args[0]}`);
}
