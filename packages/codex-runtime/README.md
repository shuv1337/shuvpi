# Pi Codex Runtime

Local sidecar that runs Pi SDK sessions behind Codex's external-agent runtime ABI.

The sidecar owns Pi session creation, streaming, persistence, resume, steering, and
cancellation. Pi's built-in tools are disabled. Filesystem and process operations are
offered as custom tools whose calls are returned to Codex, so the Codex host remains
responsible for sandboxing, approvals, command output, patches, diffs, and cancellation.

## Development

From the pi-mono repository root, build the prerequisite workspaces before this package:

```sh
npm run build -w packages/tui
npm run build -w packages/ai
npm run build -w packages/agent
npm run build -w packages/coding-agent
npm run build -w packages/codex-runtime
npm test -w packages/codex-runtime
```

Run `pi-codex-runtime --help` for the Unix-socket server options. Codex normally launches
the executable and supplies the socket path.
