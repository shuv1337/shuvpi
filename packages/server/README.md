# @shuv1337/shuvpi-server

Experimental. This package is under active development and may change or be removed without notice. Its APIs and behavior are not yet stable.

Server package for shuvpi.

## Session server core

The package exports the `ShuvpiServer` session server.

```ts
import type { ShuvpiServerService } from "@shuv1337/shuvpi-server";
import { createUnixServer } from "@shuv1337/shuvpi-server/unix";

const service: ShuvpiServerService = {
  async listSessions() {
    return storage.listSessions();
  },
  async listModels() {
    return modelRegistry.listModels();
  },
  async createSession(options) {
    return storage.createAndOpen(options);
  },
  async openSession(sessionId) {
    return storage.open(sessionId);
  },
};

const server = createUnixServer(service, {
  path: "/tmp/shuvpi/server.sock",
});
await server.start();
```

`ShuvpiServer` composes transport listeners through the `ShuvpiServerListener` interface. Each listener must complete any transport-specific authentication and authorization before passing a connection to `ShuvpiServer`. For example, a WebSocket listener can validate credentials during the HTTP upgrade, while the Unix listener relies on socket filesystem permissions. The Unix submodule exports the `createUnixListener()` building block and `createUnixServer()` preset, keeping the common case concise without coupling the primary server to Unix sockets. The listener uses length-prefixed CBOR messages from `@shuv1337/shuvpi-protocol`.

This package does not provide a standalone CLI or coding-agent service. Applications supply the `ShuvpiServerService` implementation.

`ShuvpiServerService.listSessions()` returns protocol `SessionMetadata`, not acquired runtime state. Services should map the durable fields their storage supports and may omit `updatedAt`, `parentSessionId`, `sessionName`, and `cwd`. `ShuvpiServer` refreshes available metadata from live snapshots without requiring stored sessions to fabricate phase, model, thinking-level, attachment, or lock values.

## Transport testing

Custom transports can use `@shuv1337/shuvpi-server/testing` for deterministic protocol conformance tests. It exports `createTestServer()`, `TestServerService`, `ProtocolTestClient`, and the transport-neutral `WireChannel` contract. `connectUnixTestClient()` is provided for Unix transport tests.

## `shuvpi-ai` protocol bridge

`@shuv1337/shuvpi-ai` domain objects and `@shuv1337/shuvpi-protocol` wire DTOs remain independent. This package owns their boundary and exports `toProtocolModelMetadata()`, `toProtocolAssistantMessage()`, `toProtocolUserMessage()`, and `toProtocolToolResultMessage()`.

The adapters reject invalid tool inputs, identifiers, timestamps, and mismatched tool results; `toProtocolToolResultMessage()` requires the original `ToolCall` so it can verify the association and convert its arguments itself. Diagnostic details are explicitly sanitized. Closed `shuvpi-ai` unions are mapped exhaustively, and compile-time field manifests enumerate current `shuvpi-ai` properties so additions require an explicit review. The protocol mirrors `shuvpi-ai` vocabulary such as `toolCall` and `toolUse` where the semantics are identical. Protocol schemas enforce consistent lifecycle states, and tests encode adapter output through the runtime schemas so incompatible changes fail in the bridging package.
