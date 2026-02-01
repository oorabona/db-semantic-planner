# Engineering Principles Compliance

**Date:** 2026-02-01
**Focus:** DRY compliance, execution path clarity, dead code

---

## SOLID Principles

### Single Responsibility (SRP)

| Status | Count | Details |
|--------|-------|---------|
| :green_circle: Compliant | ~92 files | Most files have single responsibility |
| :yellow_circle: Violations | 7 files | Files with multiple responsibilities |

**Violations:**

| File | LOC | Issue | Severity | Trend |
|------|-----|-------|----------|-------|
| `core/src/dx/orm.ts` (QueryBuilderImpl) | 1,091 | 30+ methods, 15 fields: intent building + execution + pagination + streaming + aggregation | HIGH | :arrow_down: improved (was 1,774) |
| `adapter-pgsql/src/pgsql-adapter.ts` | 1,592 | 21+ methods: compilation, execution, result transformation, introspection, schema scoping, recursive, M2M | HIGH | :arrow_down: improved (was 1,930) |
| `nql/src/semantic/visitor.ts` | 1,303 | 61 visitor methods for all AST transformations | HIGH | :arrow_right: unchanged |
| `nql/src/compiler/index.ts` | 1,142 | 21 private methods: parsing + semantic analysis + IntentAST compilation | HIGH | :arrow_right: unchanged |
| `core/src/planner.ts` (plan()) | 1,304 | 19 internal helpers covering all planning decisions | MEDIUM | :arrow_right: unchanged |
| `core/src/dx/filters.ts` | 892 | 47 filter factories + internal helpers | MEDIUM | :arrow_right: unchanged |
| `cli/src/repl/batch.ts` | 924 | 43 functions: dot commands + execution + formatting + state | MEDIUM | :arrow_right: unchanged |

### Open/Closed (OCP)

| Status | Observation |
|--------|-------------|
| :yellow_circle: | Handler pattern well-applied, but compiler still has large switch |

**Violations:**

| File:Line | Issue | Severity | Trend |
|-----------|-------|----------|-------|
| `adapter-pgsql/src/compiler.ts:226-600` | 15+ case switch on `decision.type` — not extensible without modifying compiler | HIGH | :arrow_right: unchanged |
| `core/src/planner.ts:717` | 6-case switch on `where.kind` | LOW | :arrow_right: |

**Mitigation:** The handler pattern (`handlers/where/`, `handlers/expression/`, `handlers/include/`) covers WHERE, expression, and include strategies. The remaining switch could progressively migrate to this pattern.

### Liskov Substitution (LSP)

| Status | Observation |
|--------|-------------|
| :green_circle: | No violations. Error hierarchy and adapter implementations are consistent. |

### Interface Segregation (ISP)

| Status | Observation |
|--------|-------------|
| :yellow_circle: | Adapter interface well-split, but QueryBuilder has 30+ methods |

**Positive example — Adapter interface:**
- `Adapter<DB>` — core query/mutation operations
- `CompileOnlyAdapter` — SQL compilation without DB connection
- `StreamingAdapter` — cursor-based streaming (optional)
- `DDLAdapter` — schema DDL generation (optional)

**Violation:** `QueryBuilder<T>` interface has 30+ methods (where, include, paginate, stream, aggregate, etc.)

### Dependency Inversion (DIP)

| Status | Observation |
|--------|-------------|
| :green_circle: | Excellent. Core depends on Adapter interface, zero imports from adapter-pgsql. `@dbsp/types` successfully breaks core↔nql circular dependency. |

---

## DRY (Don't Repeat Yourself) — PRIMARY FOCUS

### NEW Violations Found (2026-02-01)

