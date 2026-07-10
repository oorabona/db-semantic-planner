/**
 * Tests for the release-please parseability guard.
 * Run with: node --test scripts/check-release-please-parseable.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(
  new URL('./check-release-please-parseable.mjs', import.meta.url),
);

/** Run the guard over a message (via stdin); return the process exit code. */
function exitCode(message) {
  try {
    execFileSync('node', [SCRIPT, '-'], {
      input: message,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

const DUP = 'fix(core): thread distinct through aggregate';

test('rejects a body paragraph starting with name(nested(parens))', () => {
  assert.notEqual(
    exitCode(`${DUP}\n\nfn(name, distinct(field)) routes through the path.`),
    0,
  );
});

test('accepts a clean prose body', () => {
  assert.equal(
    exitCode(`${DUP}\n\nThe distinct flag now routes through the path.`),
    0,
  );
});

test('accepts parentheses used mid-line', () => {
  assert.equal(
    exitCode(`${DUP}\n\nThe .avg(distinct(field)) builder threads the flag.`),
    0,
  );
});

test('rejects even a squash duplicate-header artefact with parens (never ignored)', () => {
  assert.notEqual(
    exitCode(`${DUP}\n\n${DUP}\n\nfn(name, distinct(field)) routes through it.`),
    0,
  );
});

test("accepts release-please's own generated release commit", () => {
  assert.equal(exitCode('chore(release): release main\n\nRelease-As: 1.2.3'), 0);
});

// The script parses the EXACT bytes it is given — it does NOT strip `#` lines
// (git's cleanup is the caller's job: `git stripspace` in the hook, raw `%B` in
// CI). So a committed `#`-prefixed line is real content the parser sees, and a
// parse-breaking one must not be silently hidden.
test('does NOT strip a `#`-prefixed line that breaks the parser', () => {
  assert.notEqual(
    exitCode(`${DUP}\n\n#fn(name, distinct(field)) routes through it.`),
    0,
  );
});

test('accepts a benign `#`-prefixed note (parser tolerates it as body text)', () => {
  assert.equal(
    exitCode(`${DUP}\n\nThe flag threads through.\n#a trailing note`),
    0,
  );
});
