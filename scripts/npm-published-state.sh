#!/usr/bin/env bash
# Answers whether <name>@<version> is already on the registry, for the publish
# workflow's two decisions: whether anything needs building, and whether to pack
# a given package.
#
# Prints exactly `published` or `unpublished`, and exits non-zero with an empty
# stdout when the registry did not answer — auth failure, timeout, rate limit,
# outage. That third case is why this is not a boolean: a caller writing
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

# Deliberately not `if output=$(npm view …); then` — after that construct `$?`
# is the `if` statement's status, which is 0 when the condition merely failed,
# so the undetermined branch would exit 0 and certify the outage as success.
output=$(npm view "$package_version" version 2>&1)
status=$?

if [ "$status" -eq 0 ]; then
	echo published
	exit 0
fi

if grep -Eq '(^|[^[:alnum:]_])E404([^[:alnum:]_]|$)' <<<"$output"; then
	echo unpublished
	exit 0
fi

printf '%s\n' "$output" >&2
echo "Could not determine whether $package_version is published; refusing to guess." >&2
exit 3
