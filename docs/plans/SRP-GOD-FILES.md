# SRP God Files Split — Execution Plan

> Assessment date: 2026-02-06
> Total: 5 files, 9,444 LOC → target ~300 LOC per file max

## Phase 1: intent-ast.ts (S effort, ZERO risk)

**File:** `packages/types/src/intent-ast.ts` (1,819 LOC)
**Coupling:** `index.ts` does `export * from './intent-ast.js'` — all consumers import from `@dbsp/types`, never from file path. Barrel re-export makes split 100% transparent.

### Split Map (line ranges → new files)

| New File | Lines | Content | LOC est. |
|----------|-------|---------|----------|
| `intent/operators.ts` | 8-27 | ComparisonOperator, StringOperator, ArrayOperator, NullOperator, LogicalOperator, RelationOperator | 20 |
| `intent/recursive-types.ts` | 30-55 | RecursiveDirection, RecursiveExistsOptions | 25 |
| `intent/select-intent.ts` | 58-136 | SortDirection re-export, SelectAllIntent, SelectFieldsIntent, SelectAggregateIntent, SelectWithExpressionsIntent, SelectIntent, AggregateIntent, AggregateFunction | 80 |
| `intent/expression-intent.ts` | 139-461 | ALL expression intents (Coalesce, Raw, Column, ColumnAlias, RelationColumn, Aggregate, PseudoColumn, Function, Subquery, Arithmetic, Literal, Comparison, Case) + WindowFunction types + ExpressionIntent union | 320 |
| `intent/where-intent.ts` | 478-752 | FieldRef, ALL where intents (Comparison, Like, In, Range, Null, And, Or, Not, Exists, NotExists, RelationFilter, Subquery) + SubqueryRefIntent, ScalarSubqueryIntent + WhereIntent union | 275 |
| `intent/include-intent.ts` | 754-888 | IncludeRecursiveOptions, IncludeIntent, OrderByIntent | 135 |
| `intent/query-intent.ts` | 890-945 | QueryIntent | 55 |
| `intent/recursive-intent.ts` | 947-1260 | RecursiveNodeIdExpr, AdjacencyTraversal, EdgeTableTraversal, CustomTraversal, RecursiveTraversal, RecursiveTrackOptions, EmitJoinClause, RecursiveEmitOptions, RecursiveAdvancedOptions, RecursiveDedupe, RecursiveIntent | 315 |
| `intent/mutation-intent.ts` | 1262-1489 | InsertIntent, InsertFromIntent, UpsertFromIntent, UpdateIntent, DeleteIntent, UpsertConflictTarget, UpsertConflictAction, UpsertIntent, MutationIntent union | 230 |
| `intent/type-guards.ts` | 1490-1819 | ALL type guard functions (isWindowIntent, isWhereComparison, ..., isMutationIntent) | 330 |

### Cross-references Between New Files

- `expression-intent.ts` needs: `operators.ts` (ComparisonOperator), `where-intent.ts` (WhereIntent — for CaseExpressionIntent.condition)
- `where-intent.ts` needs: `operators.ts` (ComparisonOperator, etc.), `expression-intent.ts` (ExpressionIntent — for WhereInIntent.subquery)
- `query-intent.ts` needs: `select-intent.ts`, `where-intent.ts`, `include-intent.ts`, `expression-intent.ts`
- `recursive-intent.ts` needs: `query-intent.ts` (QueryIntent), `where-intent.ts`
- `mutation-intent.ts` needs: `where-intent.ts`, `expression-intent.ts`
- `type-guards.ts` needs: ALL intent files (type imports only)

**IMPORTANT circular dep:** `expression-intent.ts` ↔ `where-intent.ts` — CaseExpressionIntent.condition uses WhereIntent, WhereInIntent.subquery may use ExpressionIntent. Solution: this is TYPE-ONLY imports → TypeScript handles it fine, no runtime circular dependency.

### Execution Steps

