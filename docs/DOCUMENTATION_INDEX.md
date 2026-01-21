---
doc-meta:
  status: canonical
  scope: project
  type: reference
  created: 2026-01-06
  updated: 2026-01-11
---

# Documentation Index

## Project: db-semantic-planner

**Vision:** Semantic query planning for databases - intent-first approach that transforms declarative query intents into optimized SQL with full observability.

**Status:** ✅ v1.0 Ready (1672 unit tests across 4 packages)

## Architecture: Codegen-First (ARCH-002)

```
packages/core           → Schema DSL, DX layer, Planner (DB-agnostic, MUST NOT import adapter)
packages/adapter-kysely → SQL Compiler, Kysely Engine (depends on core)
packages/cli            → dbsp CLI (generate, verify, repl commands)
packages/mcp-server     → MCP Server for AI assistants (depends on core + adapter)
```

## Quick Links

| Category | Document | Status |
|----------|----------|--------|
| Project | [CLAUDE.md](../CLAUDE.md) | canonical |
| Project | [Main Backlog](../TODO.md) | active |
| Project | [**Feature Comparison**](COMPARISON.md) | canonical |
| Project | [MCP Server Brief](briefs/mcp-server.md) | ready |
| Project | [MCP Server Backlog](../TODO_MCP.md) | ready |
| CLI | [**CLI Usage Guide**](CLI_USAGE.md) | canonical |
| Operations | [**Production Deployment**](PRODUCTION.md) | canonical |
| API | [**API Reference**](api/index.html) | generated |
| Core | [Core Overview](plans/core-OVERVIEW.md) | draft |
| Adapter | [Adapter Overview](plans/adapter-OVERVIEW.md) | draft |
| Experience | [Project Experience](../.claude/skills/project-experience/SKILL.md) | canonical |

## By Scope

| Scope | Package | Overview | Backlog | Status |
|-------|---------|----------|---------|--------|
| core | `packages/core` | [Overview](plans/core-OVERVIEW.md) | [TODO](../TODO_CORE.md) | ✅ Complete |
| adapter | `packages/adapter-kysely` | [Overview](plans/adapter-OVERVIEW.md) | [TODO](../TODO_ADAPTER.md) | ✅ Complete |
| cli | `packages/cli` | [CLI Usage](CLI_USAGE.md) | [TODO](../TODO_CLI.md) | ✅ Complete |
| mcp-server | `packages/mcp-server` | [Brief](briefs/mcp-server.md) | [TODO](../TODO_MCP.md) | 🟡 Ready |

**Note:** DX layer (ORM API, filters, query builders) is part of `packages/core/src/dx/` since ARCH-001.
**Note:** Schema DSL (`defineSchema()`, conventions) is part of `packages/core` since ARCH-002 (merged from former `packages/schema`).

## Implementation Specifications

| Spec ID | Title | Scope | Status |
|---------|-------|-------|--------|
| CORE-001 | [ModelIR](specs/CORE-001-model-ir.md) | core | ✅ canonical |
| CORE-002 | IntentAST | core | ✅ implemented (no spec) |
| CORE-003 | [Semantic Planner](specs/CORE-003-semantic-planner.md) | core | ✅ canonical |
| CORE-001-PC | [Planner → Compiler Contract](plans/CORE-001-planner-compiler-contract.md) | core, adapter | ✅ canonical |
| ADAPTER-001 | [Kysely Dump/Compile/Execute](specs/ADAPTER-001-kysely-dump-compile-execute.md) | adapter | ✅ canonical |
| ADAPTER-002 | Multi-tenant | adapter | ✅ implemented (in ADAPTER-001) |
| ADAPTER-004 | [Enhanced Observability](specs/ADAPTER-004-enhanced-observability.md) | adapter | ✅ canonical |
| ADAPTER-006 | [Schema Introspection](specs/ADAPTER-006-schema-introspection.md) | adapter | ✅ canonical |
| DX-001 | [Strict Mode](specs/DX-001-strict-mode.md) | dx | ✅ canonical |
| DX-003 | [Compat Layer (legacy)](historic/DX-003-compat-layer-legacy.md) | dx | ⚠️ deprecated (API-001) |
| DX-004 | dump()/execute() API | dx | ✅ in E2E-001 |
| E2E-001 | [PostgreSQL Validation](specs/E2E-001-postgresql-validation.md) | testing | ✅ canonical |
| STREAMING-001 | [Cursor/Streaming Support](specs/STREAMING-001-cursor-support.md) | adapter, dx | ✅ canonical |
| DIALECT-001 | [Multi-dialect Capabilities](specs/DIALECT-001-multi-dialect-capabilities.md) | adapter | ✅ canonical |
| TEST-001 | [SQL Snapshot Testing](specs/TEST-001-sql-snapshot-utilities.md) | testing | ✅ canonical |
| E2E-002 | [PIM/DAM Realistic Scenarios](specs/E2E-002-pimdam-realistic-scenarios.md) | e2e | ✅ canonical |
| ARCH-001 | [Dialect-Agnostic Recursive CTE](specs/ARCH-001-dialect-agnostic-recursive.md) | core, adapter | ✅ canonical |
| DX-005 | [Recursive Query Builder](specs/DX-005-recursive-query-builder.md) | dx | ✅ canonical |
| DX-010 | [Mutations (insert/update/delete)](specs/DX-010-mutations.md) | dx | ✅ canonical |
| DX-012 | [API Ergonomics](specs/DX-012-api-ergonomics.md) | dx | ✅ canonical |
| DX-023 | [Lightweight ModelIR](plans/DX-023-lightweight-modelir.md) | dx | 🟡 draft |
| DX-021 | [Window Functions Builder](plans/DX-021-window-builder.md) | dx | ✅ canonical |
| DX-022 | [Recursive via include()](plans/DX-022-recursive-include.md) | dx | ✅ canonical |
| P3-A | [Window Functions](specs/P3-A-window-functions.md) | core, adapter, dx | ✅ canonical |
| ARCH-002 | [One Ring Architecture](specs/ARCH-002-one-ring.md) | schema, cli, core | ✅ canonical |
| CLI-NQL | [Natural Query Language v1.0](plans/CLI-NQL-natural-query-language.md) | cli | ✅ canonical |

