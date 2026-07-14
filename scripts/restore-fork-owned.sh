#!/usr/bin/env bash
# restore-fork-owned.sh — run after `git merge v0.75.4` halts on conflicts.
# Restores every fork-owned path that upstream v0.75.4 deleted or never had.
# Uses `git checkout HEAD --` (the ancestry-bridge HEAD), NOT `--ours`, because
# many fork-owned files were not modified after v0.70.6, so Git resolves them
# as clean deletes (no stage entries) and `--ours` cannot restore them.
set -euo pipefail

FORK_OWNED=(
  packages/mom
  packages/pods
  packages/web-ui
  packages/coding-agent/examples/extensions/custom-provider-qwen-cli
  packages/coding-agent/examples/extensions/antigravity-image-gen.ts
  packages/ai/src/providers/google-gemini-cli.ts
  packages/ai/src/providers/proxx-debug.ts
  packages/ai/src/utils/oauth/google-gemini-cli.ts
  packages/ai/src/utils/oauth/google-antigravity.ts
  packages/ai/test/google-gemini-cli-claude-thinking-header.test.ts
  packages/ai/test/google-gemini-cli-empty-stream.test.ts
  packages/ai/test/google-gemini-cli-retry-delay.test.ts
  packages/ai/test/google-tool-call-missing-args.test.ts
  packages/coding-agent/src/core/fast-mode.ts
  packages/coding-agent/test/fast-mode.test.ts
  packages/coding-agent/test/compaction-thinking-model.test.ts
  .shuvpi/extensions/diff.ts
  .shuvpi/extensions/files.ts
)

git checkout HEAD -- "${FORK_OWNED[@]}"
git add -- "${FORK_OWNED[@]}"

# Verification: every restored path must now exist on disk and be tracked.
for path in "${FORK_OWNED[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "ERROR: $path missing after restore" >&2
    exit 1
  fi
done

echo "Restored ${#FORK_OWNED[@]} fork-owned paths from bridge HEAD."
