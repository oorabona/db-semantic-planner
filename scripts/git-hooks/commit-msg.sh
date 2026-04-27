#!/bin/sh
set -eu

# Optional: chain a contributor's personal global commit-msg hook.
# Opt-in via the DBSP_GLOBAL_COMMIT_MSG_HOOK env var (path to script).
# Set in your shell rc or a .envrc, e.g.:
#   export DBSP_GLOBAL_COMMIT_MSG_HOOK="$HOME/.claude/hooks/commit-msg-style-check.sh"
# Default: no chaining — the project commitlint validation is the only check.
if [ -n "${DBSP_GLOBAL_COMMIT_MSG_HOOK:-}" ] && [ -x "${DBSP_GLOBAL_COMMIT_MSG_HOOK:-}" ]; then
  "$DBSP_GLOBAL_COMMIT_MSG_HOOK" "$1" || exit $?
fi

# Anchor to repo root so pnpm context resolves correctly,
# even if the hook is invoked from a subdirectory.
cd "$(git rev-parse --show-toplevel)"

# Project-level commitlint validation against commitlint.config.mjs.
# Catches footer-leading-blank, scope-enum, subject-case, etc.
# CI runs the same rules; this hook gives fast local feedback.
pnpm exec commitlint --edit "$1"
