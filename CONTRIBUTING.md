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

- Node.js 20 or later
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
pnpm -C packages/docs dev      # localhost:5173, hot reload
pnpm -C packages/docs build    # production build (writes to dist/)
pnpm -C packages/docs preview  # preview the build
```

Code blocks inside `.md` files are validated by the doctest harness in
`tests/docs-verification/` on every CI run. When adding a code block:

- Use `typescript` or `ts` for validated TypeScript blocks
- Annotate expected SQL output inline for pedagogical blocks:
  ```typescript
  const result = orm.select('users').where(eq('id', 1)).dump();
  // expected sql: SELECT "u".* FROM "users" "u" WHERE "u"."id" = $1
  // expected params: [1]
  ```
- Blocks without annotations are snapshotted. If you legitimately change
  an API, update snapshots with `pnpm vitest run tests/docs-verification/ -u`.

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

**Optional local hook** — if you want fast feedback at commit time instead
of waiting for CI, install a client-side hook:

```bash
pnpm add -D -w @commitlint/cli @commitlint/config-conventional simple-git-hooks
pnpm pkg set "simple-git-hooks.commit-msg"="pnpm exec commitlint --edit \$1"
pnpm exec simple-git-hooks
```

This is purely optional — the CI enforcement is authoritative.

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