1. Create `packages/types/src/intent/` directory
2. Create all 10 files with correct imports between them
3. Replace `intent-ast.ts` body with barrel re-exports:
   ```typescript
   export * from './intent/operators.js';
   export * from './intent/recursive-types.js';
   export * from './intent/select-intent.js';
   export * from './intent/expression-intent.js';
   export * from './intent/where-intent.js';
   export * from './intent/include-intent.js';
   export * from './intent/query-intent.js';
   export * from './intent/recursive-intent.js';
   export * from './intent/mutation-intent.js';
   export * from './intent/type-guards.js';
   ```
4. Run `pnpm tsc --noEmit` — must be clean
5. Run `pnpm vitest run --exclude '**/e2e/**'` — must pass (no behavioral change)
6. Update internal imports in `packages/types/src/planner.ts` and `adapter.ts` to use new paths (optional — barrel works)

### Validation

- `pnpm tsc --noEmit` clean
- `pnpm vitest run` (unit) all pass
- `git diff --stat` shows only new files + modified `intent-ast.ts`

---

## Phase 2: NqlCstVisitor (M effort, medium risk)

**File:** `packages/nql/src/semantic/visitor.ts` (1,498 LOC)
**Coupling:** 1 consumer (`packages/nql/src/index.ts` imports `cstToAst`)

### Method Inventory (71 methods on NqlCstVisitor)

**Helper functions (top-level, not in class):**
- `requireFirst`, `asCstNode`, `getImage`, `isCstNode`, `requireFields`, `unreachable`

**Class methods by domain:**

| Domain | Methods | LOC est. |
|--------|---------|----------|
| **Program/Statement** | `program`, `statement` | 20 |
| **Query structure** | `query`, `tableRef`, `queryClause`, `whereClause`, `selectClause`, `flatClause`, `groupClause`, `orderClause`, `limitClause`, `offsetClause`, `bindClause` | 120 |
| **Join/Params** | `joinSpec`, `paramList`, `param` | 50 |
| **Select items** | `selectList`, `selectItem`, `relationStarExpr` | 50 |
| **Order items** | `orderList`, `orderItem`, `orderClauseInWindow` | 30 |
| **Boolean exprs** | `booleanExpr`, `orExpr`, `andExpr`, `notExpr`, `primaryCond`, `comparisonSuffix`, `compOp`, `betweenSuffix`, `rangeOp`, `rangeOpSuffix`, `buildComparison`, `buildBetween`, `buildIn`, `buildIsNull`, `buildRangeOp` | 200 |
| **Relation filters** | `existsCheck`, `quantifiedRelationFilter`, `allRelationFilter`, `inSuffix`, `isNullSuffix` | 150 |
| **Arithmetic** | `expression`, `addExpr`, `mulExpr`, `unaryExpr` | 80 |
| **Primary/Case** | `primaryExpr`, `caseExpr`, `searchedCaseBody`, `simpleCaseBody`, `scalarSubquery`, `pathExpr`, `exprList` | 140 |
| **Functions** | `funcCall`, `funcArgList`, `windowClause`, `partitionClause` | 150 |
| **Literals** | `literal`, `identSegment`, `identList`, `valueList`, `rangeLiteral`, `rangeValue` | 110 |
| **Mutations** | `mutationPipeline`, `mutation`, `mutationClause`, `insertStmt`, `insertFromStmt`, `assignmentList`, `assignment`, `updateStmt`, `deleteStmt`, `upsertStmt`, `upsertFromStmt`, `valuesTuple` | 230 |

### Split Strategy: Composition pattern

Chevrotain CST visitors require ALL methods on a single class (registered via `validateVisitor()`). We CANNOT use separate classes.

**Strategy:** Extract logic into standalone functions, keep visitor as thin dispatcher.

