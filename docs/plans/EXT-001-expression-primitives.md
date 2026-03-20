---
doc-type: spec
status: draft
story-id: EXT-001
title: Generic expression primitives + pgvector extension
created: 2026-03-20
adversarial_applied: true
---

# EXT-001 — Generic Expression Primitives + pgvector Extension

## Summary

Add dialect-agnostic expression primitives (`op`, `fn`, `ref`, `param`, `cast`) to `@dbsp/core` as public API, enabling custom operators and functions with proper parameter binding. Build pgvector extension wrappers in `adapter-pgsql/src/extensions/pgvector.ts` as the first consumer.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  @dbsp/core (DB-agnostic)                            │
│  op(), fn(), ref(), param(), cast() → ExpressionRef  │
│  New intent nodes: CustomOpIntent, CustomFnIntent    │
└──────────────────────┬───────────────────────────────┘
                       │ dialect-neutral intent
┌──────────────────────┼───────────────────────────────┐
│  @dbsp/types                                         │
│  CustomOpExpressionIntent, CustomFnExpressionIntent  │
│  WhereExpressionIntent, OrderByExpressionIntent      │
└──────────────────────┼───────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
  adapter-pgsql   (future adapters)
  ├─ handlers/expression/custom.ts
  ├─ handlers/where/custom-expression.ts
  └─ extensions/
     └─ pgvector.ts (cosineDistance, rawDistance, l2Distance)
```

## Design Decisions

1. **Primitives are PUBLIC API** — exported from `@dbsp/core`, not internal
2. **Dialect-agnostic** — core knows nothing about `<=>` or PostgreSQL; it's just a string operator
3. **Extensions live in adapter** — pgvector in `adapter-pgsql/src/extensions/`, future vss in adapter-duckdb
4. **Pass-through planner** — custom expressions bypass the planner (no optimization, no rewriting)
5. **Adapter throws on unsupported** — if an adapter can't compile a custom operator, it throws (not silent fail)

## API Design

### Core Primitives (`@dbsp/core`)

```typescript
// New file: packages/core/src/dx/expressions.ts

/** Column/field reference for use in expressions */
export function ref(column: string): ExpressionRef;

/** Parameterized value with automatic $N binding */
export function param(value: unknown): ExpressionRef;

/** Type cast: expr::type */
export function cast(expr: ExpressionRef, typeName: string): ExpressionRef;

/** Custom binary operator: left OP right
 *  Implicit conversion: string → ref(), number/array/boolean → param()
 *  Use ref()/param() explicitly for ambiguous cases */
export function op(operator: string, left: ExpressionRef | string, right: ExpressionRef | string | number | unknown[]): ExpressionRef;

/** Custom function call: name(args...) — supports schema-qualified names (e.g. 'paradedb.score')
 *  Implicit conversion: string → ref(), number/array/boolean → param() */
export function fn(name: string, ...args: (ExpressionRef | string | number | boolean | unknown[])[]): ExpressionRef;

/** Literal value (number, string, boolean, null) — use to distinguish
 *  literal('text') (SQL string 'text') from 'column_name' (column ref) */
export function literal(value: unknown): ExpressionRef;

/** Unary operator: OP expr (e.g. NOT, -, ~) */
export function unary(operator: string, expr: ExpressionRef | string): ExpressionRef;

/** Shared input type for op/fn arguments */
type ExprInput = ExpressionRef | string | number | boolean | unknown[];
// string → ref(), number/array/boolean → param(), ExpressionRef → as-is
```

### Semantics: param() vs literal()

| Primitive | SQL output | Use case |
|-----------|-----------|----------|
| `param(42)` | `$1` (bound parameter) | User values, vectors, dynamic data |
| `literal(42)` | `42` (inline in SQL) | Constants, thresholds, static config |
| `literal('text')` | `'text'` (SQL string) | Disambiguate from column ref |
| `'column'` (string in op/fn) | `"column"` (identifier) | Column reference (implicit ref()) |

### Note: Custom fn() and GROUP BY

Custom functions via `fn()` do NOT trigger automatic GROUP BY inference.
The planner treats them as opaque expressions. If aggregation is needed,
use the existing `count()`, `sum()`, `avg()` etc. from the aggregate API.

### ExpressionRef (chainable)

```typescript
interface ExpressionRef {
  // SELECT aliasing
  as(alias: string): ExpressionRef;

  // WHERE comparisons (returns WhereIntent, not ExpressionRef)
  eq(value: unknown): WhereExpressionIntent;
  neq(value: unknown): WhereExpressionIntent;
  gt(value: unknown): WhereExpressionIntent;
  gte(value: unknown): WhereExpressionIntent;
  lt(value: unknown): WhereExpressionIntent;
  lte(value: unknown): WhereExpressionIntent;

