---
doc-meta:
  status: canonical
  scope: project
  type: reference
  created: 2026-01-06
  updated: 2026-01-06
---

# Documentation Index

## Project: db-semantic-planner

**Vision:** Semantic query planning for databases - intent-first approach that transforms declarative query intents into optimized SQL with full observability.

## Architecture: Ports & Adapters

```
packages/core          → DB-agnostic (MUST NOT import adapter)
packages/adapter-kysely → Depends on core
packages/dx            → Depends on core + adapter-kysely
```

## Quick Links

| Category | Document | Status |
|----------|----------|--------|
| Project | [CLAUDE.md](../CLAUDE.md) | canonical |
| Project | [Main Backlog](../TODO.md) | active |
| Core | [Core Overview](plans/core-OVERVIEW.md) | draft |
| Adapter | [Adapter Overview](plans/adapter-OVERVIEW.md) | draft |
| DX | [DX Overview](plans/dx-OVERVIEW.md) | draft |
| Experience | [Project Experience](../.claude/skills/project-experience/SKILL.md) | canonical |

## By Scope

| Scope | Package | Overview | Backlog | Phase |
|-------|---------|----------|---------|-------|
| core | `packages/core` | [Overview](plans/core-OVERVIEW.md) | [TODO](../TODO_CORE.md) | MVP |
| adapter | `packages/adapter-kysely` | [Overview](plans/adapter-OVERVIEW.md) | [TODO](../TODO_ADAPTER.md) | MVP |
| dx | `packages/dx` | [Overview](plans/dx-OVERVIEW.md) | [TODO](../TODO_DX.md) | P1 |

## Implementation Specifications

| Spec ID | Title | Scope | Status |
|---------|-------|-------|--------|
| CORE-001 | [ModelIR](specs/CORE-001-model-ir.md) | core | draft |
| ADAPTER-001 | [Kysely Dump/Compile/Execute](specs/ADAPTER-001-kysely-dump-compile-execute.md) | adapter | draft |
| CORE-002 | IntentAST | core | planned |
| CORE-003 | Semantic Planner | core | planned |
| ADAPTER-002 | Multi-tenant | adapter | planned |
| DX-001 | Strict Mode | dx | planned |

## Golden Query Tests (MVP Contract)

| Test | Description | Key Validation | Spec |
|------|-------------|----------------|------|
| Q1 | Filter to-many → EXISTS | filter-strategy: exists | [core](plans/core-OVERVIEW.md#q1-filter-to-many--exists) |
| Q2 | Coverage by category → CTE | cte-extraction | [adapter](plans/adapter-OVERVIEW.md#q2-coverage-by-category--cte--ratio) |
| Q3 | Strict mode ambiguity | AmbiguousRelationError | [dx](plans/dx-OVERVIEW.md#golden-query-test-q3-strict-mode-ambiguity) |
| Q4 | Multi-tenant schema | forTenant → withSchema | [adapter](plans/adapter-OVERVIEW.md#q4-multi-tenant-schema-per-tenant) |

## Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Language | TypeScript | Strict mode |
| Runtime | Node.js | ESM preferred |
| Primary DB | PostgreSQL | MVP only |
| Adapter | Kysely | Peer dependency |
| Testing | Vitest | Golden tests |
| Build | tsup | ESM + CJS |

## Phases

### P0 (MVP) - End-to-end vertical slice

- ModelIR schema definition with planning hints
- IntentAST query builder with exists() filter
- Semantic planner (EXISTS vs JOIN, CTE extraction)
- SQL compilation via Kysely
- Multi-tenant (`orm.forTenant()`)
- Observability (`dump()` returning plan + sql + params)
- 3 golden-query acceptance tests

### P1 - Developer Experience

- Strict ambiguity mode + override API
- EXPLAIN/ANALYZE support
- Structured logging with correlation
- Parameter redaction for logs
- Drizzle-like compat helpers (eq/and/or, findMany/findFirst)

### P2 - Multi-Dialect

- DialectCapabilities interface
- Capability-gated strategy selection
- MySQL, SQLite, MSSQL profiles
- Cross-dialect acceptance suite

## MVP Non-Goals

- No cost-based optimization
- No join reordering
- No runtime schema introspection
- No NL-to-SQL
- No multi-dialect correctness (PostgreSQL only)
- No change tracking / dirty checking

## Archived

See [docs/historic/](historic/) for deprecated documentation.
