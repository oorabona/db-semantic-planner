# Component Analysis

**Date:** 2026-02-01
**Scope:** All 6 packages — focus DRY, execution paths, dead code

---

## Component: @dbsp/core

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/core` |
| Purpose | DB-agnostic schema definition, query planning, DX layer |
| Source files | 34 |
| LOC | 19,915 |
| Test files | 24 |
| Test ratio | 0.71 (excellent) |
| Dependencies | `@dbsp/nql`, `@dbsp/types`, `valibot` |

### Architecture Layers

```
Core Layer (root)
├── model-ir.ts (460 LOC) — Schema IR (TableIR, ColumnIR, RelationIR)
├── intent-ast.ts (12 LOC) — Query AST re-exports
├── planner.ts (1,544 LOC) — Semantic Planner
├── adapter.ts (535 LOC) — Adapter port interface
├── model-impl.ts (244 LOC) — ModelIR implementation
├── conventions.ts (541 LOC) — Schema convention inference
└── schema-dsl.ts (148 LOC) — Legacy schema DSL

DX Layer (dx/)
├── orm.ts (1,774 LOC) — Public API, QueryBuilderImpl
├── types.ts (1,638 LOC) — 26 exported types
├── filters.ts (1,180 LOC) — 57 filter helpers + WindowBuilder
├── schema.ts (1,084 LOC) — Schema DSL (ARCH-005)
├── mutation-builders.ts (876 LOC) — INSERT/UPDATE/DELETE/UPSERT
├── errors.ts (809 LOC) — 13 custom error classes
├── intent-builder.ts (643 LOC) — Intent AST construction
├── query-executor.ts (623 LOC) — Query execution
├── result-hydrator.ts (540 LOC) — Result transformation
└── ... (14 more specialized files)
```

### Findings

| ID | Severity | Issue |
|----|----------|-------|
| CORE-001 | HIGH | `QueryBuilderImpl` god class (1,091 LOC, 15 fields, 20+ methods, 7 responsibilities) — reduced from 1,774 |
| CORE-002 | HIGH | 20+ identical `clone()` calls at start of every fluent method (DRY) |
| CORE-003 | MEDIUM | `types.ts` has 26 exported types mixing query, orm, pagination, aggregation |
| CORE-004 | MEDIUM | `filters.ts` has 57 functions + WindowBuilder class (SRP) |
| CORE-005 | MEDIUM | `planner.ts` single `plan()` function with 22 internal helpers (1,544 LOC) |
| CORE-006 | MEDIUM | `QueryBuilder<T>` interface has 30+ methods (ISP violation) |
| CORE-007 | MEDIUM | 7 `any` types in `result-hydrator.ts` with biome-ignore |
| CORE-008 | LOW | 10+ type assertions in `intent-builder.ts` (exactOptionalPropertyTypes workaround) |
| CORE-009 | LOW | 4 deprecated exports still present (nqlCompiler, NqlCompilerFn, namingConvention, validate()) |
| CORE-010 | HIGH | **NEW:** `getColumnName()` duplicated 4× (filters, functions, window-functions, typed-query-builder) |
| CORE-011 | HIGH | **NEW:** Comparison filters (eq/neq/gt/gte/lt/lte) — 120 LOC identical boilerplate |
| CORE-012 | MEDIUM | **NEW:** `isRecursiveIncludeOptions()` exported from both types.ts and intent-builder.ts |
| CORE-013 | MEDIUM | **NEW:** Mutation builder constructors — 56 identical field assignments across 4 builders |
| CORE-014 | MEDIUM | **NEW:** `_getRelationPath()` private function in filters.ts — never called |

### Strengths

- :green_circle: Excellent DIP compliance (zero adapter imports)
- :green_circle: 13 custom error classes with rich context
- :green_circle: Full observability via `dump()`
- :green_circle: Strong type safety (readonly, type guards, discriminated unions)
- :green_circle: Recent refactoring (DX-103) properly separated ResultHydrator

---

## Component: @dbsp/adapter-pgsql

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/adapter-pgsql` |
| Purpose | PostgreSQL-native SQL compiler + executor |
| Source files | 53 |
| LOC | 14,529 |
| Test files | 19 |
| Test ratio | 0.36 (moderate) |
| Dependencies | `@dbsp/core`, `@dbsp/types`, `pg`, `pgsql-deparser` |

