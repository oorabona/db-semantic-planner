#!/bin/sh

# Chain the contributor's global commit-msg hook if available.
# This preserves any personal commit-style guards (e.g. process-jargon
# detection) without requiring repo-side knowledge of them.
GLOBAL_HOOK="${HOME}/.claude/hooks/commit-msg-style-check.sh"
if [ -x "$GLOBAL_HOOK" ]; then
  "$GLOBAL_HOOK" "$1" || exit $?
fi

# Project-level commitlint validation against commitlint.config.mjs.
# Catches footer-leading-blank, scope-enum, subject-case, etc.
# CI runs the same rules; this hook gives fast local feedback.
pnpm exec commitlint --edit "$1"
