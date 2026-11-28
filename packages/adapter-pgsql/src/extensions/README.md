# Writing a New Extension Module

Extensions expose PostgreSQL-specific functions and operators (pgvector, PostGIS, ParadeDB, etc.)
as type-safe query builders. They are thin wrappers over the core expression primitives —
no SQL strings, no manual parameter numbering.

## The Core Primitives (from `@dbsp/core`)

| Primitive | Compiles to | When to use |
|-----------|-------------|-------------|
| `op(operator, left, right)` | `left OP right` | Binary operators: `<=>`, `&&`, `@>`, `-` … |
| `fn(name, ...args)` | `name(arg1, arg2, ...)` | Function calls: `ST_DWithin(...)`, `paradedb.score(...)` |
| `exprRef(column)` | `"column"` | A column the helper names itself (a user column goes through `referenceLeaf()`) |
| `param(value)` | `$N` | A value the helper binds itself (a user value goes through `valueLeaf()`) |
| `cast(expr, type)` | `CAST(expr AS type)` | Type casts: `CAST($1 AS vector)`, `CAST($1 AS geometry)` |
| `literal(value)` | bare value | Compile-time constants (numbers, strings): `1`, `'name'` |

All primitives return `ExpressionRef`. Use `.as(alias)` to alias in SELECT;
use the ref directly in `.where()` and `.orderBy()`.

## User Arguments: the Leaf Rule (ADR 0011)

A helper never wraps a user argument in `param()` or `exprRef()` directly: that would bind an
expression the user passed as a parameter object, or refuse a `ColumnRef`. It coerces each
argument first, under its own name, with the helpers of `./leaves.ts` (built on
`@dbsp/core/internal`'s `coerceValue` / `coerceReference`):

| Argument | Helper | Result |
|----------|--------|--------|
| A user value (a query, a vector, a point) | `valueLeaf(arg, 'helperName')` | a plain value is bound as `$N`; an expression is compiled |
| A column, a key field, a sub-expression | `referenceLeaf(arg, 'helperName')` | a string is a column, a `ColumnRef` its qualified column, an expression is compiled |
| A name the SQL takes as text (a table, an index field) | `nameArgument(arg, 'helperName', 'reason')` | a string only; anything else is refused |
| A constant of the helper (a weight, an SRID) | `literal(value)` | inlined |

## Pattern to Follow: `pgvector.ts`

```
pgvector.ts
│
├─ file header (what the extension wraps, usage contexts)
├─ import { cast, type ExpressionRef, literal, op, type ReferenceLeaf } from '@dbsp/core'
├─ import { referenceLeaf, valueLeaf } from './leaves.js'
├─ one exported function per operator/function
│   ├─ TSDoc: what it compiles to, @param, @returns, @example
│   └─ body: coerce each user argument, compose primitives, return ExpressionRef
└─ (no default export, no classes)
```

## Step-by-step

### 1. Create the file

```
packages/adapter-pgsql/src/extensions/<name>.ts
```

### 2. Import only the primitives and leaf helpers you need

```typescript
import { cast, type ExpressionRef, fn, literal, op, type ReferenceLeaf } from '@dbsp/core';
import { referenceLeaf, valueLeaf } from './leaves.js';
```

### 3. Write one function per operator/function

```typescript
/**
 * What this compiles to and when to use it.
 *
 * @param column - A column name, a `ColumnRef` or an expression (reference leaf)
 * @param point  - A user value (value leaf): bound as $N, or compiled if an expression
 * @returns ExpressionRef for use in .where() / .column() / .orderBy()
 *
 * @example
 * orm.select('places').where(stDWithin('geom', point, 1000))
 * // → ST_DWithin(geom, $1, $2)
 */
export function stDWithin(
    column: ReferenceLeaf,
    point: unknown,
    radiusMeters: unknown,
): ExpressionRef {
    return fn(
        'ST_DWithin',
        referenceLeaf(column, 'stDWithin'),
        valueLeaf(point, 'stDWithin'),
        valueLeaf(radiusMeters, 'stDWithin'),
    );
}
```

### 4. Export from `index.ts`

```typescript
// packages/adapter-pgsql/src/extensions/index.ts
export { stDWithin, stDistance } from './postgis.js';
```

Note the `.js` extension — required for ESM compatibility at runtime.

### 5. Write tests

Mirror the test files in `__tests__/`. Compile the expression via a minimal plan and assert the
full SQL string with `sql.equals` (never `sql.contains`).

## Example: Minimal PostGIS Extension

```typescript
// packages/adapter-pgsql/src/extensions/postgis.ts

/**
 * PostGIS Extension Wrappers
 *
 * Type-safe builders for PostGIS spatial functions.
 * All functions return ExpressionRef usable in SELECT, WHERE, and ORDER BY.
 */

import { type ExpressionRef, fn, literal, type ReferenceLeaf } from '@dbsp/core';
import { referenceLeaf, valueLeaf } from './leaves.js';

/**
 * Spatial distance filter — within N metres.
 *
 * Compiles to: ST_DWithin(column, $N, $M)
 *
 * @example
 * orm.select('places').where(stDWithin('geom', userPoint, 500))
 * // → WHERE ST_DWithin(geom, $1, $2)
 */
export function stDWithin(
    column: ReferenceLeaf,
    point: unknown,
    radiusMeters: unknown,
): ExpressionRef {
    return fn(
        'ST_DWithin',
        referenceLeaf(column, 'stDWithin'),
        valueLeaf(point, 'stDWithin'),
        valueLeaf(radiusMeters, 'stDWithin'),
    );
}

/**
 * Distance between two geometry columns or a column and a point.
 *
 * Compiles to: ST_Distance(column, $N)
 *
 * @example
 * orm.select('places').orderBy(stDistance('geom', userPoint), 'asc')
 * // → ORDER BY ST_Distance(geom, $1) ASC
 */
export function stDistance(column: ReferenceLeaf, point: unknown): ExpressionRef {
    return fn(
        'ST_Distance',
        referenceLeaf(column, 'stDistance'),
        valueLeaf(point, 'stDistance'),
    );
}

/**
 * Transform geometry to a target SRID.
 *
 * Compiles to: ST_Transform(column, literal_srid)
 *
 * @example
 * orm.select('places').column(stTransform('geom', 4326).as('wgs84'))
 * // → ST_Transform(geom, 4326) AS "wgs84"
 */
export function stTransform(column: ReferenceLeaf, targetSrid: number): ExpressionRef {
    return fn('ST_Transform', referenceLeaf(column, 'stTransform'), literal(targetSrid));
}
```

## Key Rules

| Rule | Reason |
|------|--------|
| Pass every user value through `valueLeaf()` | A plain value is bound (no SQL injection, `$N` assigned by the compiler); an expression is compiled, never bound as an object |
| Pass every user column or sub-expression through `referenceLeaf()` | A string is a quoted column, a `ColumnRef` keeps its qualification, `null` or a plain object is refused by name |
| Use `literal()` for the helper's own constants only | Constants never carry injection risk |
| Return `ExpressionRef`, never a raw string | Lets the compiler compose and renumber params correctly |
| No raw SQL strings | The compiler cannot inspect or renumber inline SQL fragments |

## Real Examples

- **`pgvector.ts`** — binary operators (`op`), casts (`cast`), a reference column and a value vector: distance metrics `<=>`, `<->`, `<#>`
- **`paradedb.ts`** — function calls (`fn`), named arguments, value queries, reference sub-expressions and name arguments: BM25 search functions
