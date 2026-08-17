# Changelog

## [0.84.4] - 2026-08-17

## [0.84.3] - 2026-08-15

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Replaced `SessionSummary` with durable `SessionMetadata` for `ShuvpiClient.listSessions()` and server snapshots; runtime state is available only from acquired session snapshots ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added the experimental transport-neutral `ShuvpiClient` and multi-session `ShuvpiSessionHandle` APIs with structured `ShuvpiServerError` responses.
