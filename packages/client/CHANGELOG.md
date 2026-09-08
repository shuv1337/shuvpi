# Changelog

## [0.86.1] - 2026-09-08

## [0.86.0] - 2026-09-07

### Changed

- Merged upstream pi v0.85.0: client rewritten for the service-addressed session RPC protocol with unix transport support.

## [0.85.1] - 2026-09-02

## [0.85.0] - 2026-08-17

## [0.84.6] - 2026-08-17

## [0.84.5] - 2026-08-17

## [0.84.4] - 2026-08-17

## [0.84.3] - 2026-08-15

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Replaced `SessionSummary` with durable `SessionMetadata` for `ShuvpiClient.listSessions()` and server snapshots; runtime state is available only from acquired session snapshots ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added the experimental transport-neutral `ShuvpiClient` and multi-session `ShuvpiSessionHandle` APIs with structured `ShuvpiServerError` responses.
