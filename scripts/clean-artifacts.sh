#!/bin/bash
# Remove compiled-in-place TS artifacts (.js/.d.ts/.map next to .ts sources).
#
# Sources are .ts; the build output goes to dist/. Ad-hoc `tsc`/editor runs can
# emit compiled files next to the sources, where they shadow the .ts during
# NodeNext resolution and cause stale-code false test failures.
#
# Safety (this runs from `pretest:*`, so it must NEVER eat a hand-written file):
# a file is removed ONLY if it is a compiled sibling — i.e. `foo.js`/`foo.js.map`/
# `foo.d.ts`/`foo.d.ts.map` is removed only when `foo.ts` or `foo.tsx` exists next
# to it. A hand-written `tests/fixture.js`, `scripts/smoke.js`, or `examples/basic.js`
# (no `.ts`/`.tsx` sibling) is left untouched, as is a tracked config like
# packages/gui/vite.config.js (no vite.config.ts). node_modules/, dist/, and
# coverage/ are pruned, so build/dependency output is never touched.
set -eo pipefail
cd "$(git rev-parse --show-toplevel)"

roots=()
for d in packages/* tests scripts examples; do
  [ -d "$d" ] && roots+=("$d")
done
[ "${#roots[@]}" -eq 0 ] && { echo "clean:artifacts — no source trees"; exit 0; }

removed=0
while IFS= read -r -d '' f; do
  case "$f" in
    *.d.ts.map) base="${f%.d.ts.map}" ;;
    *.d.ts)     base="${f%.d.ts}" ;;
    *.js.map)   base="${f%.js.map}" ;;
    *.js)       base="${f%.js}" ;;
    *)          continue ;;
  esac
  # Only a compiled sibling (its .ts/.tsx source exists)...
  [ -f "${base}.ts" ] || [ -f "${base}.tsx" ] || continue
  # ...AND never a tracked file. A tracked .js that happens to have a .ts sibling
  # (e.g. packages/gui/vite.config.js next to vite.config.ts) is a hand-maintained
  # file, not disposable build noise — leave it.
  if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
    continue
  fi
  rm -f "$f"
  removed=$((removed + 1))
done < <(find "${roots[@]}" \
  -type d \( -name node_modules -o -name dist -o -name coverage \) -prune -o \
  -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print0)

echo "clean:artifacts — removed ${removed} compiled-in-place artifact(s)"
