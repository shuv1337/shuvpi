# Skill browser

The built-in `/skill` command opens a searchable skill browser. Search matches names, categories, and descriptions. Enter inserts `$name` into the editor. Ctrl+F toggles a favorite; favorites appear first. Both keys follow the configured keybindings (`tui.select.confirm` and `app.skillBrowser.favorite`).

Use `/skill name your request` to invoke a skill directly. In an ordinary prompt, `$name` or `$category/name` includes the skill's full text and its base directory. Repeated mentions include the body once. Unknown names stay unchanged. Slash commands and extension-generated input are excluded from dollar expansion.

Dollar completion extends the current editor's autocomplete provider, preserving slash commands, file completion, and custom editors.

## Custom paths and favorites

The browser includes skills discovered by the normal resource loader. Add extra locations in `~/.shuvpi/agent/skill-browser.json` (or the active agent directory):

```json
{
  "paths": ["~/repos/team-skills", "/opt/local-skills"],
  "favorites": ["review", "debug"],
  "defaultActive": []
}
```

Paths may name a Markdown file or a directory. Directories include `SKILL.md` files recursively and Markdown files at the configured root, excluding `README.md`. Relative paths resolve from the current working directory. Symlink cycles are skipped. Automatically discovered skills take precedence when names conflict; the browser reports missing paths and duplicate names.

The optional `extensions/skill-browser/theme.json` under the agent directory overrides browser colors with ANSI SGR parameter strings:

```json
{
  "title": "1;34",
  "selected": "36",
  "description": "37",
  "hint": "90"
}
```

Unspecified colors follow the active application theme.

## Optional active skills

Persistent full-text injection is available through a separate extension. To enable it, create an extension file containing:

```ts
import { createActiveSkillsExtension } from "@shuv1337/shuvpi-coding-agent/extensions/active-skills";

export default createActiveSkillsExtension();
```

`/active-skills` opens a multi-select list of skills from custom paths. Space toggles the highlighted skill (`app.activeSkills.toggle`); Enter saves the selection for the current session branch. Escape cancels changes.

Selected skill bodies are read again and added to the system prompt before each turn. `/active-skills clear` removes the selection. `/active-skills save-defaults` saves the current selection to `defaultActive` for fresh sessions. Defaults do not replace an existing selection or activate skills when resuming conversation history.

Selection is stored in session entries. Resuming restores it, navigating the session tree restores that branch's selection, and other SDK sessions keep their own selection. An explicit empty selection remains empty after restart. Missing skill files produce a warning and are omitted from that turn.