  // Internal: convert to ExpressionSpec for .columns()
  readonly __expr: true;
  readonly intent: CustomOpExpressionIntent | CustomFnExpressionIntent | ...;
}
```

### Usage in Query Builder

```typescript
// .column() — already accepts ExpressionSpec via __expr marker
orm.select('embeddings')
  .column(cosineDistance('vector', qv).as('score'))  // ExpressionRef → ExpressionSpec

// .where() — ExpressionRef.gte() returns WhereExpressionIntent
orm.select('embeddings')
  .where(cosineDistance('vector', qv).gte(0.5))  // WhereExpressionIntent

// .orderBy() — needs extension to accept ExpressionRef
orm.select('embeddings')
  .orderBy(rawDistance('vector', qv), 'asc')  // ExpressionRef + direction
```

### pgvector Wrappers (`adapter-pgsql/extensions/pgvector`)

```typescript
// packages/adapter-pgsql/src/extensions/pgvector.ts

import { op, ref, param, cast, literal } from '@dbsp/core';

/** Cosine similarity: 1 - (col <=> vector) — score in [0,1], higher = more similar */
export function cosineDistance(column: string, vector: number[]): ExpressionRef {
  return op('-', literal(1), op('<=>', ref(column), cast(param(vector), 'vector')));
}

/** Raw cosine distance: col <=> vector — for ORDER BY (lower = closer) */
export function rawDistance(column: string, vector: number[]): ExpressionRef {
  return op('<=>', ref(column), cast(param(vector), 'vector'));
}

/** L2 (Euclidean) distance: col <-> vector */
export function l2Distance(column: string, vector: number[]): ExpressionRef {
  return op('<->', ref(column), cast(param(vector), 'vector'));
}

/** Inner product distance: col <#> vector (negative inner product) */
export function innerProduct(column: string, vector: number[]): ExpressionRef {
  return op('<#>', ref(column), cast(param(vector), 'vector'));
}
```

## Intent Types (`@dbsp/types`)

### New Expression Intents

```typescript
// In packages/types/src/intent/expression-intent.ts

/** Custom binary operator expression */
interface CustomOpExpressionIntent {
  readonly kind: 'customOp';
  readonly operator: string;           // '<=>',  '@@', '@@@', etc.
  readonly left: ExpressionIntent;     // recursive
  readonly right: ExpressionIntent;    // recursive
  readonly as?: string;                // alias
}

/** Custom function call expression */
interface CustomFnExpressionIntent {
  readonly kind: 'customFn';
  readonly name: string;               // 'now', 'paradedb.score', 'ST_Distance'
  readonly args: readonly ExpressionIntent[];
  readonly as?: string;
}

/** Column reference expression */
interface RefExpressionIntent {
  readonly kind: 'ref';
  readonly column: string;             // 'table.column' or 'column'
}

/** Parameterized value */
interface ParamExpressionIntent {
  readonly kind: 'param';
  readonly value: unknown;
}

/** Type cast */
interface CastExpressionIntent {
  readonly kind: 'cast';
  readonly expr: ExpressionIntent;
  readonly typeName: string;           // 'vector', 'text', 'int[]'
}

/** Literal value */
interface LiteralExpressionIntent {
  readonly kind: 'literal';
  readonly value: unknown;             // number, string, boolean, null
}
```

### New WHERE Intent

```typescript
/** WHERE clause using a custom expression with comparison */
interface WhereExpressionIntent {
  readonly kind: 'expression';
  readonly expr: ExpressionIntent;     // the custom expression (left side)
  readonly operator: ComparisonOperator; // eq, neq, gt, gte, lt, lte
  readonly value: unknown;             // comparison value (right side)
}
```

### OrderBy Extension

```typescript
/** Extended OrderByIntent to support expressions */
interface OrderByIntent {
  readonly field?: string;             // existing: column name
  readonly expression?: ExpressionIntent; // NEW: expression for ordering
  readonly direction?: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
}
```

## Compiler Handlers (`adapter-pgsql`)

### Expression Handler

```typescript
// packages/adapter-pgsql/src/handlers/expression/custom.ts

// Handles 'customOp' and 'customFn' expression types in SELECT

// customOp → A_Expr { kind: 'AEXPR_OP', name: [String(op)], lexpr, rexpr }
//            ALWAYS wrapped in parentheses to prevent precedence bugs (from /llm consensus)
// unary    → A_Expr { kind: 'AEXPR_OP', name: [String(op)], rexpr } (no lexpr)
// customFn → FuncCall { funcname: [String(name)], args: [...] }
// ref      → ColumnRef { fields: [...] }
// param    → ParamRef via createParamRef(++state.paramIndex)
// cast     → TypeCast { arg, typeName }
// literal  → A_Const { ival/sval/fval }

