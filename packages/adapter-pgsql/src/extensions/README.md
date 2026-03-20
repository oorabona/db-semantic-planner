# Writing a New Extension Module

Extensions expose PostgreSQL-specific functions and operators (pgvector, PostGIS, ParadeDB, etc.)
as type-safe query builders. They are thin wrappers over the five core expression primitives —
no SQL strings, no manual parameter numbering.

## The Five Core Primitives (from `@dbsp/core`)

| Primitive | Compiles to | When to use |
|-----------|-------------|-------------|
| `op(operator, left, right)` | `left OP right` | Binary operators: `<=>`, `&&`, `@>`, `-` … |
| `fn(name, ...args)` | `name(arg1, arg2, ...)` | Function calls: `ST_DWithin(...)`, `paradedb.score(...)` |
| `exprRef(column)` | `"column"` | Column references (quoted identifiers) |
| `param(value)` | `$N` | User-supplied values — always bound, never interpolated |
| `cast(expr, type)` | `CAST(expr AS type)` | Type casts: `CAST($1 AS vector)`, `CAST($1 AS geometry)` |
| `literal(value)` | bare value | Compile-time constants (numbers, strings): `1`, `'name'` |

All primitives return `ExpressionRef`. Use `.as(alias)` to alias in SELECT;
use the ref directly in `.where()` and `.orderBy()`.

## Pattern to Follow: `pgvector.ts`

```
pgvector.ts
│
├─ file header (what the extension wraps, usage contexts)
├─ import { cast, ExpressionRef, exprRef, literal, op, param } from '@dbsp/core'
├─ one exported function per operator/function
│   ├─ TSDoc: what it compiles to, @param, @returns, @example
│   └─ body: compose primitives, return ExpressionRef
└─ (no default export, no classes)
```

## Step-by-step

### 1. Create the file

```
packages/adapter-pgsql/src/extensions/<name>.ts
```

### 2. Import only the primitives you need

```typescript
import { cast, type ExpressionRef, exprRef, fn, literal, op, param } from '@dbsp/core';
```

### 3. Write one function per operator/function

```typescript
/**
 * What this compiles to and when to use it.
 *
 * @param column - Column name
 * @param value  - User-supplied value (bound as $N)
 * @returns ExpressionRef for use in .where() / .column() / .orderBy()
 *
 * @example
 * orm.select('places').where(stDWithin('geom', point, 1000))
 * // → ST_DWithin("geom", $1, $2)
 */
export function stDWithin(
    column: string,
    point: [number, number],
    radiusMeters: number,
): ExpressionRef {
    return fn('ST_DWithin', exprRef(column), param(point), param(radiusMeters));
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

import { type ExpressionRef, exprRef, fn, param } from '@dbsp/core';

/**
 * Spatial distance filter — within N metres.
 *
 * Compiles to: ST_DWithin("column", $N, $M)
 *
 * @example
 * orm.select('places').where(stDWithin('geom', userPoint, 500))
 * // → WHERE ST_DWithin("geom", $1, $2)
 */
export function stDWithin(
    column: string,
    point: unknown,
    radiusMeters: number,
): ExpressionRef {
    return fn('ST_DWithin', exprRef(column), param(point), param(radiusMeters));
}

/**
 * Distance between two geometry columns or a column and a point.
 *
 * Compiles to: ST_Distance("column", $N)
 *
 * @example
 * orm.select('places').orderBy(stDistance('geom', userPoint), 'asc')
 * // → ORDER BY ST_Distance("geom", $1) ASC
 */
export function stDistance(column: string, point: unknown): ExpressionRef {
    return fn('ST_Distance', exprRef(column), param(point));
}

/**
 * Transform geometry to a target SRID.
 *
 * Compiles to: ST_Transform("column", literal_srid)
 *
 * @example
 * orm.select('places').column(stTransform('geom', 4326).as('wgs84'))
 * // → ST_Transform("geom", 4326) AS "wgs84"
 */
export function stTransform(column: string, targetSrid: number): ExpressionRef {
    return fn('ST_Transform', exprRef(column), literal(targetSrid));
}
```

## Key Rules

| Rule | Reason |
|------|--------|
| Use `param()` for all user values | Prevents SQL injection; compiler assigns `$N` automatically |
| Use `literal()` for compile-time constants only | Constants never carry injection risk |
| Use `exprRef()` for column names, never string interpolation | Ensures double-quoting by the compiler |
| Return `ExpressionRef`, never a raw string | Lets the compiler compose and renumber params correctly |
| No raw SQL strings | The compiler cannot inspect or renumber inline SQL fragments |

## Real Examples

- **`pgvector.ts`** — binary operators (`op`), casts (`cast`): distance metrics `<=>`, `<->`, `<#>`
- **`paradedb.ts`** — function calls (`fn`), literals, composition of multiple `ExpressionRef` args: BM25 search functions
