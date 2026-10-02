# Sticky shell

The optional bash-mode extension runs commands in one shell process. `cd`, exported variables and shell functions persist until `/bash-reset` or session shutdown. Commands do not invoke the model or enter its conversation.

Load it from an extension file:

```ts
import { createBashModeExtension } from "@shuv1337/shuvpi-coding-agent/extensions/bash-mode";

export default createBashModeExtension();
```

Run `/bash-mode on` or press the configurable `app.bashMode.toggle` binding (default Ctrl+Shift+B). Enter submits a command. Up/Down recall shell history and restore the draft when you return past the newest entry. Tab or Right accepts a gray completion when the cursor is at the end. Shift+Enter retains multiline command entry.

Ctrl+C interrupts a running command. Escape returns to normal prompt mode after the command finishes. In normal prompt mode, `!` and `!!` keep their native one-off behavior. Run `/bash-reset` from prompt mode to discard the shell environment and transcript; `/bash-mode on` then starts from the session directory.

The transcript keeps recent output with line and byte limits. Successful commands are saved under the agent directory's `bash-mode/history` folder. Completion uses project history, optional local shell history, paths and Git refs. No completion provider sends shell history to a model.

The extension uses `$SHELL`, falling back to `/bin/sh`. Factory options can set `shellPath`, `agentDir`, `historyPath` (use `null` to disable global shell history), `environment`, `transcriptMaxLines` and `transcriptMaxBytes`. Bash and POSIX sh preserve their state after an ordinary interrupt; an explicit `exit`, `exec` or shell termination ends that process. The next command starts a fresh one.

The extension uses the public custom editor slot and preserves the host's current autocomplete chain, including skill completion. It reports a conflict if another custom editor already owns that slot. Session shutdown and reload terminate the managed shell and its process group. Shell processes do not survive a CLI restart.