```
packages/nql/src/semantic/
├── visitor.ts (300 LOC) — NqlCstVisitor class, thin methods delegating to domain modules
├── helpers.ts (60 LOC) — requireFirst, asCstNode, getImage, isCstNode, requireFields, unreachable
├── visit-query.ts (200 LOC) — query structure, select, order, join, params, group
├── visit-expression.ts (350 LOC) — boolean exprs, arithmetic, primary, case, scalar subquery
├── visit-function.ts (150 LOC) — funcCall, window, partition, argList
├── visit-literal.ts (110 LOC) — literals, identifiers, values, ranges
├── visit-mutation.ts (230 LOC) — all mutation visitors
└── index.ts — re-export cstToAst
```

Each `visit-*.ts` exports standalone functions that take `(ctx, helpers)` and return AST nodes.
The visitor class methods become one-liners: `return visitQuery(ctx, this.helpers)`.

### Key Risk

- Chevrotain `validateVisitor()` requires ALL grammar rule methods on the class
- Must keep method stubs even if logic is extracted
- `this` references in extracted functions need explicit parameter passing
- CST context type (`CstContext`) must be shared

### Execution Steps

1. Extract `helpers.ts` (standalone functions, zero risk)
2. Create `visit-literal.ts` (simplest domain, good test of pattern)
3. Validate: run `pnpm vitest run packages/nql` — must pass
4. Extract `visit-mutation.ts` (self-contained, 230 LOC)
5. Extract `visit-expression.ts` (largest, 350 LOC)
6. Extract `visit-function.ts`
7. Extract `visit-query.ts`
8. Thin the visitor class to dispatcher-only
9. Full test validation

### Validation

- `pnpm vitest run packages/nql` — all tests pass
- `pnpm tsc --noEmit` clean
- Manual: parse a complex NQL query, verify identical AST output

---

## Phase 3: NQL Compiler (L effort, high risk)

**File:** `packages/nql/src/compiler/index.ts` (1,958 LOC)
**Coupling:** 2 consumers (`packages/nql/src/index.ts`, `packages/core/src/dx/nql.ts`)

### Method Inventory (NqlCompiler class: 31 methods + ColumnValidator: 5 methods)

| Domain | Methods | LOC est. |
|--------|---------|----------|
| **Validation** | `ColumnValidator` class (validateColumn, validateTable, columnsMatch, resolveRelationTarget, toSnakeCase) | 100 |
| **Compilation entry** | `compile`, `compileSingleStatement`, `extractBindName` | 120 |
| **Query compilation** | `compileQuery` | 200 |
| **Select compilation** | `compileSelectClause`, `compileSelectExpression` | 400 |
| **Clause compilation** | `compileGroupByClause`, `compileOrderByClause`, `compileOrderItem` | 40 |
| **Expression compilation** | `compileExpression` (WHERE → WhereIntent), `validateWhereField`, `resolveRelationTarget` | 270 |
| **Mutation pipeline** | `compileMutationPipeline` | 30 |
| **Mutations** | `compileMutation`, `compileInsert`, `compileInsertFrom`, `compileUpdate`, `compileDelete`, `compileUpsert`, `compileUpsertFrom`, `extractReturningColumns`, `resolveBindingsInWhere` | 300 |
| **Expression utils** | `expressionToField`, `compileExpressionToIntent`, `expressionToValue`, `resolveFilterValue`, `expressionToRangeValue`, `expressionToSql`, `mapComparisonOperator` | 250 |
| **Include building** | `buildNestedIncludes`, `applyIncludeLimit` (top-level functions) | 130 |

### Split Strategy

```
packages/nql/src/compiler/
├── index.ts (150 LOC) — NqlCompiler class shell + createCompiler factory + re-exports
├── column-validator.ts (100 LOC) — ColumnValidator class
├── compile-query.ts (300 LOC) — compileQuery + clause compilation (group, order)
├── compile-select.ts (400 LOC) — compileSelectClause + compileSelectExpression
├── compile-expression.ts (270 LOC) — compileExpression (WHERE/HAVING → WhereIntent)
├── compile-mutation.ts (330 LOC) — all mutation compilation methods
├── expression-utils.ts (250 LOC) — expressionToField/Value/Sql/Range, mapComparisonOperator
├── include-builder.ts (130 LOC) — buildNestedIncludes, applyIncludeLimit
└── types.ts (30 LOC) — CompileResult, NqlCompilerOptions, ColumnValidatorSchema
```

