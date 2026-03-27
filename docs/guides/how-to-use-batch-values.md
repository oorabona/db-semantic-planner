# How to Use Batch Values (Virtual Data Source)

## When

When you need to pass an in-memory array of records into a query as a virtual table —
without inserting them into the database first. Typical use cases:

- **Bulk UPDATE FROM** — update multiple rows in one SQL round-trip using a lookup table
- **Filtered SELECT** — join an existing table against an in-memory set to return only matching rows
- **Ordered lookup** — fetch rows in a caller-defined order using `WITH ORDINALITY`
- **In-memory filtering** — use a set of ids/values as a dynamic IN-list alternative that scales

`batchValues()` compiles to PostgreSQL's `unnest($1::type[], $2::type[], ...) AS alias(col1, col2, ...)`
which is a single parameterized rangefunction — zero extra round-trips, no temp tables.

## API

### Standalone factory (import from `@dbsp/core`)

```typescript
import { batchValues } from '@dbsp/core'

batchValues(
  data: readonly unknown[][],    // Column-major: one array per column
  columns: readonly string[],   // Column names for the unnest alias
  types: readonly string[],     // PostgreSQL type names: 'integer', 'text', 'bool', etc.
  opts?: BatchValuesOptions,    // Optional: alias and ordinality
): BatchValuesRef
```

### ORM method (identical, attached to orm instance)

```typescript
const batch = orm.batchValues(data, columns, types, opts?)
```

### BatchValuesOptions

```typescript
type BatchValuesOptions = {
  alias?: string;       // Alias for the unnest source in SQL (default: 'batch')
  ordinality?: boolean; // Append a row-number column named 'ord' (default: false)
}
```

### BatchValuesRef usage

A `BatchValuesRef` is a lightweight descriptor — not a QueryBuilder. Pass it to:

| Method | Purpose |
|--------|---------|
| `orm.from(batchRef)` | Use batch as the primary FROM source |
| `.join(batchRef, { on: ... })` | Join batch to a table in a SELECT query |
| `orm.modify('table').join(batchRef, { on: ... })` | Batch UPDATE FROM |

**Note:** `orm.from(batchRef)` returns a `QueryBuilder<Record<string, unknown>>` — columns are
not statically typed because the schema is runtime-defined.

## Examples

### 1. Basic: batch as the primary FROM source

Fetch the batch values as a standalone result set.

```typescript
import { batchValues } from '@dbsp/core'

const batch = batchValues(
  [['/src/a.ts', '/src/b.ts'], ['a.ts', 'b.ts']],
  ['path', 'name'],
  ['text', 'text'],
  { alias: 'requested' },
)

const results = await orm.from(batch).all()
```

Generated SQL:

```sql
SELECT *
FROM unnest(CAST($1 AS text[]), CAST($2 AS text[])) AS requested(path, name)
```

Parameters: `[['/src/a.ts', '/src/b.ts'], ['a.ts', 'b.ts']]`

---

### 2. JOIN with an existing table

Filter rows in a real table against a set of in-memory values.

```typescript
import { batchValues, eq, ref } from '@dbsp/core'

const batch = batchValues(
  [[1, 2, 3], [10, 20, 30]],
  ['id', 'callee_id'],
  ['integer', 'integer'],
  { alias: 'batch' },
)

const rows = await orm.select('calls')
  .join(batch, {
    on: eq('calls.id', ref('batch.id')),
    type: 'inner',
  })
  .all()
```

Generated SQL:

```sql
SELECT "calls".*
FROM "calls"
INNER JOIN unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS batch(id, callee_id)
  ON calls.id = batch.id
```

Parameters: `[[1, 2, 3], [10, 20, 30]]`

---

### 3. Batch UPDATE FROM

Update multiple rows in one query using the batch as the source of new values.

```typescript
import { batchValues, eq, ref } from '@dbsp/core'

const ids = [101, 102, 103]
const newCalleeIds = [201, 202, 203]

const batch = orm.batchValues(
  [ids, newCalleeIds],
  ['id', 'callee_id'],
  ['integer', 'integer'],
)

await orm.modify('calls')
  .join(batch, { on: eq('calls.id', ref('batch.id')) })
  .set({ callee_id: ref('batch.callee_id') })
  .execute()
```

