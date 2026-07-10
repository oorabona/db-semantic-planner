#!/usr/bin/env node
/**
 * Fail if a commit message cannot be parsed by release-please's own parser
 * (@conventional-commits/parser — the exact grammar release-please uses in
 * `parseConventionalCommits`).
 *
 * release-please SILENTLY skips any commit it cannot parse and cuts no release
 * PR (googleapis/release-please#2564), so a valid fix/feat can lose its release
 * with no visible error. This guard makes that failure loud at commit time, run
 * by the commit-msg hook.
 *
 * It is deliberately a standalone check, NOT a commitlint rule: commitlint's
 * `ignores` (squash duplicate-header artefacts) would otherwise skip it, and a
 * parse failure must never be ignored.
 *
 * It parses the EXACT bytes it is given — it does NOT strip `#` comment lines.
 * git's cleanup is the caller's job: the hook pipes the message through
 * `git stripspace --strip-comments` first (git's default cleanup), so the guard
 * sees exactly the bytes git will commit. (A commit made with the non-default
 * `--cleanup=verbatim` keeps `#` lines verbatim; that edge is not covered here.)
 *
 * Scope: this is a LOCAL preventer for the committer's own messages. It does not
 * see commits authored without the hook (web UI, a contributor without hooks) or
 * a squash message generated at merge — those fall back to release-please's
 * existing silent-skip, i.e. the status quo. See #301.
 *
 * Usage: check-release-please-parseable.mjs <message-file | ->
 *   `-` reads the message from stdin.
 */
import { readFileSync } from 'node:fs';
import { parser } from '@conventional-commits/parser';

const source = process.argv[2];
if (!source) {
  process.stderr.write(
    'usage: check-release-please-parseable.mjs <message-file | ->\n',
  );
  process.exit(2);
}

// Trailing blank lines only — release-please's parser and git both ignore
// them, and trimming avoids a spurious empty-message trip. No `#`-stripping.
const message = readFileSync(source === '-' ? 0 : source, 'utf8').replace(
  /\s+$/,
  '',
);

if (message === '') process.exit(0);

try {
  parser(message);
} catch (error) {
  const detail = String(error?.message ?? error).split('\n')[0];
  process.stderr.write(
    `✖ commit message is not parseable by release-please (${detail}).\n` +
      '  release-please would silently skip it and cut no release PR.\n' +
      '  Keep the body free of code-like parenthesised snippets — especially a\n' +
      '  body line that starts with `name(...)` — and put runnable examples in\n' +
      '  the PR description instead.\n',
  );
  process.exit(1);
}