### Key Risk

- **Shared state:** NqlCompiler has `currentFromTable`, `currentRelationTarget`, `validator`, `pseudoColumnKeywords`, `recursiveKeywords` — these are set during `compileQuery` and used by all sub-compilers
- **Solution:** Create `CompilerContext` type, pass as parameter to all extracted functions
- Golden tests depend on exact output — must use snapshot comparison

### Execution Steps

1. Extract `types.ts` + `column-validator.ts` (zero logic change)
2. Extract `expression-utils.ts` (pure functions, no `this`)
3. Extract `include-builder.ts` (already top-level functions)
4. Create `CompilerContext` interface
5. Extract `compile-expression.ts` (uses context)
6. Extract `compile-select.ts` (depends on expression)
7. Extract `compile-query.ts` (depends on select, expression)
8. Extract `compile-mutation.ts` (depends on expression-utils)
9. Update `index.ts` to compose
10. Run ALL tests

### Validation

- `pnpm vitest run packages/nql` — all tests pass
- `pnpm vitest run packages/adapter-pgsql` — NQL→SQL pipeline unchanged
- `pnpm tsc --noEmit` clean

---

## Phase 4: QueryBuilderImpl in orm.ts (L effort, high risk)

**File:** `packages/core/src/dx/orm.ts` (2,391 LOC)
**Coupling:** Every ORM user. Public API (`createOrm`, `QueryBuilder<T>` interface).

### Symbol Inventory

**Top-level functions (outside class):**
- `createOrm` (500 LOC!) — main factory
- `createOrmInstance` (internal helper, creates OrmInstance methods)
- `extractRecursiveField`, `findSelfRefRelation` — hierarchy helpers

**QueryBuilderImpl class (25 properties, 57 methods):**

| Domain | Methods | LOC est. |
|--------|---------|----------|
| **State (constructor + clone)** | constructor, clone, 25 property declarations | 100 |
| **Query building** | where, include, columns (3 overloads), coalesce, distinct, withStrictMode, withRelationHint, withPlanOptions, withoutDefaultFilters | 250 |
| **Aggregates** | count, sum, avg, min, max, groupBy, having | 150 |
| **Sort/Limit** | orderBy, limit, offset | 40 |
| **Intent building** | buildIntent, buildExistsIntent, buildExistsIntentFromIntent, applyDefaultFiltersToIntent, applyRelationHints, applyHintToInclude, handleAmbiguity, buildPkCondition, getSimplePkColumn | 250 |
| **Execution** | execute, executeWithHooks, executeWithHooksInner, stream, all, first, firstOrThrow, byId, byIdOrThrow, byIds, exists, existsWithHooks | 350 |
| **Dump/Plan** | plan, dump, existsDump | 100 |
| **Pagination** | paginate, cursorPaginate, buildCursor, buildCursorConditions | 200 |
| **Config** | getConfiguredAdapter, getEffectiveStrictMode | 30 |

### Split Strategy

