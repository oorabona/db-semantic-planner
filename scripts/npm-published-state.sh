#!/usr/bin/env bash
# Answers whether <name>@<version> is already on the registry, for the publish
# workflow's two decisions: whether anything needs building, and whether to pack
# a given package.
#
# Prints exactly `published` or `not-found`, and exits non-zero with an empty
# stdout when the registry did not answer — auth failure, timeout, rate limit,
# outage. `not-found` authorizes an upload attempt; it does not prove global
# nonexistence or visibility, and the registry PUT remains authoritative. That
# third case is why this is not a boolean: a caller writing
# `if npm_is_published "$pkg"; then` reads every non-zero as "not published" and
# publishes over an outage. Called as `state=$(npm-published-state.sh "$pkg")`
# under `set -e`, an undetermined answer kills the step instead, because the
# assignment takes the substitution's status.
set -uo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: ${0##*/} <name>@<version>" >&2
	exit 2
fi

package_version="$1"
diagnostic_file=$(mktemp "${TMPDIR:-/tmp}/npm-published-state.XXXXXX") || exit 3
trap 'rm -f "$diagnostic_file"' EXIT

# Deliberately not `if output=$(npm view …); then` — after that construct `$?`
# is the `if` statement's status, which is 0 when the condition merely failed,
# so the undetermined branch would exit 0 and certify the outage as success.
output=$(npm view "$package_version" version --json 2>"$diagnostic_file")
status=$?
diagnostic=$(<"$diagnostic_file")

if [ "$status" -eq 0 ]; then
	if node -e 'const fs = require("node:fs"); try { process.exit(typeof JSON.parse(fs.readFileSync(0, "utf8")) === "string" ? 0 : 1); } catch { process.exit(1); }' <<<"$output"; then
		echo published
		exit 0
	fi
fi

if node -e 'const fs = require("node:fs"); try { const value = JSON.parse(fs.readFileSync(0, "utf8")); process.exit(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && value.error !== null && typeof value.error === "object" && !Array.isArray(value.error) && value.error.code === "E404" ? 0 : 1); } catch { process.exit(1); }' <<<"$output"; then
	echo not-found
	exit 0
fi

printf '%s\n' "$diagnostic" >&2
echo "Could not determine whether $package_version is published; refusing to guess." >&2
exit 3
