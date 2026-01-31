# Engineering Principles Compliance

**Date:** 2026-01-31

---

## SOLID Principles

### Single Responsibility (SRP)

| Status | Count | Details |
|--------|-------|---------|
| :green_circle: Compliant | ~90 files | Most files have single responsibility |
| :yellow_circle: Violations | 8 files | Files with multiple responsibilities |

**Violations:**

| File:Line | Class/Function | Issue | Severity |
|-----------|----------------|-------|----------|
| `core/src/dx/orm.ts:683-1774` | `QueryBuilderImpl` | God class: 15 fields, 20+ methods, 7 responsibilities (building, execution, cloning, pagination, etc.) | HIGH |
| `adapter-pgsql/src/pgsql-adapter.ts:189-1930` | `PgsqlAdapter` | God class: 10 responsibilities (compilation, execution, DDL, transactions, streaming, mutations, etc.) | HIGH |
| `core/src/dx/types.ts` | (entire file) | 26 exported types mixing query, orm, pagination, streaming, aggregation | MEDIUM |
| `core/src/dx/filters.ts` | (entire file) | 57 functions + WindowBuilder class mixing comparison, logical, relation, window, array, range filters | MEDIUM |
| `core/src/planner.ts` | `plan()` | 1,544 LOC with 22 internal helpers covering where, includes, CTEs, joins, ambiguity | MEDIUM |
| `adapter-pgsql/src/compiler.ts` | `PlanCompiler` | Handles SELECT + INSERT + UPDATE + DELETE compilation (1,250 LOC) | MEDIUM |
| `nql/src/semantic/visitor.ts` | `NqlCstVisitor` | 1,303 LOC, 40+ methods for all CST->AST transformations | HIGH |
| `cli/src/repl/batch.ts` | (entire file) | 924 LOC, 43 functions: dot commands, execution, formatting, state | HIGH |

### Open/Closed (OCP)

| Status | Observation |
|--------|-------------|
| :yellow_circle: | Mostly compliant via Handler pattern and Adapter interface, but compiler has large switch |

**Violations:**

| File:Line | Issue | Severity |
|-----------|-------|----------|
| `adapter-pgsql/src/compiler.ts:159-580` | 44-case switch on `decision.type` -- not extensible without modifying compiler | HIGH |
| `core/src/planner.ts:717` | 6-case switch on `where.kind` | LOW |

**Mitigation:** The handler pattern (`handlers/where/`, `handlers/expression/`, `handlers/include/`) already extracts logic for WHERE, expression, and include strategies. The remaining 44-case switch could be progressively migrated to this pattern.

### Liskov Substitution (LSP)

| Status | Observation |
|--------|-------------|
| :green_circle: | No violations found. Error hierarchy and adapter implementations are consistent. |

### Interface Segregation (ISP)

| Status | Observation |
|--------|-------------|
| :yellow_circle: | Adapter interface well-split, but QueryBuilder has 30+ methods |

**Violations:**

| File:Line | Issue | Severity |
|-----------|-------|----------|
| `core/src/dx/types.ts:400-700` | `QueryBuilder<TResult>` interface has 30+ methods (where, include, paginate, stream, aggregate, etc.) | MEDIUM |

**Positive example -- Adapter interface segregation:**

The `Adapter` port interface in `core/src/adapter.ts` is well-segregated:
- `Adapter<DB>` -- core query/mutation operations
- `CompileOnlyAdapter` -- SQL compilation without DB connection (used by CLI)
- `StreamingAdapter` -- cursor-based streaming (optional capability)
- `DDLAdapter` -- schema DDL generation (optional capability)

This segregation allows `createPgsqlCompileOnlyAdapter()` to implement only compilation without requiring a pg Pool, demonstrating proper ISP compliance at the architecture boundary.

### Dependency Inversion (DIP)

| Status | Observation |
|--------|-------------|
| :green_circle: | Excellent. Core depends on Adapter interface, zero imports from adapter-pgsql. |

**Evidence:** `packages/core/` has zero imports from `packages/adapter-pgsql/`. All adapter interaction goes through the `Adapter<DB>` interface defined in `core/src/adapter.ts`.

---

## DRY (Don't Repeat Yourself)

### Current Duplicated Logic

