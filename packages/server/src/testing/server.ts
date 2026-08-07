import { ShuvpiServer } from "../server.ts";
import type { ShuvpiServerOptions, ShuvpiServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends ShuvpiServerOptions {
	service?: ShuvpiServerService;
}

export interface TestServer {
	server: ShuvpiServer;
	service: ShuvpiServerService;
}

/** Create an unstarted ShuvpiServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new ShuvpiServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}
