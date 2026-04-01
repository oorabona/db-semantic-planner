---
title: Expression Primitives
---

# How to Use Expression Primitives

Expression primitives are the building blocks for any SQL construct that the built-in filter helpers do not cover — vector distance operators, extension functions, type casts, arithmetic, and named arguments. Use this guide when you need to compose custom SQL expressions in SELECT columns, WHERE clauses, or ORDER BY without dropping down to raw SQL strings.

## When

Use expression primitives when you need PostgreSQL operators or functions not covered by the
built-in filter helpers (`eq`, `gt`, `like`, etc.). Common cases:

- Vector distance operators (`<=>`, `<->`, `<#>`)
- Extension functions (`paradedb.score`, `ST_Distance`, `jsonb_path_query`)
- Type casts (`::vector`, `::jsonb`, `::int`)
- Arithmetic expressions in SELECT or ORDER BY
- Named-argument function syntax (`field => 'value'`)

## Core Primitives

All primitives are exported from `@dbsp/core`.

### `ref(column)` — column reference

```typescript
import { ref } from '@dbsp/core';

ref('embedding')       // → "embedding"
ref('t.score')         // → "t"."score"
```

Use `ref()` when you have a string that represents a column name (not a value).

### `param(value)` — parameterized value

```typescript
import { param } from '@dbsp/core';

param([0.1, 0.2, 0.3])  // → $1  (value bound to $1)
param('hello')           // → $2  (string bound as parameter, NOT a column ref)
```

Use `param()` for any user-supplied data — vectors, scalars, arrays. The value is
safely bound via `$N` positional parameters; it never appears inline in the SQL string.

### `op(operator, left, right)` — binary operator

```typescript
import { op, ref, param, cast } from '@dbsp/core';

// Cosine distance (pgvector raw)
op('<=>', ref('embedding'), cast(param([0.1, 0.2]), 'vector'))
// → "embedding" <=> $1::vector

// Arithmetic
op('-', 1, op('<=>', ref('embedding'), cast(param(qv), 'vector')))
// → 1 - ("embedding" <=> $1::vector)
```

Implicit conversions apply to `left` and `right`:
- `string` → `ref()` (column reference)
- `number | boolean | readonly unknown[]` → `param()` (bound value)

Use `ref()` / `param()` explicitly when a string is a value (not a column name).

### `fn(name, ...args)` — function call

```typescript
import { fn, ref, param } from '@dbsp/core';

fn('now')                                  // → now()
fn('paradedb.score', ref('id'))            // → paradedb.score("id")
fn('ST_Distance', ref('location'), param(point))  // → ST_Distance("location", $1)
fn('jsonb_array_length', ref('tags'))     // → jsonb_array_length("tags")
```

Schema-qualified names like `paradedb.score` are supported. Implicit conversions apply
to all arguments (same rules as `op()`).

### `cast(expr, type)` — type cast

```typescript
import { cast, param, ref } from '@dbsp/core';

cast(param([0.1, 0.2]), 'vector')   // → $1::vector
cast(ref('score'), 'float4')        // → "score"::float4
cast(param('2024-01-01'), 'date')   // → $1::date
```

The type name is validated against an identifier regex — injection is prevented.

### `literal(value)` — inline SQL value

```typescript
import { literal } from '@dbsp/core';

literal(1)      // → 1    (used in: 1 - (col <=> vec))
literal('asc')  // → 'asc'
literal(null)   // → NULL
```

Use `literal()` only for constants that must be inlined (e.g., arithmetic constants,
SQL keywords). For user data, always use `param()`.

### `unary(operator, expr)` — unary operator

```typescript
import { unary, ref } from '@dbsp/core';

unary('NOT', ref('active'))   // → NOT "active"
unary('-', ref('score'))      // → -"score"
unary('~', ref('flags'))      // → ~"flags"
```

### `namedArg(name, value)` — PostgreSQL named argument

```typescript
import { namedArg, literal, param } from '@dbsp/core';

namedArg('field', literal('name'))       // → field => 'name'
namedArg('query_string', param('hello')) // → query_string => $1
```

Used inside `fn()` to produce PostgreSQL named-parameter syntax (`=>` form),
as required by some extension functions (e.g., `paradedb.parse`).

### `star()` — SQL wildcard (*)

```typescript
import { star, fn } from '@dbsp/core';

star()                  // → *
fn('count', star())     // → count(*)
```

Use `star()` inside `fn()` to produce aggregate functions that operate on all rows.
Do not use it in `.column()` directly — use the query builder's select-all default instead.

### `array(...items)` — PostgreSQL ARRAY constructor

```typescript
import { array, literal, ref, param } from '@dbsp/core';

array(literal(1), literal(2), literal(3))  // → ARRAY[1, 2, 3]
array(ref('name'), ref('kind'))            // → ARRAY["name", "kind"]
array(param('a'), param('b'))              // → ARRAY[$1, $2]
```

