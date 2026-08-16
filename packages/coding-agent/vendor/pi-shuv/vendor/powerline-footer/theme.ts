/**
 * Theme system for powerline-footer
 * 
 * Colors are resolved in order:
 * 1. User overrides from theme.json (if exists)
 * 2. Preset colors
 * 3. Default colors
 */

import type { Theme, ThemeColor } from "@shuv1337/shuvpi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorScheme, ColorValue, SemanticColor, ThemeLike } from "./types.ts";
import { getPiShuvAssetPath } from "../../features/assets.ts";

export interface PowerlineThemeConfig {
  colors?: unknown;
  icons?: unknown;
}

// Default color scheme — Powerlevel10k classic (restored from powerline-footer 0.2.x)
// Hex literals so the footer keeps the old look regardless of the active Pi theme.
const DEFAULT_COLORS: Required<ColorScheme> = {
  model: "#00afff",           // Dir anchor (39)
  shellMode: "#00afff",
  path: "#0087af",            // Dir foreground (31)
  gitDirty: "#5fd700",        // Keep branch green even when dirty (p10k)
  gitClean: "#5fd700",        // VCS clean (76)
  thinking: "#8787af",        // Dir shortened (103)
  thinkingMinimal: "#6c6c6c",
  thinkingLow: "#8787af",
  thinkingMedium: "#00afff",
  context: "#a8a8a8",         // Command exec time (248)
  contextWarn: "#ffd700",     // Disk usage warning (220)
  contextError: "#d70000",    // Status error (160)
  cost: "#5f8787",            // Time (66)
  tokens: "#8787af",          // Muted purple-gray (103)
  separator: "#6c6c6c",       // Subsegment separator (242)
  border: "#444444",          // Multiline connector (238)
};

// Rainbow colors for high thinking levels (p10k palette)
const RAINBOW_COLORS = [
  "#5fd700", // green
  "#d7af00", // yellow
  "#ffd700", // bright yellow
  "#00afff", // blue
  "#5f8787", // teal
  "#8787af", // purple-gray
  "#d7af87", // tan
  "#5fd700", // loop
];

// Cache for user theme overrides
let userThemeCache: ColorScheme | null = null;
let userThemeCacheTime = 0;
let themeConfigCache: PowerlineThemeConfig | null = null;
let themeConfigCacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds
const warnedInvalidThemeColors = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeUserThemeOverrides(value: unknown): ColorScheme {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized: ColorScheme = {};
  for (const [key, rawColor] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_COLORS, key)) {
      continue;
    }
    if (typeof rawColor !== "string") {
      continue;
    }

    const color = rawColor.trim();
    if (!color) {
      continue;
    }

    sanitized[key as SemanticColor] = color as ColorValue;
  }

  return sanitized;
}

/**
 * Get the path to the theme.json file
 */
function getThemePath(): string {
  return getPiShuvAssetPath("powerline-theme.json");
}

/**
 * Load user theme config from theme.json
 */
export function loadThemeConfig(): PowerlineThemeConfig {
  const now = Date.now();
  if (themeConfigCache && now - themeConfigCacheTime < CACHE_TTL) {
    return themeConfigCache;
  }

  const themePath = getThemePath();
  try {
    if (existsSync(themePath)) {
      const content = readFileSync(themePath, "utf-8");
      const parsed = JSON.parse(content);
      themeConfigCache = isRecord(parsed) ? parsed : {};
      themeConfigCacheTime = now;
      return themeConfigCache;
    }
  } catch (error) {
    // Theme overrides are optional. If the file is unreadable or malformed,
    // keep rendering with built-in defaults instead of breaking the footer.
    console.debug(`[powerline-theme] Failed to load ${themePath}:`, error);
  }

  themeConfigCache = {};
  themeConfigCacheTime = now;
  return themeConfigCache;
}

function loadUserTheme(): ColorScheme {
  const now = Date.now();
  if (userThemeCache && now - userThemeCacheTime < CACHE_TTL) {
    return userThemeCache;
  }

  userThemeCache = sanitizeUserThemeOverrides(loadThemeConfig().colors);
  userThemeCacheTime = now;
  return userThemeCache;
}

/**
 * Resolve a semantic color to an actual color value
 */
export function resolveColor(
  semantic: SemanticColor,
  presetColors?: ColorScheme
): ColorValue {
  const userTheme = loadUserTheme();
  
  // Priority: user overrides > preset colors > defaults
  return userTheme[semantic] 
    ?? presetColors?.[semantic] 
    ?? DEFAULT_COLORS[semantic];
}

/**
 * Check if a color value is a hex color
 */
function isHexColor(color: ColorValue): color is `#${string}` {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

/**
 * Convert hex color to ANSI escape code
 */
function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Apply a color to text using the pi theme or custom hex
 */
export function applyColor(
  theme: ThemeLike,
  color: ColorValue,
  text: string
): string {
  if (isHexColor(color)) {
    return `${hexToAnsi(color)}${text}\x1b[0m`;
  }

  try {
    return theme.fg(color as ThemeColor, text);
  } catch (error) {
    const key = String(color);
    if (!warnedInvalidThemeColors.has(key)) {
      warnedInvalidThemeColors.add(key);
      if (warnedInvalidThemeColors.size > 200) {
        warnedInvalidThemeColors.clear();
      }
      console.debug(`[powerline-theme] Invalid theme color "${key}"; falling back to "text".`, error);
    }
    return theme.fg("text", text);
  }
}

/**
 * Apply a semantic color to text
 */
export function fg(
  theme: ThemeLike,
  semantic: SemanticColor,
  text: string,
  presetColors?: ColorScheme
): string {
  const color = resolveColor(semantic, presetColors);
  return applyColor(theme, color, text);
}

/**
 * Apply rainbow gradient to text (for high thinking levels)
 */
export function rainbow(text: string): string {
  let result = "";
  let colorIndex = 0;
  for (const char of text) {
    if (char === " " || char === ":") {
      result += char;
    } else {
      result += hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]) + char;
      colorIndex++;
    }
  }
  return result + "\x1b[0m";
}

/**
 * Get the default color scheme
 */
export function getDefaultColors(): Required<ColorScheme> {
  return { ...DEFAULT_COLORS };
}