// Recursive: compileExpressionIntent(intent, ctx, state): Node
```

### WHERE Handler

```typescript
// packages/adapter-pgsql/src/handlers/where/custom-expression.ts

// Handles 'expression' WhereIntent kind
// Compiles: expression OP value
// Left side: compileExpressionIntent(intent.expr, ctx, state)
// Right side: createParamRef for the value
// Combined via A_Expr with comparison operator
```

## Planner Behavior

Custom expressions are **pass-through** in the planner:
- `CustomOpExpressionIntent` → wrapped in `PlanDecision { type: 'selectExpression', expression: intent }`
- No optimization, no rewriting
- The planner treats them as opaque expressions to forward to the compiler

## Implementation Blocks

### Block 1: Intent Types + Core Primitives
**Scope:** types + core
**Files:**
- `packages/types/src/intent/expression-intent.ts` — new intent types (or extend existing)
- `packages/types/src/intent/where-intent.ts` — add WhereExpressionIntent
- `packages/types/src/intent/index.ts` — re-export
- `packages/core/src/dx/expressions.ts` — NEW: op, fn, ref, param, cast, literal, ExpressionRef
- `packages/core/src/dx/index.ts` — re-export
- `packages/core/src/dx/query-builder.ts` — extend orderBy to accept ExpressionRef

**Tests:**
- `packages/core/src/dx/expressions.test.ts` — unit tests for each primitive
- Verify intent nodes are correctly constructed

**Exit criteria:**
- All primitives produce correct intent nodes
- ExpressionRef chainable methods work
- Exported from @dbsp/core

### Block 2: Planner Pass-through
**Scope:** core planner
**Files:**
- `packages/core/src/planner.ts` — handle CustomOp/CustomFn in processSelect() and processWhere()

**Tests:**
- Plan a query with custom expression → verify PlanDecision contains the expression

**Exit criteria:**
- Custom expressions flow through planner to PlanReport unchanged

### Block 3: Compiler Handlers
**Scope:** adapter-pgsql
**Files:**
- `packages/adapter-pgsql/src/handlers/expression/custom.ts` — NEW: compile custom expressions to AST
- `packages/adapter-pgsql/src/handlers/expression/index.ts` — register handler
- `packages/adapter-pgsql/src/handlers/where/custom-expression.ts` — NEW: compile WHERE with expressions
- `packages/adapter-pgsql/src/handlers/where/index.ts` — register handler
- `packages/adapter-pgsql/src/adapter-compiler-select.ts` — handle expression in orderBy

**Tests:**
- `packages/adapter-pgsql/src/handlers/expression/__tests__/custom.test.ts` — compile custom expressions
- `packages/adapter-pgsql/src/handlers/where/__tests__/custom-expression.test.ts` — WHERE with expressions
- End-to-end: op('<=>', ...) → SQL with correct params

**Exit criteria:**
- `op('<=>', ref('vector'), cast(param(qv), 'vector'))` compiles to `"vector" <=> $1::vector`
- `fn('now')` compiles to `now()`
- WHERE expressions compile correctly with param binding
- ORDER BY expressions compile correctly

### Block 4: pgvector Extension + Integration Tests
**Scope:** adapter-pgsql extensions
**Files:**
- `packages/adapter-pgsql/src/extensions/pgvector.ts` — NEW: cosineDistance, rawDistance, l2Distance, innerProduct
- `packages/adapter-pgsql/src/extensions/index.ts` — NEW: re-export
- `packages/adapter-pgsql/src/index.ts` — export extensions path

**Tests:**
- `packages/adapter-pgsql/src/extensions/__tests__/pgvector.test.ts` — integration tests
- Full query compilation: `.column(cosineDistance(...).as('score')).where(...).orderBy(...)` → correct SQL

**Exit criteria:**
- cosineDistance produces `1 - ("vector" <=> $1::vector) AS "score"` with param binding
- Full SELECT/WHERE/ORDER BY integration works
- Exported from `@dbsp/adapter-pgsql`

## BDD Scenarios

### Scenario 1: Custom operator in SELECT
```
Given a query with .column(op('<=>', ref('vector'), cast(param([0.1,0.2]), 'vector')).as('dist'))
When compiled by adapter-pgsql
Then SQL contains: "vector" <=> $1::vector AS "dist"
And parameters[0] equals [0.1, 0.2]
```

### Scenario 2: Custom function in SELECT
```
Given a query with .column(fn('now').as('ts'))
When compiled
Then SQL contains: now() AS "ts"
And no parameters added
```

### Scenario 3: Schema-qualified function
```
Given a query with .column(fn('paradedb.score', ref('id')).as('score'))
When compiled
Then SQL contains: paradedb.score("id") AS "score"
```

### Scenario 4: Expression in WHERE
```
Given a query with .where(op('<=>', ref('vector'), cast(param(qv), 'vector')).lte(0.5))
When compiled
Then WHERE clause contains: ("vector" <=> $1::vector) <= $2
And parameters equals [qv, 0.5]
```

### Scenario 5: Expression in ORDER BY
```
Given a query with .orderBy(op('<=>', ref('vector'), cast(param(qv), 'vector')), 'asc')
When compiled
Then ORDER BY clause contains: "vector" <=> $1::vector ASC
```

### Scenario 6: pgvector cosineDistance integration
```
Given a query:
  orm.select('embeddings')
    .column(cosineDistance('vector', [0.1, 0.2]).as('score'))
    .where(cosineDistance('vector', [0.1, 0.2]).gte(0.5))
    .orderBy(rawDistance('vector', [0.1, 0.2]), 'asc')
    .limit(20)
