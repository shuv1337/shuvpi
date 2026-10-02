import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));

async function createFixture(globalPrefix) {
	const root = await mkdtemp(join(tmpdir(), "shuvpi installer-"));
	const home = join(root, "home");
	const fakeBin = join(root, "bin");
	const npmLog = join(root, "npm.log");
	await mkdir(home, { recursive: true });
	await mkdir(fakeBin, { recursive: true });
		await writeFile(join(fakeBin, "node"), "#!/bin/sh\nprintf '%s\\n' \"${FIXTURE_NODE_VERSION:-v22.19.0}\"\n");
	await writeFile(
		join(fakeBin, "npm"),
		`#!/bin/sh
set -eu
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
	printf '%s\\n' "$NPM_GLOBAL_PREFIX"
	exit 0
fi
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then
	printf '%s\\n' "$NPM_GLOBAL_ROOT"
	exit 0
fi
printf '%s\\n' "$*" >> "$NPM_LOG"
[ "\${FIXTURE_NPM_MODE:-}" != fail ] || exit 42
[ "\${FIXTURE_NPM_MODE:-}" != no-bin ] || exit 0
[ "$1" = "--prefix" ]
prefix=$2
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@shuv1337/shuvpi-coding-agent"
cat > "$prefix/bin/shuvpi" <<'SHUVPI'
#!/bin/sh
printf '0.84.5\\n'
SHUVPI
chmod +x "$prefix/bin/shuvpi"
`,
	);
	await chmod(join(fakeBin, "node"), 0o755);
	await chmod(join(fakeBin, "npm"), 0o755);
	return {
		root,
		home,
		fakeBin,
		npmLog,
		globalPrefix,
		globalRoot: join(globalPrefix, "lib", "node_modules"),
	};
}

function runInstaller(fixture, extraEnv = {}) {
	return spawnSync("/bin/sh", [installer], {
		encoding: "utf8",
		env: {
			HOME: fixture.home,
			NPM_GLOBAL_PREFIX: fixture.globalPrefix,
			NPM_GLOBAL_ROOT: fixture.globalRoot,
			NPM_LOG: fixture.npmLog,
			PATH: [fixture.fakeBin, "/usr/bin", "/bin"].join(delimiter),
			SHELL: "/bin/bash",
			...extraEnv,
		},
	});
}

