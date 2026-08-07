# shuvpi

[![npm](https://img.shields.io/npm/v/@shuv1337/shuvpi-coding-agent?style=flat-square)](https://www.npmjs.com/package/@shuv1337/shuvpi-coding-agent)

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

Shuvpi is Shuv's maintained fork of the Pi agent harness. The distinct package names, binary, config directory, and environment variables let it coexist with a native upstream Pi installation.

* **[@shuv1337/shuvpi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@shuv1337/shuvpi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@shuv1337/shuvpi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

The project remains derived from [upstream Pi](https://github.com/earendil-works/pi). Upstream services such as the `pi.dev` session viewer remain external dependencies where explicitly documented.

## All Packages

| Package | Description |
|---------|-------------|
| **[@shuv1337/shuvpi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@shuv1337/shuvpi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@shuv1337/shuvpi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@shuv1337/shuvpi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@shuv1337/shuvpi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@shuv1337/shuvpi-protocol](packages/protocol)** | Shared wire protocol contracts for the server and client packages |
| **[@shuv1337/shuvpi-client](packages/client)** | Client library for the Shuvpi server protocol |
| **[@shuv1337/shuvpi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | SQLite session backend for Node.js |
| **[@shuv1337/shuvpi-server](packages/server)** | Experimental Shuvpi server package |

For upstream Slack/chat automation and workflows, see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Shuvpi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Shuvpi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `shuvpi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `shuvpi` process in a local container for simple isolation.
- **OpenShell**: run the whole `shuvpi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules.

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./shuvpi-test.sh  # Run shuvpi from sources (can be run from any directory)
```

## Config migration

Shuvpi uses `~/.shuvpi` and project-local `.shuvpi` directories. It does not automatically read, move, or delete upstream `~/.pi` or `.pi` data. To reuse selected settings, copy them explicitly and review paths before launching:

```bash
mkdir -p ~/.shuvpi
cp -a ~/.pi/agent ~/.shuvpi/
cp -a .pi .shuvpi
```

Use either command only when its source exists. A copy keeps the upstream installation intact.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "shuvpi-${VERSION}-source.tar.gz"
cd "shuvpi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `SHUVPI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `shuvpi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Shuvpi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT
