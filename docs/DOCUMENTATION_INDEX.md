---
doc-meta:
  status: canonical
  scope: project
  type: reference
  created: 2026-01-06
  updated: 2026-01-08
---

# Documentation Index

## Project: db-semantic-planner

**Vision:** Semantic query planning for databases - intent-first approach that transforms declarative query intents into optimized SQL with full observability.

**Status:** MVP ✅ Complete + P1 ✅ Complete + P2 ✅ Complete (736 unit + 87 E2E = 823 tests)

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
| CORE-001 | [ModelIR](specs/CORE-001-model-ir.md) | core | ✅ canonical |
| CORE-002 | IntentAST | core | ✅ implemented (no spec) |
| CORE-003 | [Semantic Planner](specs/CORE-003-semantic-planner.md) | core | ✅ canonical |
| ADAPTER-001 | [Kysely Dump/Compile/Execute](specs/ADAPTER-001-kysely-dump-compile-execute.md) | adapter | ✅ canonical |
| ADAPTER-002 | Multi-tenant | adapter | ✅ implemented (in ADAPTER-001) |
| ADAPTER-004 | [Enhanced Observability](specs/ADAPTER-004-enhanced-observability.md) | adapter | ✅ canonical |
| ADAPTER-006 | [Schema Introspection](specs/ADAPTER-006-schema-introspection.md) | adapter | ✅ canonical |
| DX-001 | [Strict Mode](specs/DX-001-strict-mode.md) | dx | ✅ canonical |
| DX-003 | [Compat Layer](specs/DX-003-compat-layer.md) | dx | ✅ canonical |
| DX-004 | dump()/execute() API | dx | ✅ in E2E-001 |
| E2E-001 | [PostgreSQL Validation](specs/E2E-001-postgresql-validation.md) | testing | ✅ canonical |
| STREAMING-001 | [Cursor/Streaming Support](specs/STREAMING-001-cursor-support.md) | adapter, dx | ✅ canonical |
| DIALECT-001 | [Multi-dialect Capabilities](specs/DIALECT-001-multi-dialect-capabilities.md) | adapter | ✅ canonical |
| TEST-001 | [SQL Snapshot Testing](specs/TEST-001-sql-snapshot-utilities.md) | testing | ✅ canonical |
| E2E-002 | [PIM/DAM Realistic Scenarios](specs/E2E-002-pimdam-realistic-scenarios.md) | e2e | 🟡 draft |
| ARCH-001 | [Dialect-Agnostic Recursive CTE](specs/ARCH-001-dialect-agnostic-recursive.md) | core, adapter | 🟡 draft |
| DX-005 | [Recursive Query Builder](specs/DX-005-recursive-query-builder.md) | dx | 🟡 draft |
| DX-010 | [Mutations (insert/update/delete)](specs/DX-010-mutations.md) | dx | ✅ canonical |
| DX-012 | [API Ergonomics](specs/DX-012-api-ergonomics.md) | dx | 🟡 draft |

## Golden Query Tests (MVP Contract) - ✅ Complete

| Test | Description | Key Validation | Status | Tests |
|------|-------------|----------------|--------|-------|
| Q1 | Filter to-many → EXISTS | filter-strategy: exists | ✅ | 6 |
| Q2 | Coverage by category → CTE | cte-extraction | ✅ | 5 |
| Q3 | Strict mode ambiguity | AmbiguousPlanError | ✅ | 7 |

## E2E Golden Tests (Real PostgreSQL) - ✅ Complete

| Test | Description | Key Validation | Status | Tests |
|------|-------------|----------------|--------|-------|
| Q1-E2E | Products with approved FR image | Real PostgreSQL EXISTS | ✅ | 7 (3 todo) |
| Q2-E2E | Multi-locale images (CTE extraction) | Real PostgreSQL CTE | ✅ | 8 (3 todo) |
| Q4 | Multi-tenant isolation | Schema qualification | ✅ | 9 |
| Q5 | Blog scenario | Basic E2E validation | ✅ | 12 (3 todo) |
| EXPLAIN | EXPLAIN/ANALYZE integration | Real PostgreSQL EXPLAIN | ✅ | 12 |
| Benchmarks | Query performance | Compilation/execution metrics | ✅ | 8 |
| Streaming | Cursor/streaming support | AsyncIterableIterator | ✅ | 14 |
| Infrastructure | Container lifecycle | Testcontainers | ✅ | 5 |

**Note:** 9 tests marked as `.todo()` due to known EXISTS schema prefix bug (F-001).

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

### P0 (MVP) - ✅ Complete

- ✅ ModelIR schema definition with planning hints (29 tests)
- ✅ IntentAST query types with type guards (35 tests)
- ✅ Semantic planner (EXISTS vs JOIN, CTE extraction) (29 tests)
- ✅ SQL compilation via Kysely (59 tests)
- ✅ Multi-tenant (schema prefix support)
- ✅ Observability (`createDump()` returning plan + sql + params)
- ✅ 3 golden-query acceptance tests (Q1, Q2, Q3 = 18 tests)

### P1 - Developer Experience

- Strict ambiguity mode + override API
- EXPLAIN/ANALYZE support
- Structured logging with correlation
- Parameter redaction for logs
- Drizzle-like compat helpers (eq/and/or, findMany/findFirst)

### P2 - Multi-Dialect ✅ Complete

- ✅ **DIALECT-001**: Multi-dialect Capabilities ([spec](specs/DIALECT-001-multi-dialect-capabilities.md))
  - DialectCapabilities interface and detection (42 tests)
  - Multi-tenant capability guard (14 tests)
  - EXPLAIN dialect adaptation (10 tests)
  - Streaming capability guard (12 tests)
  - Cross-dialect test helpers (12 tests)

## MVP Non-Goals

- No cost-based optimization
- No join reordering
- ~~No runtime schema introspection~~ → Added in P2 (ADAPTER-006)
- No NL-to-SQL
- No multi-dialect correctness (PostgreSQL only)
- No change tracking / dirty checking

## RFCs (Request for Comments)

| RFC ID | Title | Scope | Status |
|--------|-------|-------|--------|
| RFC-001 | [Recursive CTE Support](rfcs/RFC-001-recursive-cte.md) | core, adapter | ✅ canonical |

## Studies

| Study ID | Title | Scope | Status |
|----------|-------|-------|--------|
| STUDY-001 | [Advanced PostgreSQL Features](studies/STUDY-001-advanced-postgresql-features.md) | adapter | 📚 reference |

## Security Reports

| Report | Date | Verdict | Findings |
|--------|------|---------|----------|
| [Security Audit 2026-01-08](reports/SECURITY_AUDIT_2026-01-08.md) | 2026-01-08 | ✅ SECURE | 0 critical, 0 high, 0 medium |
| [Security Audit 2026-01-07](reports/SECURITY_AUDIT_2026-01-07.md) | 2026-01-07 | ✅ SECURE | - |

## Archived

See [docs/historic/](historic/) for deprecated documentation.
