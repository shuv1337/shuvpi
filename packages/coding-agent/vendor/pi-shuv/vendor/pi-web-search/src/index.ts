/**
 * pi-web-search — Web search and content extraction as native Pi tools.
 *
 * Wraps the brave-search scripts (search.js, content.js) so that any agent
 * — including subagents — can search the web and fetch page content without
 * needing bash access.
 *
 * Tools:
 *   web_search      — Search the web via Brave Search API
 *   fetch_content   — Extract readable content from a URL as markdown
 */

import type { ExtensionAPI } from "@shuv1337/shuvpi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@shuv1337/shuvpi-coding-agent";
import { Type } from "@shuv1337/shuvpi-ai";
import { Text } from "@shuv1337/shuvpi-tui";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// ── Brave Search script paths ──────────────────────────────────────────
function getBraveDir(): string {
  const braveDir = process.env.PI_WEB_SEARCH_DIR?.trim();
  if (!braveDir) {
    throw new Error(
      "PI_WEB_SEARCH_DIR is required. Set it to a directory containing search.js and content.js.",
    );
  }
  return braveDir;
}

function getScriptPaths(): { searchScript: string; contentScript: string } {
  const braveDir = getBraveDir();
  return {
    searchScript: join(braveDir, "search.js"),
    contentScript: join(braveDir, "content.js"),
  };
}

