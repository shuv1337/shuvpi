import { getPiShuvAssetPath as getBundledPiShuvAssetPath } from "@shuv1337/shuvpi-coding-agent";

export function getPiShuvAssetPath(name: "app-bridge.bundle.js" | "powerline-theme.json" | "sandbox-child.cjs"): string {
	return getBundledPiShuvAssetPath(name);
}
