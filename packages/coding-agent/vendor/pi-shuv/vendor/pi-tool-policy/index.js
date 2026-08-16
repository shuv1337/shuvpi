export default function (pi) {
  const DENIED_TOOLS = new Set(["set_tab_title", "web_search", "fetch_content"]);

  const filterActiveTools = () => {
    const active = pi.getActiveTools();
    const filtered = active.filter((name) => !DENIED_TOOLS.has(name));
    if (filtered.length !== active.length) {
      pi.setActiveTools(filtered);
    }
  };

  pi.on("session_start", async () => {
    filterActiveTools();
  });

  pi.on("tool_call", async (event) => {
    if (DENIED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool '${event.toolName}' is disabled by local policy.`,
      };
    }
  });
}