| ID | Logic | Locations | Severity |
|----|-------|-----------|----------|
| DRY-N01 | **getColumnName()** — identical function extracting COLUMN_META symbol | `filters.ts:93`, `window-functions.ts:28`, `typed-query-builder.ts:49`, `functions.ts:87` (4×) | **HIGH** |
| DRY-N02 | **buildColumnRef()** — identical WHERE handler helper | `comparison.ts:29`, `null.ts:20`, `in.ts:26`, `like.ts:21` (4×) | **HIGH** |
| DRY-N03 | **Comparison filters** — eq/neq/gt/gte/lt/lte identical structure, only operator differs | `filters.ts:172-309` (6× ~20 LOC each = 120 LOC duplicated) | **HIGH** |
| DRY-N04 | **buildParamRef()** — identical param binding helper | `comparison.ts:36`, `like.ts:29` (2×) | MEDIUM |
| DRY-N05 | **Column target building** — join and lateral handlers duplicate ResTarget construction | `join.ts:47-79`, `lateral.ts:22-50` | MEDIUM |
| DRY-N06 | **Mutation builder constructors** — 4 builders × 14 identical field assignments | `mutation-builders.ts` (56 duplicate lines) | MEDIUM |
| DRY-N07 | **Mutation fluent methods** — `return new XBuilder({ table: this.table, ... })` repeated | `mutation-builders.ts` (all methods) | MEDIUM |
| DRY-N08 | **JSON_AGG correlation logic** — FK direction handling duplicated | `compiler.ts:342`, `json-agg.ts`, `subquery.ts` | MEDIUM |
| DRY-N09 | **Clone methods** — manual 15-field copying in 3 builder classes | `orm.ts:1719`, `typed-query-builder.ts:175`, `subquery-builder.ts:157` | MEDIUM |
| DRY-N10 | **NQL context validation** — 61 identical `if (!ctx.X) throw ...` patterns | `visitor.ts` (61 occurrences) | MEDIUM |
| DRY-N11 | **`currentAlias ?? rootTable`** — repeated across 4+ expression handlers | `aggregate.ts`, `column.ts`, `window.ts`, `coalesce.ts` | LOW |
| DRY-N12 | **normalizeSQL()** — 3 different implementations | `ast-compare.ts:196`, `golden-sql.test.ts:49`, `assertion-functions.ts:23` | MEDIUM |

### Previously Known Violations (Status Update)

| ID | Logic | Status | Trend |
|----|-------|--------|-------|
| DRY-001 | RETURNING clause compiled 3× (INSERT/UPDATE/DELETE) | Still present (`compiler.ts:611,659,714`) | :arrow_right: |
| DRY-002 | FK derivation `deriveForeignKey() ?? "id"` repeated 3× | Still present (`plan-decision-extractor.ts`) | :arrow_right: |
| DRY-003 | 21 identical `clone()` calls in fluent methods | Still present (immutable pattern — acceptable) | :arrow_right: |
| DRY-004 | Schema qualification pattern duplicated | Still present (multiple compiler locations) | :arrow_right: |
| DRY-005 | 86 `throw new Error()` in NQL visitor | Now 61 `throw NqlSemanticException(...)` — partially improved | :arrow_up: |

### Resolved Since Previous Audit

| What | How | Impact |
|------|-----|--------|
| `compiler.ts` monolithic | Handler pattern: `handlers/where/`, `handlers/expression/`, `handlers/include/` | -44% LOC |
| `orm.ts` mixed concerns | Extracted `ResultHydrator`, `QueryExecutor` | -23% LOC |
| `PgsqlAdapter` bloat | Extracted `plan-decision-extractor.ts`, `compiler-conditions.ts` | -18% LOC |

---

## KISS (Keep It Simple)

### Over-Engineering Detected

| Location | Issue | Severity |
|----------|-------|----------|
| `core/src/dx/orm.ts:1719-1760` | Manual 15-field clone with conditionals (fragile — adding field requires updating clone) | MEDIUM |
| `core/src/dx/intent-builder.ts:64-140` | 10+ type assertions to bypass exactOptionalPropertyTypes | MEDIUM |
| `adapter-pgsql/src/pgsql-adapter.ts:625-1177` | `compileSubqueryIncludeManyToMany()` — 550+ LOC, deeply nested FK derivation | HIGH |
| `adapter-pgsql/src/compiler.ts:327-410` | `selectJsonAgg` case — 80+ LOC, multiple responsibilities in single branch | MEDIUM |

---

## YAGNI (You Ain't Gonna Need It)