### Architecture

```
pgsql-adapter.ts (1,930 LOC) — Main adapter, implements Adapter<DB>
compiler.ts (1,250 LOC) — PlanReport → PostgreSQL AST
intent-to-decisions.ts (550 LOC) — QueryIntent → Decision[]
ast-helpers.ts (893 LOC) — PostgreSQL AST factory functions
validate.ts (283 LOC) — Identifier validation
param-ref.ts (236 LOC) — Parameter binding ($N)
deparse.ts (10 LOC) — pgsql-deparser wrapper

handlers/ (2,263 LOC)
├── where/ — 12 WHERE handlers (comparison, logical, exists, etc.)
├── expression/ — 3 expression handlers (aggregate, window, raw)
└── include/ — 4 include strategy handlers (join, lateral, json_agg, cte)

mutations/ — INSERT/UPDATE/DELETE compilation
recursive/ — WITH RECURSIVE CTE compilation
ddl/ — DDL generation from ModelIR
streaming/ — Cursor-based streaming
```

### Findings

| ID | Severity | Issue |
|----|----------|-------|
| PGSQL-001 | HIGH | `PgsqlAdapter` god class (1,592 LOC, 21+ methods, 10 responsibilities) — reduced from 1,930 |
| PGSQL-002 | HIGH | 15-case switch on `decision.type` in compiler (OCP violation) — reduced from 44 |
| PGSQL-003 | MEDIUM | RETURNING clause compilation duplicated 3 times |
| PGSQL-004 | MEDIUM | FK derivation logic duplicated in 3 locations |
| PGSQL-005 | MEDIUM | `compileSubqueryIncludeManyToMany()` — 550+ LOC, deeply nested (was: dotted-field→EXISTS) |
| PGSQL-006 | ~~LOW~~ | ~~`Math.random()` for cursor names~~ — **RESOLVED:** now uses `crypto.randomUUID()` |
| PGSQL-007 | LOW | Silent error suppression in transaction rollback |
| PGSQL-008 | HIGH | **NEW:** `buildColumnRef()` duplicated in 4 WHERE handlers |
| PGSQL-009 | MEDIUM | **NEW:** `buildParamRef()` duplicated in 2 handlers |
| PGSQL-010 | MEDIUM | **NEW:** Column target building duplicated in join/lateral handlers |
| PGSQL-011 | MEDIUM | **NEW:** JSON_AGG FK direction logic duplicated across compiler, json-agg, subquery |

### Strengths

- :green_circle: Excellent SQL security (parameterized queries, identifier validation, AST-based generation)
- :green_circle: Handler pattern for extensibility (WHERE, expression handlers)
- :green_circle: No N+1 query risks (json_agg, LEFT JOIN strategies)
- :green_circle: Compile-only mode (no DB connection needed)
- :green_circle: Proper identifier quoting via deparser

---

## Component: @dbsp/nql

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/nql` |
| Purpose | NQL parser (Chevrotain-based) |
| Source files | 11 |
| LOC | 4,990 |
| Test files | 4 |
| Test ratio | 0.36 (moderate) |
| Dependencies | `@dbsp/types`, `chevrotain` |

### Architecture

```
Lexer → Parser (CST) → Visitor (AST) → Compiler (IntentAST)

