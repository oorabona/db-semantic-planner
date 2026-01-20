# Contributing to db-semantic-planner

Thank you for considering contributing to db-semantic-planner! This document outlines the process for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project follows a standard code of conduct. Please be respectful and constructive in all interactions.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/db-semantic-planner.git`
3. Add upstream remote: `git remote add upstream https://github.com/your-org/db-semantic-planner.git`

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker or Podman (for E2E tests)

### Installation

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Project Structure

```
packages/
  core/           → Schema DSL, DX layer, Planner (DB-agnostic)
  adapter-kysely/ → SQL Compiler, Kysely Engine
  cli/            → dbsp CLI (generate, verify, repl)
  mcp-server/     → MCP Server for AI assistants
docs/
  specs/          → Implementation specifications
  plans/          → Design documents
  adrs/           → Architecture Decision Records
```

### Architecture Rules (STRICT)

| Package | May Import | Must NOT Import |
|---------|------------|-----------------|
| `packages/core` | Nothing | `adapter-kysely` |
| `packages/adapter-kysely` | `core` | - |

**Core must remain DB-agnostic.** Never add SQL or Kysely imports to core.

## Making Changes

### Branch Naming

- `feat/description` - New features
- `fix/description` - Bug fixes
- `refactor/description` - Code refactoring
- `docs/description` - Documentation only
- `test/description` - Test additions/fixes

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

**Scopes:** `core`, `adapter`, `cli`, `mcp-server`, `docs`, `e2e`

**Examples:**
```
feat(core): add recursive CTE support
fix(adapter): handle NULL in COALESCE expressions
refactor(core,adapter): clarify ambiguous function names
docs(specs): add STREAMING-001 cursor support spec
```

## Testing

### Running Tests

```bash
# All tests
pnpm test

# Specific package
pnpm --filter @dbsp/core test

# E2E tests (requires Docker/Podman)
pnpm test:e2e

# Watch mode
pnpm test -- --watch
```

### Test Requirements

- **Unit tests:** Required for all new features
- **Golden tests:** Required for query behavior changes
- **E2E tests:** Required for new SQL generation patterns

### Test Locations

| Package | Unit Tests | Integration Tests |
|---------|------------|-------------------|
| core | `packages/core/src/**/*.test.ts` | - |
| adapter | `packages/adapter-kysely/src/**/*.test.ts` | `packages/adapter-kysely/e2e/` |
| cli | `packages/cli/src/**/*.test.ts` | `packages/cli/e2e/` |

## Code Style

### TypeScript

- Strict mode enabled
- Explicit return types for public APIs
- No `any` without justification
- Prefer `readonly` for immutable data

### Formatting

```bash
# Check formatting
pnpm biome check

# Auto-fix
pnpm biome check --write
```

### Principles

- **SOLID:** Single responsibility, open/closed, etc.
- **DRY:** Don't repeat yourself
- **KISS:** Keep it simple

### Adapter Code Rules

**Never use raw SQL templates in adapter code.** Use Kysely's expression builder:

```typescript
// DON'T
sql`COALESCE(${col}, ${default})`

// DO
eb.fn('coalesce', [eb.ref(col), eb.lit(default)])
```

## Pull Request Process

1. **Update tests:** Add/update tests for your changes
2. **Run CI locally:** `pnpm test && pnpm biome check`
3. **Update docs:** If applicable, update relevant documentation
4. **Create PR:** Use the PR template
5. **Address feedback:** Respond to review comments

### PR Checklist

- [ ] Tests added/updated and passing
- [ ] Lint/format passes (`pnpm biome check`)
- [ ] TypeScript compiles without errors
- [ ] Documentation updated (if applicable)
- [ ] CHANGELOG.md updated (for user-facing changes)
- [ ] Commit messages follow convention

### Review Process

1. Automated checks must pass
2. At least one maintainer approval required
3. All conversations resolved
4. Squash merge preferred for clean history

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions or ideas

Thank you for contributing!
