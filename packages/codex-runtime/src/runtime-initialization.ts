import { registerBunOAuthFlows } from "@shuv1337/shuvpi-ai/bun-oauth";

let initialized = false;

/** Register OAuth implementations that Bun must include statically. */
export function initializeStandaloneRuntime(): void {
	if (initialized) return;
	registerBunOAuthFlows();
	initialized = true;
}