lexer/tokens.ts (330 LOC) — Token definitions
parser/grammar.ts (1,247 LOC) — Chevrotain grammar rules
semantic/visitor.ts (1,303 LOC) — CST → AST transformer
compiler/index.ts (1,287 LOC) — AST → IntentAST compiler
parser/ast.ts (471 LOC) — NQL AST type definitions
errors/types.ts (142 LOC) — Error types
index.ts (206 LOC) — Public API: parse(), validate(), compile()
```

### Findings

| ID | Severity | Issue |
|----|----------|-------|
| NQL-001 | HIGH | `NqlCstVisitor` god class (1,303 LOC, 40+ methods) |
| NQL-002 | HIGH | 86 `throw new Error()` calls without structured types in visitor |
| NQL-003 | MEDIUM | `compileQuery()` function handles 8 responsibilities (114 lines) |
| NQL-004 | MEDIUM | `validate()` is a stub — just calls `parse()` |
| NQL-005 | LOW | No position tracking in most visitor errors |

### Strengths

- :green_circle: Professional parser generator (Chevrotain)
- :green_circle: Clean pipeline separation (lexer → parser → visitor → compiler)
- :green_circle: Error recovery enabled in grammar
- :green_circle: No ReDoS risk (all regex patterns are linear-time)
- :green_circle: Full TypeScript with discriminated unions for AST nodes

---

## Component: @dbsp/types

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/types` |
| Purpose | Shared TypeScript types (IntentAST, utils) |
| Source files | 5 |
| LOC | 1,851 |
| Test files | 0 |
| Test ratio | 0.00 |
| Dependencies | none |

### Findings

| ID | Severity | Issue |
|----|----------|-------|
| TYPES-001 | MEDIUM | `unknown[]` for function args/values without validation (intent-ast.ts:235,285,510) |
| TYPES-002 | MEDIUM | `RangeValue` uses `unknown` for lower/upper bounds (no type constraint) |
| TYPES-003 | LOW | No type-level tests (`expectTypeOf`) |

### Strengths

- :green_circle: Zero `any` types
- :green_circle: Clean separation of public/internal/shared types
- :green_circle: Extensive use of `readonly`
- :green_circle: Discriminated unions for all intent types

---

## Component: @dbsp/cli

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/cli` |
| Purpose | Interactive REPL + batch execution |
| Source files | 21 |
| LOC | 6,194 |
| Test files | 12 |
| Test ratio | 0.57 (good) |
| Dependencies | `@dbsp/core`, `@dbsp/nql`, `@dbsp/adapter-pgsql`, `ink`, `commander` |

### Findings

| ID | Severity | Issue |
|----|----------|-------|
| CLI-001 | HIGH | `batch.ts` god file (924 LOC, 43 functions) — dot commands, execution, formatting, state |
| CLI-002 | HIGH | `assertion-runner.ts` god file (1,077 LOC, 15+ assertion handlers) |
| CLI-003 | LOW | Global singleton config manager (`config.ts:162`) |
| CLI-004 | LOW | Direct `console.error` instead of logger abstraction |

### Strengths

- :green_circle: Comprehensive tab completion
- :green_circle: Batch mode with assertion framework
- :green_circle: Flexible output formats (text/json/csv)
- :green_circle: Command history persistence
- :green_circle: Good test coverage (12 test files)

---

## Component: @dbsp/mcp-server

### Overview

| Attribute | Value |
|-----------|-------|
| Path | `packages/mcp-server` |
| Purpose | Model Context Protocol server |
| Source files | 3 |
| LOC | 511 |
| Test files | 1 |
| Test ratio | 0.33 |
| Dependencies | `@dbsp/core`, `@modelcontextprotocol/sdk` |

### Findings

| ID | Severity | Issue |
|----|----------|-------|
| MCP-001 | HIGH | Only 1 placeholder test (`expect(true).toBe(true)`) |
| MCP-002 | MEDIUM | Implementation marked "Ready" but is skeletal |

### Strengths

- :green_circle: Uses official `@modelcontextprotocol/sdk`
- :green_circle: Minimal attack surface (stdio transport)

---

## Component Quality Rankings

| Rank | Package | Score | Rationale |
|------|---------|-------|-----------|
| 1 | @dbsp/types | 8.5/10 | Clean types, zero deps, no `any` |
| 2 | @dbsp/core | 7.5/10 | Excellent architecture, god class needs splitting |
| 3 | @dbsp/nql | 7.5/10 | Solid parser, visitor needs refactoring |
| 4 | @dbsp/adapter-pgsql | 7/10 | Excellent security, god class + OCP violation |
| 5 | @dbsp/cli | 7/10 | Feature-rich, 2 god files |
| 6 | @dbsp/mcp-server | 3/10 | Skeletal implementation, placeholder test |
