import type { Api, Model } from "@shuv1337/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";

const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

// Fork note: upstream gates provider "attribution" headers (OpenRouter title/referer,
// Nvidia billing origin, Cloudflare user-agent — all branded "pi") behind install
// telemetry. This fork removed telemetry, so those default headers are never sent.
// Only functional, non-telemetry session routing headers (OpenCode) are emitted.
function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	_settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
	const merged = {
		...getSessionHeaders(model, sessionId),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