Generated SQL:

```sql
UPDATE "calls"
SET "callee_id" = batch.callee_id
FROM unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS batch(id, callee_id)
WHERE calls.id = batch.id
```

Parameters: `[[101, 102, 103], [201, 202, 203]]`

---

### 4. WITH ORDINALITY — row index column

Use `ordinality: true` to get a zero-indexed row number (`ord` column). Useful for
preserving caller-defined ordering in a JOIN or SELECT.

```typescript
import { batchValues } from '@dbsp/core'

const requestedPaths = ['/src/c.ts', '/src/a.ts', '/src/b.ts']

const batch = batchValues(
  [requestedPaths],
  ['path'],
  ['text'],
  { alias: 'requested', ordinality: true },
)

const results = await orm.from(batch)
  .join('files', { on: eq('files.path', ref('requested.path')) })
  .orderBy([{ column: 'requested.ord' }])
  .all()
```

Generated SQL:

```sql
SELECT *
FROM unnest(CAST($1 AS text[])) WITH ORDINALITY AS requested(path, ord)
INNER JOIN "files" ON files.path = requested.path
ORDER BY requested.ord ASC
```

The `ord` column is automatically appended after all named columns when `ordinality: true`.

---

### 5. Filtering via join (IN-list alternative)

Use an inner join against a batch as a scalable alternative to `WHERE id IN (...)` for
large value sets.

```typescript
import { batchValues, eq, ref } from '@dbsp/core'

const activeIds = [/* potentially thousands of ids */]

const batch = batchValues(
  [activeIds],
  ['id'],
  ['integer'],
  { alias: 'filter' },
)

const users = await orm.select('users')
  .join(batch, {
    on: eq('users.id', ref('filter.id')),
    type: 'inner',
  })
  .all()
```

This avoids the PostgreSQL IN-list limit and keeps parameters as a single typed array.

## Key Files

- `packages/core/src/dx/batch-values.ts` — `batchValues()` factory, `BatchValuesRef` type, `BatchValuesOptions` type, `isBatchValuesRef()` guard
- `packages/core/src/dx/orm-instance.ts` — `orm.batchValues()` method + `orm.from(batchRef)` dispatch
- `packages/core/src/dx/query-builder.ts` — `QueryBuilder.join(batchRef, { on })` overload
- `packages/adapter-pgsql/src/__tests__/batch-values.test.ts` — canonical compilation tests

## Gotchas

- **Column-major, not row-major** — `data` is an array of column arrays, not an array of row objects.
  `[[ids...], [names...]]` not `[{id, name}, ...]`. The length of each column array must match the others.
- **Type names are restricted to `[a-zA-Z0-9_]`** — type names like `'character varying'` (with a space) or
  any name containing punctuation will throw at construction time. Use the short aliases instead:
  `'text'`, `'int4'`, `'float8'`, `'bool'`, `'timestamptz'`, `'jsonb'`.
- **`on` is required for `.join(batchRef, ...)`** — unlike relation joins, a BatchValues join has no schema
  relationship to infer an ON clause from. Omitting `on` throws an error at build time.
- **Compiled SQL uses `CAST($N AS type[])` form** — the pgsql deparser normalizes PostgreSQL's
  `$N::type[]` shorthand to `CAST($N AS type[])`. Both are equivalent but tests must match this form.
- **`integer` columns compile as `int4`** — the PostgreSQL wire type for `integer` is `int4`. If you
  write assertions against generated SQL, match `int4[]` not `integer[]`.
- **`orm.from(batchRef)` returns `QueryBuilder<Record<string, unknown>>`** — columns are not
  statically typed. Downstream code must cast or validate results at runtime.
- **No schema validation** — column names and types are not cross-checked against any ModelIR table.
  Typos in column names surface as runtime SQL errors, not TypeScript errors.
- **Default alias is `'batch'`** — if you use multiple batch sources in one query, pass an explicit
  `alias` for each to avoid ambiguous references.
