# Changelog

## [0.87.1] - 2026-09-23

### Changed

- Merged upstream pi v0.87.1.

## [0.86.1] - 2026-09-08

## [0.86.0] - 2026-09-07

### Changed

- Merged upstream pi v0.85.0: service-addressed session RPC protocol.

## [0.85.1] - 2026-09-02

## [0.85.0] - 2026-08-17

## [0.84.6] - 2026-08-17

## [0.84.5] - 2026-08-17

## [0.84.4] - 2026-08-17

## [0.84.3] - 2026-08-15

### Added

- Added `ultra` to the remote-session thinking-level protocol.

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.
- Replaced `SessionSummarySchema` and `SessionSummary` with durable `SessionMetadataSchema` and `SessionMetadata` for session lists; runtime state remains in acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote shuvpi sessions.
- Added `not_implemented` and `internal_error` protocol error codes for sanitized server failures ([#7644](https://github.com/earendil-works/pi/pull/7644)).
