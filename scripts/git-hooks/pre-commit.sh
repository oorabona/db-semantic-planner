#!/bin/bash
# Pre-commit: rebuild dist/ if source files are staged
# Ensures committed code always has fresh dist/ and build succeeds

staged=$(git diff --cached --name-only -- 'packages/*/src/**/*.ts' 2>/dev/null)

if [ -z "$staged" ]; then
  exit 0  # No source changes staged, skip
fi

echo "🔨 Rebuilding dist/ (source files staged)..."

# Build in dependency order: types → core + nql (parallel) → adapter
if ! pnpm -C packages/types build 2>&1 | tail -1; then
  echo "❌ packages/types build failed"
  exit 1
fi

if ! pnpm -C packages/core build 2>&1 | tail -1; then
  echo "❌ packages/core build failed"
  exit 1
fi

pnpm -C packages/nql build 2>&1 | tail -1 &
NQL_PID=$!

wait $NQL_PID
if [ $? -ne 0 ]; then
  echo "❌ packages/nql build failed"
  exit 1
fi

if ! pnpm -C packages/adapter-pgsql build 2>&1 | tail -1; then
  echo "❌ packages/adapter-pgsql build failed"
  exit 1
fi

echo "✅ dist/ rebuilt — build OK"
