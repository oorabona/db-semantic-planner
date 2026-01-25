#!/bin/bash
# Run all example test suites with their assertion files
# Usage: ./scripts/run-examples.sh [--db] [--verbose]
#
# Options:
#   --db      Run with database (required for full chapter examples)
#   --verbose Show full output, not just summary

set -euo pipefail
cd "$(dirname "$0")/.."

DB_URL="${DB_URL:-postgresql://postgres:demo@127.0.0.1:5432/demo}"
USE_DB=false
VERBOSE=false
PASS=0
FAIL=0
FAILED_TESTS=()

# Parse arguments
for arg in "$@"; do
    case $arg in
        --db) USE_DB=true ;;
        --verbose) VERBOSE=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

run_test() {
    local name="$1"
    local schema="$2"
    local input="$3"
    local assert="$4"
    local needs_db="${5:-no}"

    echo -n "  $name ... "

    local cmd="pnpm dbsp repl -s $schema -i $input -a $assert"
    if [ "$needs_db" = "yes" ] && [ "$USE_DB" = "true" ]; then
        cmd="$cmd -d $DB_URL"
    elif [ "$needs_db" = "yes" ] && [ "$USE_DB" = "false" ]; then
        echo "SKIPPED (needs --db)"
        return
    fi

    local output
    output=$($cmd 2>&1) || true

    local summary
    summary=$(echo "$output" | grep -E "^Summary:" | head -1)

    if echo "$summary" | grep -q "FAILED"; then
        echo "FAILED - $summary"
        ((FAIL++)) || true
        FAILED_TESTS+=("$name")
        if [ "$VERBOSE" = "true" ]; then
            echo "$output" | grep -E "^(❌|  ✗)" || true
        fi
    else
        echo "OK - $summary"
        ((PASS++)) || true
    fi
}

echo "========================================"
echo "Running example test suites"
echo "========================================"
echo ""

echo "DRY-RUN TESTS (no database):"
run_test "test-minimal" "examples/minimal.schema.ts" "examples/test-minimal.dbsp" "examples/test-minimal.assert.dbsp" "no"
run_test "test-blog" "examples/blog.schema.ts" "examples/test-blog.dbsp" "examples/test-blog.assert.dbsp" "no"

echo ""
echo "FULL CHAPTER EXAMPLES (with database):"
run_test "blog-extended" "examples/blog-extended.schema.ts" "examples/blog-extended.dbsp" "examples/blog-extended.assert.dbsp" "yes"
run_test "ecommerce" "examples/ecommerce.schema.ts" "examples/ecommerce.dbsp" "examples/ecommerce.assert.dbsp" "yes"
run_test "pimdam" "examples/pimdam.schema.ts" "examples/pimdam.dbsp" "examples/pimdam.assert.dbsp" "yes"
run_test "scheduling" "examples/scheduling.schema.ts" "examples/scheduling.dbsp" "examples/scheduling.assert.dbsp" "yes"

echo ""
echo "========================================"
echo "TOTAL: $PASS passed, $FAIL failed"
if [ ${#FAILED_TESTS[@]} -gt 0 ]; then
    echo "Failed: ${FAILED_TESTS[*]}"
fi
echo "========================================"

exit $FAIL