```
packages/core/src/dx/
├── orm.ts (200 LOC) — createOrm factory + createOrmInstance (re-exports QueryBuilder)
├── query-builder/
│   ├── query-builder.ts (150 LOC) — QueryBuilderImpl class shell + constructor + clone + state
│   ├── query-methods.ts (250 LOC) — where, include, columns, coalesce, distinct, etc.
│   ├── aggregate-methods.ts (150 LOC) — count, sum, avg, min, max, groupBy, having
│   ├── execution.ts (350 LOC) — execute*, stream, all, first, firstOrThrow, byId*, byIds, exists*
│   ├── pagination.ts (200 LOC) — paginate, cursorPaginate, buildCursor, buildCursorConditions
│   ├── intent-builder.ts (250 LOC) — buildIntent, buildExistsIntent, applyDefaultFilters, applyRelationHints
│   └── dump.ts (100 LOC) — plan, dump, existsDump
├── hierarchy-helpers.ts (80 LOC) — extractRecursiveField, findSelfRefRelation, listAncestors, listDescendants
└── (existing files unchanged: filters.ts, mutation-builders/, etc.)
```

### Key Risk

- **TypeScript generics:** `QueryBuilderImpl<TResult>` requires all methods to preserve `this` type for chaining
- **Mixin challenge:** TypeScript doesn't support true mixins cleanly. Methods like `where()` return `this` (the builder), so extracted functions need `this: QueryBuilderImpl<T>` parameter
- **Hook integration:** `executeWithHooks` wraps all execution paths — tight coupling
- **createOrm is 500 LOC** — the factory itself also needs splitting

### Strategy: Prototype injection (not file splitting)

For QueryBuilderImpl, the cleanest approach is:
1. Keep QueryBuilderImpl as single class (for `this` return type)
2. Extract method BODIES into standalone functions
3. Class methods become thin wrappers: `where(...args) { return queryWhere(this, ...args); }`
4. Split `createOrm` into `orm-factory.ts` (factory) + `orm-instance.ts` (instance methods)

### Execution Steps

1. Extract `hierarchy-helpers.ts` (pure functions, zero risk)
2. Extract `createOrmInstance` to `orm-instance.ts`
3. Extract intent-building functions to `query-builder/intent-builder.ts`
4. Extract pagination functions to `query-builder/pagination.ts`
5. Extract dump/plan functions to `query-builder/dump.ts`
6. Extract execution functions to `query-builder/execution.ts`
7. Thin QueryBuilderImpl to dispatcher
8. Run ALL tests (unit + adapter NQL→SQL)

### Validation

- `pnpm vitest run packages/core` — all tests pass
- `pnpm vitest run packages/adapter-pgsql` — NQL→SQL pipeline unchanged
- `pnpm tsc --noEmit` clean
- Manual: verify `createOrm()` API unchanged

---

## Phase 5: PgsqlAdapter (XL effort) — ASSESSMENT ONLY

**File:** `packages/adapter-pgsql/src/pgsql-adapter.ts` (1,778 LOC)
**Coupling:** 40+ consumers. Core adapter in architecture.

### Recommendation: DEFER

**Rationale:**
- Already well-structured (clear method boundaries, no deep nesting)
- Most complexity already extracted: handlers/, recursive/, compiler.ts, deparse.ts
- 40+ consumers = highest blast radius in entire codebase
- Effort/DX ratio is worst of all 5 files
- Natural entropy is low (file grows slowly, ~50 LOC/month)

**If done later:**
- Split compilation into `plan-compiler.ts`, `subquery-compiler.ts`, `mutation-compiler.ts`, `recursive-compiler.ts`
- Split execution into `query-executor.ts`, `streaming.ts`
- Keep PgsqlAdapter as facade
- Requires parallel implementation + deprecation period

---

## Summary: Execution Sequence

| Phase | File | Effort | Sessions | Pre-req |
|-------|------|--------|----------|---------|
| 1 | intent-ast.ts | S (2-4h) | 1 session | None |
| 2 | NqlCstVisitor | M (8-16h) | 1-2 sessions | None |
| 3 | NQL Compiler | L (16-32h) | 2-3 sessions | Phase 2 done (same package) |
| 4 | QueryBuilderImpl | L (20-30h) | 2-3 sessions | None |
| 5 | PgsqlAdapter | XL (deferred) | — | — |

**Phases 1 and 2 are independent. Phase 3 depends on Phase 2 (same package). Phase 4 is independent.**
