# Contributing to db-semantic-planner

Thank you for your interest in contributing! This guide covers everything you need to get started, from setting up the project locally to getting your pull request merged.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [First-time setup](#first-time-setup)
- [Project structure](#project-structure)
- [Making changes](#making-changes)
- [Testing](#testing)
- [Code style](#code-style)
- [Pull request process](#pull-request-process)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please read it before participating. Be respectful and constructive in all interactions.

## First-time setup

### Prerequisites

- Node.js 22 or later
- pnpm 9 or later (`npm install -g pnpm`)
- Docker or Podman (only required for E2E tests that run against a real PostgreSQL instance)

### Fork and clone

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/db-semantic-planner.git
cd db-semantic-planner

# Add the upstream remote so you can pull future updates
git remote add upstream https://github.com/oorabona/db-semantic-planner.git
```

### Install dependencies and build

```bash
# Install all workspace dependencies
pnpm install

# Build packages in the correct order (core first, then adapter-pgsql)
pnpm build
```

> **Why build first?** Unit tests import source directly and do not need a build. However, E2E tests and the CLI import from compiled `dist/` directories. Skipping the build causes "module has no exported member" errors in those cases.

### Verify everything works

```bash
# Run unit tests across all packages
pnpm test:unit

# Run type checking
pnpm typecheck

# Run linter
pnpm lint
```

## Project structure

```
packages/
  types/          Shared TypeScript contracts (Adapter, ModelIR, IntentAST, PlanReport)
  core/           Schema DSL, query builders, planner — fully DB-agnostic
  adapter-pgsql/  PostgreSQL adapter: SQL compiler + direct pg Pool execution
  nql/            Natural query language parser (Chevrotain) -> IntentAST
  cli/            dbsp CLI (generate, verify, repl)
  mcp-server/     MCP server for editor integrations
  gui/            Desktop GUI (Tauri + React, private — not published to npm)
  docs/           VitePress site source for https://oorabona.github.io/db-semantic-planner/
                  (private — not published to npm; name @dbsp/docs is a workspace
                   identifier only). Contains all user-facing documentation:
                     - guide/            How-to guides and core concepts
                     - api/              API reference
                     - nql/              NQL reference
                     - {index,comparison,patterns,roadmap,demo,playground}.md
```

### Docs authoring

Documentation lives entirely in `packages/docs/`. To run the site locally:

```bash
# Site URL / base must be set; for local dev, any placeholder value works
export SITE_URL=http://localhost:5173
export SITE_BASE=/

pnpm -C packages/docs dev       # localhost:5173, hot reload
pnpm -C packages/docs build     # production build (writes to dist/)
pnpm -C packages/docs preview   # preview the build
```

In CI, `SITE_URL` and `SITE_BASE` come from repository Variables (Settings →
Secrets and variables → Actions → Variables). The default values are:
- `SITE_URL=https://oorabona.github.io/db-semantic-planner`
- `SITE_BASE=/db-semantic-planner/`

When the site moves to a custom domain, update these two variables — the
`config.ts` reads them with no fallback so build failure makes the
misconfiguration immediately visible.

### Docs verification (doctest)

Every `typescript` / `ts` code block in the docs is extracted by the framework
in `tests/docs-verification/`. Blocks that are not skipped, deferred to the
real-DB workflow, or rejected as fragments are parsed, dynamically imported,
and executed. A parse error, import failure, or runtime throw fails CI; the
harness does not type-check code blocks.

Run locally:

```bash
pnpm test:docs                 # regenerate + run the full suite
pnpm test:docs:generate        # just regenerate __generated__/ test files
```

**Annotations** (place inside the block as a `//` comment):

| Annotation | Effect |
|------------|--------|
| `// doctest: skip — <reason>` | Skip the block. The ledger requires a reason and `pnpm check:docs-ledger` reports its count. |
| `// doctest: real-db-only — <reason>` | Skip in compile-only mode; the real-DB workflow runs it unless the fragment heuristic rejects it. The ledger requires a reason. |

`// doctest: real-db-only — <reason>` is the correct annotation for blocks that call `.all()`, `.execute()`, `.stream()`, `.transaction()`, or DDL helpers (`.truncate()`, `.vacuum()`, `.indexes.create()`, etc.) — any block that requires a live PostgreSQL connection. Use `// doctest: skip — <reason>` only for blocks that cannot execute even with a real DB (pseudo-code, API-signature fragments, or blocks referencing tables not in the default schema).

**When to use `real-db-only`:**
- Block calls `.all()`, `.execute()`, `.stream()`, `.transaction()`, or any DDL
  helper that requires a live PostgreSQL connection.
- The block uses tables from the default schema (`users`, `posts`, `comments`,
  `categories`, `documents`). Blocks referencing other tables should use
  `// doctest: skip — <reason>` instead.

**When to skip:**
- Block is a type signature / pseudo-code / fragment that is not meant to
  execute in isolation (e.g. `orm.tables.users.truncate(options?)`).
- Block demonstrates a production application pattern (full web server,
  long-lived daemon) that cannot be expressed as a standalone snippet.
- Block references tables or helpers not available in the default preamble schema.

**Running the real-DB doctest suite locally:**

```bash
# Start a local PostgreSQL container (podman or docker)
podman run -d --name dbsp-doctest -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=doctest \
  ghcr.io/oorabona/postgres:18-alpine-full

# Run the real-DB suite
DBSP_DOCTEST_REAL_DB=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/doctest \
  pnpm test:docs

# Cleanup
podman stop dbsp-doctest && podman rm dbsp-doctest
```

**When to un-skip:** if you widen the runner preamble in
`tests/docs-verification/runner.ts` to expose more symbols or tables, audit
existing skips to see if any of them were only there because the preamble
was too narrow.

### Architecture rule (strict)

`packages/core` must remain **DB-agnostic**. It may not import anything from `packages/adapter-pgsql` or any other adapter. The dependency flows one way:

```
types  <--  core  <--  adapter-pgsql  <--  cli
```

If you are unsure whether a change belongs in `core` or `adapter-pgsql`, put the interface in `core` and the implementation in `adapter-pgsql`.

## Making changes

### Branching

Create a branch from `main` before making any changes:

```bash
git checkout -b feat/my-feature
```

Prefix conventions:

| Prefix | When to use |
|--------|-------------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `refactor/` | Refactoring without behavior change |
| `docs/` | Documentation only |
| `test/` | Test additions or fixes |

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body explaining why, not what]

[optional footer: breaking changes, issue refs]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

Scopes: `core`, `adapter`, `cli`, `nql`, `mcp-server`, `gui`, `docs`, `e2e`

Examples:

```
feat(core): add recursive CTE builder
fix(adapter-pgsql): handle NULL in COALESCE expressions
refactor(core): extract filter helpers to shared module
docs(docs): add how-to guide for RLS policies
test(adapter-pgsql): add golden tests for DISTINCT ON queries
```

Commit messages are validated by a CI workflow (`commitlint`) on every
pull request. Scope is **required** and must match one of:
`types`, `nql`, `core`, `adapter-pgsql`, `cli`, `mcp-server`, `gui`, `docs`,
`release`, `deps`, `deps-dev`, `ci`, `build`, `repo`.

### Local commit hooks

Running `pnpm install` automatically wires up two git hooks via [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks):

> **If `pnpm install` was run with `--ignore-scripts`** (or your global pnpm
> config disables lifecycle scripts), the hooks won't install automatically.
> Run `pnpm run prepare` (or `pnpm exec simple-git-hooks`) once to set them
> up.

- **pre-commit** rebuilds the per-package `dist/` artifacts when source
  files in any of the library packages (`types`, `core`, `nql`,
  `adapter-pgsql`) are staged. The build acts as a smoke test: if it
  fails the commit is blocked. `dist/` itself is gitignored — the
  rebuild is for local workspace consumers (e.g. `cli`, `mcp-server`,
  `gui`) and as a fast feedback signal that source compiles cleanly.
- **commit-msg** validates the commit message against
  `commitlint.config.mjs` (Conventional Commits, scope-enum, body/footer
  rules) — this mirrors what CI enforces — then runs the local
  release-please parseability guard (see the parentheses watchpoint
  below). Local validation gives fast feedback before push.

CI is authoritative: even if you bypass the local hook with
`git commit --no-verify`, the `commitlint` GitHub Action will catch any
violation on push.

**Watchpoint — footer-leading-blank trap.** Commitlint's parser treats
lines like `PR #42` or `fixes #42` as footer references. If such a line
appears in the commit body without a blank line before it, the rule
`footer-leading-blank` rejects the commit. To avoid this:
- Move the reference to a real footer with a blank line before it, OR
- Rephrase to break the `<word> #<digits>` shape (e.g. `PR 42`, `the prior PR`).

**Watchpoint — parentheses in the body.** release-please parses each merged
commit with its own grammar (`@conventional-commits/parser`), and a commit it
cannot parse is **silently skipped** — no release PR is cut. A body line that
**starts** with `name(...)` containing nested parentheses trips this
(e.g. a paragraph beginning `fn(name, distinct(field)) routes through …`).
A standalone guard (`scripts/check-release-please-parseable.mjs`, run by the
commit-msg hook) rejects such a message locally. Keep commit **bodies** free of
code-like parenthesised snippets — put runnable examples in the PR description
instead. (Parentheses mid-line, like `the .avg(distinct(field)) builder`, are
fine.)

**Optional: chain a personal commit-msg hook.** If you have a global
commit-msg validation script (e.g. one shared across multiple repos),
opt in by exporting `DBSP_GLOBAL_COMMIT_MSG_HOOK` to its absolute
path before committing:

```sh
export DBSP_GLOBAL_COMMIT_MSG_HOOK="$HOME/path/to/your/commit-msg-hook.sh"
```

The repo's commit-msg hook will run yours first, then the project's
commitlint validation and the release-please parseability guard. Without
the env var, only the project checks run.

### Rebuilding after source changes

Whenever you modify source files, rebuild the affected package before running E2E tests or the CLI:

```bash
# Modified packages/core/src/?
pnpm -C packages/core build

# Modified packages/adapter-pgsql/src/?
pnpm -C packages/adapter-pgsql build

# Modified both? Build in order:
pnpm -C packages/core build && pnpm -C packages/adapter-pgsql build
```

## Testing

### Running tests

```bash
# Unit tests only (fast, no database required)
pnpm test:unit

# E2E tests (requires Docker or Podman — starts a real PostgreSQL container)
pnpm test:e2e

# Both (equivalent to pnpm test)
pnpm test

# Single package
pnpm --filter @dbsp/core test

# Watch mode during development
pnpm --filter @dbsp/core test -- --watch
```

### E2E test prerequisites

E2E tests use [Testcontainers](https://testcontainers.com/) to spin up a real PostgreSQL instance. You need Docker or Podman running. On WSL2 with Podman, set:

```bash
export TESTCONTAINERS_RYUK_DISABLED=true
```

### What tests to write

| Change type | Required tests |
|-------------|----------------|
| New query feature | Unit test in the relevant package + golden test for SQL output |
| Bug fix | Regression test that fails before the fix and passes after |
| New SQL generation pattern | E2E test against a real PostgreSQL instance |
| Utility / helper function | Unit test for all branches |

Test files live next to the source they cover (`*.test.ts`). Error-path tests go in a separate `*.errors.test.ts` file.

### SQL assertions

When asserting on generated SQL, always compare the **full SQL string**:

```typescript
// Correct — catches any unexpected change
expect(result.sql).toEqual('SELECT "id", "name" FROM "users" WHERE "active" = $1');

// Wrong — only checks a fragment, masks bugs
expect(result.sql).toContain('"users"');
```

## Code style

### TypeScript

- Strict mode is enabled; the compiler will reject unsafe patterns
- Explicit return types for all public API functions
- No `any` without a comment explaining why it is unavoidable
- Prefer `readonly` for data that should not be mutated after creation
- Use `type` for simple type aliases; use `interface` only when declaration merging is needed

### Formatting and linting

The project uses [Biome](https://biomejs.dev/) for both formatting and linting.

```bash
# Check (no changes written)
pnpm lint

# Auto-fix everything
pnpm lint:fix
```

Biome is configured in `biome.json` at the project root. Do not bypass its rules with inline disables without a clear comment.

### Adapter code rules

The PostgreSQL adapter compiles the query plan AST into parameterized SQL. When contributing to `packages/adapter-pgsql`:

- All user-supplied values must go through positional parameters (`$1`, `$2`, ...) — never interpolated into the SQL string
- All identifiers (table names, column names, schema names) must be double-quoted
- Do not build SQL by string concatenation; extend the AST compiler instead

## Pull request process

1. Make sure all checks pass locally before opening a PR:

   ```bash
   pnpm test:unit && pnpm lint && pnpm typecheck
   ```

2. Open the pull request against the `main` branch with a clear title and description. Explain **what** changed and **why**.

3. Fill in the PR checklist:

   - [ ] Unit tests added or updated and passing
   - [ ] `pnpm lint` passes with no errors
   - [ ] `pnpm typecheck` passes with no errors
   - [ ] Documentation updated if the change affects public API or behavior
   - [ ] Commit messages follow the Conventional Commits convention

4. Respond to review comments. If you disagree with a suggestion, explain your reasoning — discussion is welcome.

5. Once approved, a maintainer will squash-merge your branch into `main`.

## Questions and discussions

- **Bug reports and feature requests:** Open an [issue](../../issues)
- **Questions and ideas:** Start a [discussion](../../discussions)

Thank you for contributing!
