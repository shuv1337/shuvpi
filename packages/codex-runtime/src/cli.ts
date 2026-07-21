#!/usr/bin/env node

import runtimePackage from "../package.json" with { type: "json" };
import { parseRuntimeArguments } from "./cli-args.ts";
import { initializeStandaloneRuntime } from "./runtime-initialization.ts";
import { fauxRuntimeFixtureFromEnvironment } from "./sdk/faux-runtime-fixture.ts";
import { RuntimeDispatcher } from "./server/runtime-dispatcher.ts";
import { UnixRuntimeServer } from "./server/unix-runtime-server.ts";

// The sidecar owns the wire handshake, so its bundled manifest is the only
// authoritative version. Reading the coding-agent dependency version here can
// drift when package-manager ranges resolve a newer compatible SDK release.
const SERVER_VERSION = process.env.SHUVPI_CODEX_RUNTIME_VERSION ?? runtimePackage.version;

initializeStandaloneRuntime();

async function main(): Promise<void> {
	const options = parseRuntimeArguments(process.argv.slice(2));
	if (options.showHelp) {
		process.stdout.write("Usage: pi-codex-runtime --socket <unix-socket-path>\n");
		return;
	}
	if (options.showVersion) {
		process.stdout.write(`${SERVER_VERSION}\n`);
		return;
	}

	const fauxFixture = await fauxRuntimeFixtureFromEnvironment();
	const dispatcher = new RuntimeDispatcher(fauxFixture?.factory);
	const server = new UnixRuntimeServer({
		socketPath: options.socketPath,
		serverVersion: SERVER_VERSION,
		onEnvelope: (connection, envelope) => {
			void dispatcher.handleEnvelope(connection, envelope).catch((error: unknown) => {
				process.stderr.write(`pi-codex-runtime request failure: ${errorMessage(error)}\n`);
			});
		},
		onConnectionError: (error) => {
			process.stderr.write(`pi-codex-runtime connection failure: ${error.message}\n`);
		},
	});
	await server.listen();

	let shuttingDown = false;
	const shutdown = async (exitCode: number) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		await dispatcher.close();
		await server.close();
		fauxFixture?.dispose();
		process.exitCode = exitCode;
	};
	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
	process.stderr.write(`pi-codex-runtime fatal: ${errorMessage(error)}\n`);
	process.exitCode = 1;
});