### Dead Code Detected

| Item | Location | Evidence | Severity |
|------|----------|----------|----------|
| `format()` function | `nql/src/index.ts:205` | Exported, never called, `_ast` param prefix | MEDIUM |
| `validate()` stub | `nql/src/index.ts:151-157` | Just calls `parse()`, marked @deprecated | LOW |
| `NqlLimitError` interface | `nql/src/errors/types.ts:42` | Defined, never used | LOW |
| `NqlWarning` interface | `nql/src/errors/types.ts:49` | Defined, never used | LOW |
| `_getRelationPath()` | `core/src/dx/filters.ts:80` | Private, not called | LOW |
| `@deprecated namingConvention` | `core/src/dx/schema.ts:212` | Deprecated, should be removed | LOW |

### Unused/Over-Exported Public API

| Item | Location | Issue | Severity |
|------|----------|-------|----------|
| 50+ AST helpers | `adapter-pgsql/src/index.ts` | Exported but internal-only | MEDIUM |
| Handler registry API | `adapter-pgsql/src/index.ts` (20+ exports) | Exported but unused cross-package | MEDIUM |
| `PlanCompiler` class | `adapter-pgsql/src/index.ts` | Exported but zero cross-package usage | MEDIUM |
| `defineSchema` (legacy) | `core/src/index.ts` | Deprecated, still used by CLI/MCP | LOW |

---

## Intentional Tradeoffs

| Pattern | Reason | Documented In |
|---------|--------|---------------|
| `QueryBuilderImpl` god class | Fluent API ergonomics require single entry point | ADR-002 |
| 15-case switch in compiler | Handler migration is progressive; remaining cases are stable | BACKLOG |
| `any` types in result-hydrator | Hydration transforms heterogeneous results; generic constraints over-constrain | biome-ignore |
| `unknown[]` in intent-ast | Transport format; validation at boundaries | ARCH-004 |
| NqlCstVisitor monolith | Chevrotain `validateVisitor()` requires all rules on one class | TODO.md (5.1 Skipped) |

---

## Same Name, Different Purpose

| Symbol | Location A | Location B | Purpose A | Purpose B |
|--------|-----------|-----------|-----------|-----------|
| `compile()` | `nql/compiler` | `adapter-pgsql/compiler` | NQL AST → IntentAST | PlanReport → PostgreSQL AST |
| `validate()` | `nql/index.ts` | `adapter-pgsql/validate.ts` | NQL parse validation (stub) | Identifier validation (regex) |
| `normalizeSQL()` | `adapter-pgsql/ast-compare.ts` | `cli/assertion-functions.ts` | Test AST comparison | Assertion result comparison |
| `getColumnName()` | `filters.ts` | `functions.ts` / `window-functions.ts` / `typed-query-builder.ts` | Same purpose — **should be deduplicated** |

---

## Compliance Summary

| Principle | Score | Status | Trend |
|-----------|-------|--------|-------|
| SRP | 6/10 | :yellow_circle: | :arrow_up: (orm -23%, adapter -18%) |
| OCP | 7/10 | :yellow_circle: | :arrow_right: |
| LSP | 10/10 | :green_circle: | :arrow_right: |
| ISP | 7/10 | :yellow_circle: | :arrow_right: |
| DIP | 10/10 | :green_circle: | :arrow_right: |
| DRY | 5/10 | :red_circle: | :arrow_down: (12 NEW violations found) |
| KISS | 7/10 | :yellow_circle: | :arrow_right: |
| YAGNI | 7/10 | :yellow_circle: | :arrow_down: (dead code + over-export) |

**Overall Principle Compliance:** 7/10 (DRY is the weakest axis)

### Resolution History

| Audit Date | Items Resolved | Notable Improvements |
|------------|---------------|---------------------|
| 2026-01-20 → 2026-01-31 | 18 items | compiler.ts -44%, orm.ts -23%, handler pattern |
| 2026-01-31 → 2026-02-01 | 5 items | README/CLAUDE.md fixed, Math.random→crypto.randomUUID, ARCH-006→Canonical, PgsqlAdapter -18% |
