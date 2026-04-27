#!/bin/bash
# Pre-commit: rebuild dist/ if library source files are staged
# Acts as a smoke test: blocks the commit if any library package fails to build.
# dist/ is gitignored — the rebuild is for local workspace consumers (cli, mcp-server, gui)
# and as fast feedback that source still compiles cleanly.
set -eo pipefail

staged=$(git diff --cached --name-only \
  -- 'packages/types/src/' \
     'packages/core/src/' \
     'packages/nql/src/' \
     'packages/adapter-pgsql/src/' \
  2>/dev/null)

if [ -z "$staged" ]; then
  exit 0  # No library source changes staged, skip
fi

echo "🔨 Rebuilding dist/ (source files staged)..."

# Build in dependency order: types → core → nql → adapter-pgsql
pnpm -C packages/types build
pnpm -C packages/core build
pnpm -C packages/nql build
pnpm -C packages/adapter-pgsql build

echo "✅ dist/ rebuilt — build OK"