Implicit conversions apply to all items (same rules as `fn()` and `op()`).

### COUNT(*)

```typescript
import { fn, star, cast, eq } from '@dbsp/core';

fn('count', star())                     // → count(*)
fn('count', star()).filter(eq(...))     // → count(*) FILTER (WHERE ...)
cast(fn('count', star()), 'int')        // → CAST(count(*) AS int)
```

## ExpressionRef Chaining

All primitives return an `ExpressionRef` — a chainable wrapper with three usage modes:

### `.as(alias)` — alias in SELECT

```typescript
op('<=>', ref('embedding'), cast(param(qv), 'vector')).as('distance')
// → "embedding" <=> $1::vector AS "distance"
```

### Comparison methods — use in `.where()`

```typescript
expr.eq(value)   // expr = $N
expr.neq(value)  // expr != $N
expr.gt(value)   // expr > $N
expr.gte(value)  // expr >= $N
expr.lt(value)   // expr < $N
expr.lte(value)  // expr <= $N
```

These return a `WhereExpressionIntent` accepted by `.where()`.

## Implicit Conversion Summary

| Input type | Converted to |
|------------|--------------|
| `ExpressionRef` | used as-is |
| `string` | `ref(string)` — column reference |
| `number` | `param(number)` — bound value |
| `boolean` | `param(boolean)` — bound value |
| `readonly unknown[]` | `param(array)` — bound value |

When a string is a value (not a column), use `param()` or `literal()` explicitly.

## Use in Query Builder

```typescript
import { op, ref, param, cast, unary } from '@dbsp/core';

const qv = [0.1, 0.2, 0.3];

// .column() — expression with alias in SELECT
orm.select('embeddings')
  .column(op('<=>', ref('vector'), cast(param(qv), 'vector')).as('distance'))

// .where() — expression comparison
orm.select('embeddings')
  .where(op('<=>', ref('vector'), cast(param(qv), 'vector')).lte(0.5))

// .orderBy() — expression with direction
orm.select('embeddings')
  .orderBy(op('<=>', ref('vector'), cast(param(qv), 'vector')), 'asc')

// Combining all three
orm.select('embeddings')
  .column(op('-', literal(1), op('<=>', ref('vector'), cast(param(qv), 'vector'))).as('score'))
  .where(op('-', literal(1), op('<=>', ref('vector'), cast(param(qv), 'vector'))).gte(0.5))
  .orderBy(op('<=>', ref('vector'), cast(param(qv), 'vector')), 'asc')
```

## Security

- `op()`, `fn()`, `unary()`, `namedArg()` validate their operator/name arguments
  against a strict identifier regex — SQL injection via operator strings is prevented.
- `cast()` validates the type name the same way.
- User data MUST go through `param()` — values are bound as `$N` positional parameters,
  never interpolated into the SQL string.
- `literal()` is for constants only — never pass user input to `literal()`.

## PostgreSQL Built-in Helpers

Adapter-level helpers for common PostgreSQL functions, built on the same expression primitives:

```typescript
import { generateSeries, nextval } from '@dbsp/adapter-pgsql';
```

### `generateSeries(start, stop, step?)`

Generate a series of values (commonly used with CTE for batch operations):

```typescript
generateSeries(1, 100)       // → generate_series(1, 100)
generateSeries(0, 50, 5)     // → generate_series(0, 50, 5)
```

### `nextval(sequenceName)`

Get the next value from a PostgreSQL sequence:

```typescript
nextval('order_id_seq')      // → nextval('order_id_seq')
```

### `isDistinctFrom(field, value)`

Null-safe inequality comparison (SQL:2003 standard). Unlike `neq()`, returns `true` when one side is NULL and the other is not:

```typescript
import { isDistinctFrom } from '@dbsp/core';

orm.select('users').where(isDistinctFrom('status', 'active'))
// SQL: WHERE status IS DISTINCT FROM $1
```

> Note: `isDistinctFrom` is a core filter (not an adapter extension) because `IS DISTINCT FROM` is standard SQL.

## Key Files

- `packages/core/src/dx/expressions.ts` — `ExpressionRef`, `op`, `fn`, `ref`, `param`, `cast`, `literal`, `unary`, `namedArg`, `star`, `array`
- `packages/core/src/dx/filters.ts` — `isDistinctFrom`, `inSubquery` and other filter helpers
- `packages/adapter-pgsql/src/extensions/pgvector.ts` — pgvector helpers built on these primitives
- `packages/adapter-pgsql/src/extensions/paradedb.ts` — ParadeDB helpers built on these primitives
- `packages/adapter-pgsql/src/extensions/pgsql-builtins.ts` — `generateSeries`, `nextval`
- `packages/adapter-pgsql/src/handlers/expression/` — compiler handlers for each expression kind