## Golden Query Tests - ✅ Complete

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
| Primary DB | PostgreSQL | Primary focus |
| Adapter | Kysely | Peer dependency |
| Testing | Vitest | Golden tests |
| Build | tsup | ESM + CJS |

## Completed Phases

### Foundation - ✅ Complete

- ✅ ModelIR schema definition with planning hints (29 tests)
- ✅ IntentAST query types with type guards (35 tests)
- ✅ Semantic planner (EXISTS vs JOIN, CTE extraction) (29 tests)
- ✅ SQL compilation via Kysely (59 tests)
- ✅ Multi-tenant (schema prefix support)
- ✅ Observability (`createDump()` returning plan + sql + params)
- ✅ 3 golden-query acceptance tests (Q1, Q2, Q3 = 18 tests)

### Developer Experience - ✅ Complete

- ✅ Strict ambiguity mode + override API
- ✅ EXPLAIN/ANALYZE support
- ✅ Structured logging with correlation
- ✅ Parameter redaction for logs
- ✅ Drizzle-like compat helpers (eq/and/or, all/first)
- ✅ DX layer merged into core (ARCH-001)

### Multi-Dialect - ✅ Complete

- ✅ **DIALECT-001**: Multi-dialect Capabilities ([spec](specs/DIALECT-001-multi-dialect-capabilities.md))
  - DialectCapabilities interface and detection (42 tests)
  - Multi-tenant capability guard (14 tests)
  - EXPLAIN dialect adaptation (10 tests)
  - Streaming capability guard (12 tests)
  - Cross-dialect test helpers (12 tests)

## Out of Scope

These features are intentionally deferred and may become backlog items:

- Cost-based optimization
- Join reordering
- NL-to-SQL / AI query generation
- Multi-dialect correctness guarantees (PostgreSQL-focused)
- Full ORM behavior (change tracking, dirty checking)

**Note:** Runtime schema introspection was added in ADAPTER-006.

## Briefs (Ideation)

| Brief ID | Title | Scope | Status |
|----------|-------|-------|--------|
| ARCH-002 | [One Ring Architecture](briefs/ARCH-002-one-ring.md) | schema, cli, core | ✅ implemented |

## ADRs (Architecture Decision Records)

| ADR ID | Title | Scope | Status |
|--------|-------|-------|--------|
| ADR-001 | [Typed Intents for Advanced Features](adrs/ADR-001-typed-intents-for-advanced-features.md) | core, adapter, dx | ✅ accepted |
| ADR-002 | [Merge dx Package into core](adrs/ADR-002-merge-dx-into-core.md) | core, dx, adapter | ✅ accepted |
| ADR-003 | [CLI REPL Framework Selection](adrs/ADR-003-cli-repl-framework.md) | cli | ✅ accepted |
| ADR-004 | [Core Package Layered Structure](adrs/ADR-004-core-package-layered-structure.md) | core | ✅ accepted |

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
