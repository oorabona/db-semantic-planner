---
doc-meta:
  status: draft
  scope: adapter
  type: plan
  created: 2026-01-07
  updated: 2026-01-07
---

# ADAPTER-001 + ADAPTER-003 Implementation Plan

## Overview

Implement SQL compilation from `PlanReport` to Kysely queries with full observability.

**Spec:** [ADAPTER-001-kysely-dump-compile-execute.md](../specs/ADAPTER-001-kysely-dump-compile-execute.md)

---

## Implementation Blocks

### Block 1: Package Setup & Types
**Files:** `packages/adapter-kysely/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`

- [ ] Create `packages/adapter-kysely` directory
- [ ] Create `package.json` with dependencies (kysely, @dbsp/core)
- [ ] Create `tsconfig.json` extending root
- [ ] Define `Dump`, `DumpMeta` interfaces
- [ ] Define `InvalidIdentifierError`, `NotFoundError` classes
- [ ] Export types from `index.ts`

**Test:** Types compile without errors

### Block 2: SQL Compiler - Basic SELECT
**Files:** `src/compiler.ts`, `src/compiler.test.ts`

- [ ] Create `KyselyCompiler` class
- [ ] Implement `compile(plan: PlanReport, kysely: Kysely): CompiledQuery`
- [ ] Generate basic SELECT with deterministic aliasing (t0)
- [ ] Handle `select: { type: 'all' }` → `SELECT "t0".*`
- [ ] Handle `select: { type: 'fields', fields }` → `SELECT "t0"."col1", ...`

**Test:** Basic SELECT generates expected SQL

### Block 3: WHERE Clause Compilation
**Files:** `src/compiler.ts`, `src/compiler.test.ts`

- [ ] Implement `compileWhere(where: WhereIntent, alias: string)`
- [ ] Handle comparison operators (eq, neq, gt, gte, lt, lte)
- [ ] Handle string operators (like)
- [ ] Handle array operators (in)
- [ ] Handle null operators (isNull, isNotNull)
- [ ] Handle logical operators (and, or, not)
- [ ] Parameter binding in order ($1, $2, $3...)

**Test:** WHERE clauses generate correct SQL with parameters

### Block 4: EXISTS Subquery (Q1)
**Files:** `src/compiler.ts`, `src/compiler.test.ts`

- [ ] Implement EXISTS subquery generation
- [ ] Handle `exists` WhereIntent kind
- [ ] Handle `notExists` WhereIntent kind
- [ ] Handle `relationFilter` with mode (some/every/none)
- [ ] Nested WHERE in subquery

**Test:** Q1 golden test - EXISTS for to-many filter

### Block 5: JOIN Generation
**Files:** `src/compiler.ts`, `src/compiler.test.ts`

- [ ] Implement JOIN based on plan decisions
- [ ] LEFT JOIN for `join-type: left`
- [ ] INNER JOIN for `join-type: inner`
- [ ] Deterministic alias for joined tables (t1, t2...)
- [ ] Handle include with nested relations

**Test:** JOINs generate correct SQL with proper aliases

### Block 6: CTE Generation (Q2)
**Files:** `src/compiler.ts`, `src/compiler.test.ts`

- [ ] Implement CTE extraction from `plan.ctes`
- [ ] Generate WITH clause
- [ ] Reference CTEs in main query
- [ ] Handle multiple CTEs

**Test:** Q2 golden test - CTE extraction for ratios

### Block 7: Integration - Dump API
**Files:** `src/dump.ts`, `src/dump.test.ts`

- [ ] Create `createDump(intent, model, kysely, options): Dump`
- [ ] Integrate planner (from core)
- [ ] Integrate compiler
- [ ] Add metadata (compiledAt, etc.)

**Test:** Full pipeline produces valid Dump

### Block 8: Export & Documentation
**Files:** `src/index.ts`, `README.md`

- [ ] Export all public types and functions
- [ ] Add JSDoc comments
- [ ] Update TODO_ADAPTER.md

**Test:** All exports accessible, typecheck passes

---

## Test Mapping

| Block | Test File | Key Tests |
|-------|-----------|-----------|
| 1 | types compile | Type definitions valid |
| 2 | compiler.test.ts | Basic SELECT |
| 3 | compiler.test.ts | WHERE clauses |
| 4 | compiler.test.ts | Q1: EXISTS subquery |
| 5 | compiler.test.ts | JOINs |
| 6 | compiler.test.ts | Q2: CTE generation |
| 7 | dump.test.ts | Full pipeline |
| 8 | typecheck | Exports work |

---

## Dependencies

```
packages/adapter-kysely
├── @dbsp/core (workspace:*)
├── kysely (^0.28.9) - peer dependency
└── pg (peer, for PostgreSQL dialect)
```

---

## Golden Tests

| Test | Component | Expected SQL Pattern |
|------|-----------|---------------------|
| Q1 | EXISTS | `WHERE EXISTS (SELECT 1 FROM ...)` |
| Q2 | CTE | `WITH "cte_name" AS (...) SELECT ...` |
