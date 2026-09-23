import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@shuv1337/shuvpi-ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "SHUVPI_RADIUS_GATEWAY";

/** Radius gateway origin, honoring the `SHUVPI_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