function assertScriptExists(scriptPath: string, label: string): void {
  if (existsSync(scriptPath)) return;
  throw new Error(
    `${label} script not found at ${scriptPath}. Set PI_WEB_SEARCH_DIR to a directory containing search.js and content.js.`,
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Run a command via pi.exec and return stdout, handling errors. */
async function run(
  pi: ExtensionAPI,
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const result = await pi.exec(cmd, args, { signal, timeout: timeoutMs });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    ok: result.code === 0 && !result.killed,
  };
}

/** Apply truncation and return [text, wasTruncated]. */
function truncate(text: string): [string, boolean] {
  const result = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return [result.content, result.truncated];
}

/** Write full output to a temp file when truncation occurs. */
function writeTempOutput(content: string, prefix: string): string {
  const dir = join(tmpdir(), "pi-web-search");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${prefix}-${Date.now()}.txt`);
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Build truncation notice for the LLM. */
function truncationNotice(fullText: string, tempPath: string): string {
  return (
    `\n\n[Output truncated (${formatSize(Buffer.byteLength(fullText))} total). ` +
    `Full output saved to: ${tempPath}]`
  );
}

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ────────────────────────────────────────────────────────────────────
  //  web_search
  // ────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Returns titles, URLs, snippets, and optionally full page content as markdown. " +
      "Supports freshness filters for time-sensitive queries.",
    promptSnippet:
      "Search the web via Brave Search. Supports query, result count, content extraction, and freshness filters.",
    promptGuidelines: [
      "Use web_search when you need to find information on the web — documentation, pricing, facts, news, etc.",
      "Set include_content: true when you need the actual page text, not just snippets.",
      "Use freshness for time-sensitive queries: 'pd' (day), 'pw' (week), 'pm' (month), 'py' (year), or a date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String({ description: "Search queries to run" }), {
        description:
          "One or more search queries. Multiple queries are run in parallel for broader coverage.",
        minItems: 1,
        maxItems: 5,
      }),
      num_results: Type.Optional(
        Type.Number({
          description: "Number of results per query (default: 5, max: 20).",
          minimum: 1,
          maximum: 20,
        }),
      ),
      include_content: Type.Optional(
        Type.Boolean({
          description:
            "If true, fetch and include full page content as markdown for each result. Slower but much more useful.",
        }),
      ),
      freshness: Type.Optional(
        Type.String({
          description:
            "Filter by freshness: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), or 'YYYY-MM-DDtoYYYY-MM-DD'.",
        }),
      ),
      curate: Type.Optional(
        Type.Boolean({
          description:
            "If false, return raw results without curation. Default: true (results are returned as-is from Brave).",
        }),
      ),
    }),

    renderCall(args, theme) {
      const queries = args.queries as string[];
      const q = queries.length === 1 ? queries[0] : `${queries.length} queries`;
      let line = theme.fg("toolTitle", theme.bold("web_search "));
      line += theme.fg("accent", `"${q}"`);
      if (args.include_content) line += theme.fg("dim", " +content");
      if (args.freshness) line += theme.fg("dim", ` freshness:${args.freshness}`);
      return new Text(line, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching…"), 0, 0);
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as any;
      if (context.isError || details?.error) {
        return new Text(theme.fg("error", text || `Error: ${details.error}`), 0, 0);
      }
      const resultCount = details?.resultCount ?? 0;
      const queryCount = details?.queryCount ?? 1;
      let summary = theme.fg("success", "✓") + " ";
      summary += theme.fg("dim", `${resultCount} results from ${queryCount} quer${queryCount === 1 ? "y" : "ies"}`);
      if (details?.truncated) summary += theme.fg("warning", " (truncated)");
      if (!expanded) return new Text(summary, 0, 0);

      // Expanded: show first few results
      const lines = text.split("\n").slice(0, 30);
      const preview = lines.map((l) => theme.fg("dim", `  ${l}`)).join("\n");
      return new Text(summary + "\n" + preview + (text.split("\n").length > 30 ? "\n" + theme.fg("muted", "  ...") : ""), 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate) {
      const queries = params.queries as string[];
      const numResults = (params.num_results as number) ?? 5;
      const includeContent = (params.include_content as boolean) ?? false;
      const freshness = params.freshness as string | undefined;

      onUpdate?.({
        content: [{ type: "text", text: `Searching ${queries.length} quer${queries.length === 1 ? "y" : "ies"}…` }],
        details: {},
      });

      // Run all queries in parallel
      const results = await Promise.all(
        queries.map(async (query) => {
          const { searchScript } = getScriptPaths();
          assertScriptExists(searchScript, "Search");
          const args = [searchScript, query, "-n", String(numResults)];
          if (includeContent) args.push("--content");
          if (freshness) args.push("--freshness", freshness);

          const { stdout, stderr, ok } = await run(pi, "node", args, signal, 60_000);
          if (!ok) {
            return `--- Search failed for "${query}" ---\n${stderr || "Unknown error"}\n`;
          }
          return stdout;
        }),
      );

      let output: string;
      if (queries.length === 1) {
        output = results[0];
      } else {
        output = results
          .map((r, i) => `=== Query: "${queries[i]}" ===\n${r}`)
          .join("\n\n");
      }

      // Count results
      const resultCount = (output.match(/^--- Result \d+/gm) || []).length;

      // Truncate if needed
      const [truncated, wasTruncated] = truncate(output);
      let finalOutput = truncated;
      if (wasTruncated) {
        const tmpPath = writeTempOutput(output, "search");
        finalOutput += truncationNotice(output, tmpPath);
      }

      return {
        content: [{ type: "text", text: finalOutput }],
        details: {
          queryCount: queries.length,
          resultCount,
          truncated: wasTruncated,
        } as any,
      };
    },
  });

  // ────────────────────────────────────────────────────────────────────
  //  fetch_content
  // ────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch a URL and extract its readable content as clean markdown. " +
      "Uses Mozilla Readability for article extraction. Great for documentation pages, blog posts, and articles.",
    promptSnippet:
      "Fetch a URL and extract readable content as markdown.",
    promptGuidelines: [
      "Use fetch_content when you have a specific URL and need its full text content.",
      "Prefer this over web_search when you already know the URL.",
      "Works best on article-style pages. May return minimal content for SPAs or heavily JS-rendered pages.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "The URL to fetch and extract content from.",
      }),
    }),

    renderCall(args, theme) {
      const url = args.url as string;
      // Shorten URL for display
      let display = url;
      try {
        const u = new URL(url);
        display = u.hostname + (u.pathname.length > 40 ? u.pathname.slice(0, 40) + "…" : u.pathname);
      } catch {}
      let line = theme.fg("toolTitle", theme.bold("fetch_content "));
      line += theme.fg("accent", display);
      return new Text(line, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Fetching…"), 0, 0);
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as any;
      if (context.isError || details?.error) {
        return new Text(theme.fg("error", text || `Error: ${details.error}`), 0, 0);
      }
      const size = details?.contentSize ?? 0;
      let summary = theme.fg("success", "✓") + " ";
      summary += theme.fg("dim", `${formatSize(size)} extracted`);
      if (details?.truncated) summary += theme.fg("warning", " (truncated)");
      if (!expanded) return new Text(summary, 0, 0);

      const lines = text.split("\n").slice(0, 30);
      const preview = lines.map((l) => theme.fg("dim", `  ${l}`)).join("\n");
      return new Text(
        summary + "\n" + preview + (text.split("\n").length > 30 ? "\n" + theme.fg("muted", "  ...") : ""),
        0, 0,
      );
    },

    async execute(_toolCallId, params, signal, onUpdate) {
      const url = params.url as string;

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}…` }],
        details: {},
      });

      const { contentScript } = getScriptPaths();
      assertScriptExists(contentScript, "Content extraction");

      const { stdout, stderr, ok } = await run(
        pi,
        "node",
        [contentScript, url],
        signal,
        30_000,
      );

      if (!ok) {
        const errMsg = stderr?.trim() || "Failed to fetch content";
        throw new Error(errMsg);
      }

      const contentSize = Buffer.byteLength(stdout);

      // Truncate if needed
      const [truncated, wasTruncated] = truncate(stdout);
      let finalOutput = truncated;
      if (wasTruncated) {
        const tmpPath = writeTempOutput(stdout, "content");
        finalOutput += truncationNotice(stdout, tmpPath);
      }

      return {
        content: [{ type: "text", text: finalOutput }],
        details: {
          url,
          contentSize,
          truncated: wasTruncated,
        } as any,
      };
    },
  });
}
