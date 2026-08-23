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

### `exprRef(column)` — column reference

```typescript
import { exprRef } from '@dbsp/core';

exprRef('embedding')       // → embedding
exprRef('t.score')         // → t.score
```

Use `exprRef()` when you have a string that represents a column name (not a value).

### `param(value)` — parameterized value

```typescript
import { param } from '@dbsp/core';

param([0.1, 0.2, 0.3])  // → $1  (value bound to $1)
param('hello')           // → $1  (string bound as parameter, NOT a column ref)
```

Use `param()` for any user-supplied data — vectors, scalars, arrays. The value is
safely bound via `$N` positional parameters; it never appears inline in the SQL string.

### `op(operator, left, right)` — binary operator

```typescript
import { op, exprRef, param, cast } from '@dbsp/core';

// Cosine distance (pgvector raw)
op('<=>', exprRef('embedding'), cast(param([0.1, 0.2]), 'vector'))
// → embedding <=> CAST($1 AS vector)

// Arithmetic
const queryVec = [0.1, 0.2];
op('-', 1, op('<=>', exprRef('embedding'), cast(param(queryVec), 'vector')))
// → $1 - (embedding <=> CAST($2 AS vector))
```

Implicit conversions apply to `left` and `right`:
- `string` → `exprRef()` (column reference)
- `number | boolean | readonly unknown[]` → `param()` (bound value)

Use `exprRef()` / `param()` explicitly when a string is a value (not a column name).

#### Predicate operators in `.where()`