test("uses a writable npm global prefix", async () => {
	const globalPrefix = await mkdtemp(join(tmpdir(), "shuvpi-global-prefix-"));
	const fixture = await createFixture(globalPrefix);
	try {
		await mkdir(fixture.globalRoot, { recursive: true });
		const result = runInstaller(fixture, {
			PATH: [fixture.fakeBin, join(globalPrefix, "bin"), "/usr/bin", "/bin"].join(delimiter),
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			await readFile(fixture.npmLog, "utf8"),
			`--prefix ${globalPrefix} install -g --ignore-scripts --no-audit --no-fund @shuv1337/shuvpi-coding-agent\n`,
		);
		await assert.rejects(readFile(join(fixture.home, ".bashrc"), "utf8"));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
		await rm(globalPrefix, { recursive: true, force: true });
	}
});

test("falls back to a user prefix and configures PATH when the npm prefix is read-only", async () => {
	const globalPrefix = await mkdtemp(join(tmpdir(), "shuvpi-read-only-prefix-"));
	const fixture = await createFixture(globalPrefix);
	try {
		await mkdir(fixture.globalRoot, { recursive: true });
		await mkdir(join(globalPrefix, "bin"), { recursive: true });
		await chmod(fixture.globalRoot, 0o500);
		const path = [fixture.fakeBin, join(globalPrefix, "bin"), "/usr/bin", "/bin"].join(delimiter);
		const result = runInstaller(fixture, { PATH: path });
		assert.equal(result.status, 0, result.stderr);
		const userPrefix = join(fixture.home, ".local");
		assert.equal(
			await readFile(fixture.npmLog, "utf8"),
			`--prefix ${userPrefix} install -g --ignore-scripts --no-audit --no-fund @shuv1337/shuvpi-coding-agent\n`,
		);
		const expectedPathBlock =
			'\n# Added by the Shuvpi installer\ncase ":$PATH:" in\n\t*":$HOME/.local/bin:"*) ;;\n\t*) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n';
		assert.equal(await readFile(join(fixture.home, ".profile"), "utf8"), expectedPathBlock);
		assert.equal(await readFile(join(fixture.home, ".bashrc"), "utf8"), expectedPathBlock);
		assert.match(result.stdout, /Open a new shell/);

		const secondResult = runInstaller(fixture, { PATH: path });
		assert.equal(secondResult.status, 0, secondResult.stderr);
		assert.equal(await readFile(join(fixture.home, ".profile"), "utf8"), expectedPathBlock);
		assert.equal(await readFile(join(fixture.home, ".bashrc"), "utf8"), expectedPathBlock);
	} finally {
		await chmod(fixture.globalRoot, 0o700);
		await rm(fixture.root, { recursive: true, force: true });
		await rm(globalPrefix, { recursive: true, force: true });
	}
});

test("falls back when the package root is writable but the global bin directory is not", async () => {
	const globalPrefix = await mkdtemp(join(tmpdir(), "shuvpi-split-prefix-"));
	const fixture = await createFixture(globalPrefix);
	const globalBin = join(globalPrefix, "bin");
	try {
		await mkdir(fixture.globalRoot, { recursive: true });
		await mkdir(globalBin, { recursive: true });
		await chmod(globalBin, 0o500);
		const result = runInstaller(fixture, {
			PATH: [fixture.fakeBin, globalBin, "/usr/bin", "/bin"].join(delimiter),
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(await readFile(fixture.npmLog, "utf8"), new RegExp(`^--prefix ${fixture.home}/.local install`));
	} finally {
		await chmod(globalBin, 0o700);
		await rm(fixture.root, { recursive: true, force: true });
		await rm(globalPrefix, { recursive: true, force: true });
	}
});

test("rejects unsupported and malformed Node versions before installing", async () => {
	const fixture = await createFixture("/unused-prefix");
	try {
		for (const version of ["v20.19.0", "v22.18.9", "not-a-version", "v22.19"]) {
			const result = runInstaller(fixture, { FIXTURE_NODE_VERSION: version });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Unsupported Node.js version/);
		}
		await assert.rejects(readFile(fixture.npmLog, "utf8"));
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("keeps shell PATH updates idempotent for zsh and fish", async () => {
	for (const [shell, profile] of [["/bin/zsh", ".zshrc"], ["/bin/fish", ".config/fish/conf.d/shuvpi.fish"]]) {
		const fixture = await createFixture("/unused-prefix");
		try {
			for (let i = 0; i < 2; i++) assert.equal(runInstaller(fixture, { SHELL: shell }).status, 0);
			const content = await readFile(join(fixture.home, profile), "utf8");
			assert.equal(content.match(/# Added by the Shuvpi installer/g).length, 1);
			assert.match(content, /HOME\/\.local\/bin/);
		} finally { await rm(fixture.root, { recursive: true, force: true }); }
	}
});

test("uses a user-local prefix when global bin is absent from PATH", async () => {
	const fixture = await createFixture("/unused-prefix");
	try {
		const result = runInstaller(fixture);
		assert.equal(result.status, 0, result.stderr);
		assert.match(await readFile(fixture.npmLog, "utf8"), /--prefix .*\/home\/\.local install -g --ignore-scripts --no-audit --no-fund @shuv1337\/shuvpi-coding-agent/);
		assert.match(result.stdout, /Installed Shuvpi 0\.84\.5/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("does not report success when npm fails or omits the executable", async () => {
	for (const mode of ["fail", "no-bin"]) {
		const fixture = await createFixture("/unused-prefix");
		try {
			const result = runInstaller(fixture, { FIXTURE_NPM_MODE: mode });
			assert.notEqual(result.status, 0);
			assert.doesNotMatch(result.stdout, /Installed Shuvpi/);
			await assert.rejects(readFile(join(fixture.home, ".profile"), "utf8"));
		} finally { await rm(fixture.root, { recursive: true, force: true }); }
	}
});
