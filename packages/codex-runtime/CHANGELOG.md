# Changelog

## [Unreleased]

### Added

- Added `ultra` reasoning passthrough for Codex-hosted ShuvPi sessions.

## [0.84.2] - 2026-08-11

### Fixed

- Resume legacy `xai-oauth/grok-4.5` Codex sessions as `xai/grok-4.5` with an append-only, authenticated model migration instead of falling back to an unrelated default.
- Register ShuvPi's bundled OAuth implementations at sidecar startup so standalone Bun binaries can authenticate lazy-loaded providers such as `xai`.
- Derive the sidecar handshake version from its bundled package manifest instead of a manually maintained literal or a dependency version.

## 0.80.6

- Add the versioned Pi/Codex runtime protocol and Unix-socket server.
- Add Pi SDK spawn, resume, prompt, steering, follow-up, interruption, and close support.
- Route host tool calls through Codex and map Pi lifecycle events into native Codex events.
- Persist Pi session locators for cold resume.