`op()` returns a `PredicateRef` when its operator is a known boolean operator:
`=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `AND`, `OR`, `NOT`, `@@`, `@@@`, `&&`,
`<@`, or `@>`.

Use the dedicated WHERE helpers for the other predicate forms: `like()` (pass
`{ caseInsensitive: true }` for ILIKE), `inArray()`/`inSubquery()`,
`isNull()`/`isNotNull()`, `isDistinctFrom()`, `exists()`/`notExists()`, and
the PostgreSQL range helpers. Scalar `BETWEEN` remains available through the
NQL `where age between 18 and 65` filter syntax. Those unsupported spellings
use their dedicated helpers: outside its declared logical `NOT` overload,
`op()` has no unary or ternary form and only its closed binary
predicate-operator set returns a predicate.

The branded direct `.where()` predicate routes add that closed `op()` set,
`boolFn()`, and `unsafeAsPredicate()` beside the existing expression comparison
methods, filter helpers, full-text and range helpers, object filters, and direct
`WhereIntent` forms. Predicate recognition is local to one installed `@dbsp/core`
copy; reconstruct a predicate through the local factories rather than passing one
created by another copy.

```typescript
import { createOrm, exprRef, op, schema } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const predicateDb = schema({
  users: {
    ownerId: 'integer',
    editorId: 'integer',
    disabled: 'boolean',
    enabled: 'boolean',
  },
} as const);
const orm = createOrm({ schema: predicateDb, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('users').where(op('!=', exprRef('ownerId'), exprRef('editorId')))

orm.select('users').where(
  op('AND',
    op('!=', exprRef('ownerId'), exprRef('editorId')),
    op('NOT', op('=', exprRef('disabled'), exprRef('enabled'))),
  ),
)
```

For a user-defined operator that returns boolean, use the explicit assertion
`unsafeAsPredicate(op('~=', exprRef('left'), exprRef('right')))`. It is an
escape hatch; arbitrary operator strings otherwise remain scalar `ExpressionRef`
values. PostgreSQL user-defined operators must satisfy the adapter's symbolic
operator grammar. For a boolean-valued function, use `boolFn(name, ...args)`
instead: `fn()` builds a scalar expression, while `boolFn()` declares the
function a predicate.

### `fn(name, ...args)` — function call

```typescript
import { fn, exprRef, param } from '@dbsp/core';

const point = [0.0, 0.0]; // example point coordinate

fn('now')                                  // → now()
fn('paradedb.score', exprRef('id'))            // → paradedb.score(id)
fn('ST_Distance', exprRef('location'), param(point))  // → "ST_Distance"(location, $1)
fn('jsonb_array_length', exprRef('tags'))     // → jsonb_array_length(tags)
```

Schema-qualified names like `paradedb.score` are supported. Implicit conversions apply
to all arguments (same rules as `op()`).

### `cast(expr, type)` — type cast

```typescript
import { cast, param, exprRef } from '@dbsp/core';

cast(param([0.1, 0.2]), 'vector')   // → CAST($1 AS vector)
cast(exprRef('score'), 'float4')        // → CAST(score AS float4)
cast(param('2024-01-01'), 'date')   // → CAST($1 AS date)
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
import { unary, exprRef } from '@dbsp/core';

unary('NOT', exprRef('active'))   // → NOT active
unary('-', exprRef('score'))      // → - score
unary('~', exprRef('flags'))      // → ~ flags
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
import { array, literal, exprRef, param } from '@dbsp/core';

array(literal(1), literal(2), literal(3))  // → ARRAY[1, 2, 3]
array(exprRef('name'), exprRef('kind'))            // → ARRAY[name, kind]
array(param('a'), param('b'))              // → ARRAY[$1, $2]
```

Implicit conversions apply to all items (same rules as `fn()` and `op()`).

### COUNT(*)

```typescript
// doctest: skip — pseudo-code with placeholders (replace `(...)` with concrete arguments to make runnable)
import { fn, star, cast, eq } from '@dbsp/core';

fn('count', star())                     // → count(*)
fn('count', star()).filter(eq(...))     // → count(*) FILTER (WHERE ...)
cast(fn('count', star()), 'int')        // → CAST(count(*) AS int)
```

## ExpressionRef Chaining

All primitives return an `ExpressionRef` — a chainable wrapper with three usage modes:

### `.as(alias)` — alias in SELECT

```typescript
import { cast, op, param, exprRef } from '@dbsp/core';

const queryVec = [0.1, 0.2];

op('<=>', exprRef('embedding'), cast(param(queryVec), 'vector')).as('distance')
// → embedding <=> CAST($1 AS vector) AS distance
```

### Comparison methods — use in `.where()`

```typescript
// doctest: skip — fluent expression API reference (replace `expr` with a real expression call)
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
| `string` | `exprRef(string)` — column reference |
| `number` | `param(number)` — bound value |
| `boolean` | `param(boolean)` — bound value |
| `readonly unknown[]` | `param(array)` — bound value |

When a string is a value (not a column), use `param()` or `literal()` explicitly.

## Use in Query Builder

```typescript
import { schema, createOrm, op, exprRef, param, cast, literal } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  embeddings: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    vector: { type: 'text', dbType: 'vector(768)' },
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const qv = [0.1, 0.2, 0.3];

// .columns([expr]) — expression with alias in SELECT
orm.select('embeddings')
  .columns([op('<=>', exprRef('vector'), cast(param(qv), 'vector')).as('distance')])
  .dump();

// .where() — expression comparison
orm.select('embeddings')
  .where(op('<=>', exprRef('vector'), cast(param(qv), 'vector')).lte(0.5))
  .dump();

// .orderBy() — expression with direction
orm.select('embeddings')
  .orderBy(op('<=>', exprRef('vector'), cast(param(qv), 'vector')), 'asc')
  .dump();

// Combining all three
orm.select('embeddings')
  .columns([op('-', literal(1), op('<=>', exprRef('vector'), cast(param(qv), 'vector'))).as('score')])
  .where(op('-', literal(1), op('<=>', exprRef('vector'), cast(param(qv), 'vector'))).gte(0.5))
  .orderBy(op('<=>', exprRef('vector'), cast(param(qv), 'vector')), 'asc')
  .dump();
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
import { generateSeries } from '@dbsp/adapter-pgsql';

generateSeries(1, 100)       // → generate_series(1, 100)
generateSeries(0, 50, 5)     // → generate_series(0, 50, 5)
```

### `nextval(sequenceName)`

Get the next value from a PostgreSQL sequence:

```typescript
import { nextval } from '@dbsp/adapter-pgsql';

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

- `packages/core/src/dx/expressions.ts` — `ExpressionRef`, `op`, `fn`, `exprRef`, `param`, `cast`, `literal`, `unary`, `namedArg`, `star`, `array`
- `packages/core/src/dx/filters.ts` — `isDistinctFrom`, `inSubquery` and other filter helpers
- `packages/adapter-pgsql/src/extensions/pgvector.ts` — pgvector helpers built on these primitives
- `packages/adapter-pgsql/src/extensions/paradedb.ts` — ParadeDB helpers built on these primitives
- `packages/adapter-pgsql/src/extensions/pgsql-builtins.ts` — `generateSeries`, `nextval`
- `packages/adapter-pgsql/src/handlers/expression/` — compiler handlers for each expression kind