| Logic | Locations | Severity |
|-------|-----------|----------|
| `clone()` calls at start of every fluent method | `core/src/dx/orm.ts` (20+ occurrences) | HIGH |
| FK derivation from table name | `adapter-pgsql/src/pgsql-adapter.ts:318,492` + `compiler.ts:743` | MEDIUM |
| RETURNING clause compilation | `adapter-pgsql/src/compiler.ts:610,662,704` | MEDIUM |
| Schema qualification pattern | Multiple locations in compiler + adapter | LOW |
| `throw new Error()` without structured types | `nql/src/semantic/visitor.ts` (86 occurrences) | MEDIUM |

### Resolved Since Previous Audit (2026-01-20)

| What | Before | After | Reduction |
|------|--------|-------|-----------|
| `compiler.ts` duplication | 4,736 LOC, monolithic | 2,633 LOC, handlers extracted | **-44%** |
| `orm.ts` responsibilities | 2,317 LOC, mixed concerns | 1,776 LOC, ResultHydrator + QueryExecutor extracted | **-23%** |
| `PlanDecision` handler pattern | Inline in compiler switch | `handlers/where/`, `handlers/expression/`, `handlers/include/` | Extensible |
| `intent-to-decisions.ts` | Mixed into compiler | Standalone 550 LOC module | Separated |

---

## KISS (Keep It Simple)

### Over-Engineering Detected

| Location | Issue | Severity |
|----------|-------|----------|
| `core/src/dx/orm.ts:1733-1770` | Manual cloning of 15 fields with conditionals (38 LOC) | MEDIUM |
| `core/src/dx/intent-builder.ts:64-140` | 10+ type assertions to bypass exactOptionalPropertyTypes | MEDIUM |
| `adapter-pgsql/src/pgsql-adapter.ts:582-649` | Complex recursive dotted-field->EXISTS conversion | MEDIUM |

---

## YAGNI (You Ain't Gonna Need It)

### Deprecated Code Still Present

| Item | Location | Issue |
|------|----------|-------|
| `nqlCompiler` parameter | `core/src/dx/orm.ts:128` | @deprecated but still exported |
| `NqlCompilerFn` type | `core/src/dx/nql.ts:27` | @deprecated |
| `namingConvention` option | `core/src/dx/schema.ts:212` | @deprecated (use dbCasing) |
| `validate()` function | `nql/src/index.ts:149-156` | Stub -- just calls `parse()` |

### Dead Code

No significant dead code detected. Codebase appears actively maintained.

---

## Intentional Tradeoffs

These are documented conscious decisions, not violations:

| Pattern | Reason | Documented In |
|---------|--------|---------------|
| `QueryBuilderImpl` god class | Fluent API ergonomics require single entry point; splitting would break method chaining | ADR-002 |
| 44-case switch in compiler | Handler migration is progressive; full registry pattern would add indirection for low churn code | BACKLOG #10 |
| `any` types in result-hydrator | Hydration transforms heterogeneous query results; generic constraints would over-constrain the API | biome-ignore comments |
| `unknown[]` in intent-ast | Intent AST is a transport format; validation happens at boundaries (NQL compiler, planner) | ARCH-004 |

---

## Same Name, Different Purpose

| Symbol | Location A | Location B | Purpose A | Purpose B |
|--------|-----------|-----------|-----------|-----------|
| `compile()` | `nql/compiler` | `adapter-pgsql/compiler` | NQL AST -> IntentAST | PlanReport -> PostgreSQL AST |
| `validate()` | `nql/index.ts` | `adapter-pgsql/validate.ts` | NQL parse validation (stub) | Identifier validation (regex) |
| `plan()` | `core/planner.ts` | (unique) | Intent -> PlanReport | -- |
| `Adapter` | `core/adapter.ts` | (unique) | Port interface | -- |

---

## Compliance Summary

| Principle | Score | Status | Trend |
|-----------|-------|--------|-------|
| SRP | 6/10 | :yellow_circle: | -> (stable) |
| OCP | 7/10 | :yellow_circle: | up (handlers extracted) |
| LSP | 10/10 | :green_circle: | -> |
| ISP | 7/10 | :yellow_circle: | -> |
| DIP | 10/10 | :green_circle: | -> |
| DRY | 6/10 | :yellow_circle: | up (compiler -44%) |
| KISS | 7/10 | :yellow_circle: | -> |
| YAGNI | 8/10 | :green_circle: | -> |

**Overall Principle Compliance:** 7/10

### Resolution History

| Audit Date | Items Resolved | Notable Improvements |
|------------|---------------|---------------------|
| 2026-01-20 -> 2026-01-31 | 18 items | compiler.ts -44%, orm.ts -23%, handler pattern introduced, intent-to-decisions extracted |