When compiled
Then SQL equals:
  SELECT 1 - ("embeddings"."vector" <=> $1::vector) AS "score"
  FROM "embeddings"
  WHERE 1 - ("embeddings"."vector" <=> $2::vector) >= $3
  ORDER BY "embeddings"."vector" <=> $4::vector ASC
  LIMIT 20
And parameters equals [[0.1,0.2], [0.1,0.2], 0.5, [0.1,0.2]]
```

### Scenario 7: Nested expressions
```
Given op('-', literal(1), op('<=>', ref('v'), cast(param(qv), 'vector')))
When compiled
Then SQL contains: 1 - ("v" <=> $1::vector)
```

### Scenario 8: Cast to array type
```
Given cast(param([1,2,3]), 'int[]')
When compiled
Then SQL contains: $1::int[]
```

### Scenario 9: Implicit conversion in op()
```
Given op('<=>', 'vector', [0.1, 0.2])
When compiled
Then SQL equals: op('<=>', ref('vector'), param([0.1, 0.2]))
And "vector" is treated as column ref, [0.1,0.2] as parameterized value
```

### Scenario 10: Column-vs-column with ref()
```
Given op('<=>', ref('e1.vector'), ref('e2.vector'))
When compiled
Then SQL contains: "e1"."vector" <=> "e2"."vector"
And no parameters added
```

### Scenario 11: Invalid operator name throws
```
Given op(''); DROP TABLE--', ref('col'), param(1))
When constructed
Then throws Error with message containing "invalid operator"
```

## Hardening (from /adversarial)

### Implicit conversion in op()/fn()
- String args → `ref()` (column reference)
- Number/array/boolean args → `param()` (parameterized value)
- `ref()`, `param()`, `literal()` available for ambiguous cases (e.g., `literal('text')` for SQL string vs `'column'` for ref)

### Input validation (security)
- Operator names: `/^[a-zA-Z_<>=!@#%^&|~*+\-\/.]+$/` — reject SQL injection attempts
- Function names: `/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/` — alphanumeric + optional schema qualifier
- Type names in cast(): validated format, no arbitrary SQL
- Null values in custom ops: throw explicitly (use `isNull()` instead)

### .as() semantics
- `.as(alias)` returns a NEW ExpressionRef with alias set
- Alias only affects SELECT (ResTarget.name), NOT WHERE or ORDER BY usage
- `.gte()` / `.lt()` etc. ignore the alias — they produce WhereIntent from the underlying expression

### Column-vs-column support
- `op('<=>', ref('e1.vector'), ref('e2.vector'))` works naturally via ref() producing ColumnRef
- NOT out of scope — it's a natural consequence of the design

### Known limitation: param duplication
- Same expression used in SELECT + WHERE + ORDER BY produces 3 separate parameter bindings
- Acceptable for v1 — PostgreSQL handles duplicate params efficiently
- Param deduplication deferred to v2

## Out of Scope

- ParadeDB extension (EXT-002 — separate story)
- LATERAL subquery support
- Expression optimization in planner
- Type inference from schema (knowing vector column type)
- Param deduplication (v2)

## Risks

| Risk | Mitigation |
|------|-----------|
| Param binding duplication (same expression in SELECT + WHERE + ORDER BY) | Accept duplicate params for v1; optimize later |
| ExpressionRef vs ExpressionSpec confusion | ExpressionRef implements ExpressionSpec (__expr marker) |
| Breaking existing .orderBy() API | Extend signature, don't change existing overloads |
| Schema-qualified fn names (paradedb.score) | Split on first dot → schema.name in FuncCall.funcname |
