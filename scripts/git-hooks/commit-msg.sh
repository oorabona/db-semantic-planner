#!/bin/sh
set -eu

# Optional: chain a contributor's personal global commit-msg hook.
# Opt-in via the DBSP_GLOBAL_COMMIT_MSG_HOOK env var (path to script).
# Set in your shell rc or a .envrc, e.g.:
#   export DBSP_GLOBAL_COMMIT_MSG_HOOK="$HOME/.claude/hooks/commit-msg-style-check.sh"
# Default: no chaining — the project checks below (commitlint + the
# release-please parseability guard) are the only validation.
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

# release-please parseability guard. A message release-please cannot parse is
# silently skipped (no release PR is cut), so reject it here. This is a standalone
# check — NOT a commitlint rule — so commitlint's squash-artefact `ignores` cannot
# skip it. CI runs the same check over a PR's commits and the merged commit.
#
# `git stripspace --strip-comments` applies git's own commit-time cleanup (drop
# whole-line `#` comments + collapse blank lines) so the guard sees exactly the
# bytes git will commit — the guard itself never strips comments.
git stripspace --strip-comments < "$1" \
  | node "$(git rev-parse --show-toplevel)/scripts/check-release-please-parseable.mjs" -
