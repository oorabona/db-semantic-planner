---
title: JSONB Queries
description: Query, filter, and aggregate JSONB columns in PostgreSQL using @dbsp/core expression primitives.
---

# JSONB Queries

PostgreSQL's `jsonb` type stores semi-structured data as a binary-parsed JSON document, enabling flexible schemas, sparse attribute storage, and efficient operator-based querying. `@dbsp/core` does not ship dedicated JSONB helpers, but every PostgreSQL JSONB operator is reachable through the [Expression Primitives](./expression-primitives) layer (`op()`, `exprRef()`, `param()`, `literal()`, `cast()`).

## Why this matters

The common misconception is "I'll just store it as text and parse in application code." Storing JSON as `text` eliminates all server-side operators: you lose containment checks, path extraction, and GIN-indexed lookups. The `jsonb` type gives you SQL-level introspection with predictable performance characteristics that a text column cannot match.

---

## PostgreSQL JSONB operator reference

| Operator | Description | Returns | Example |
|----------|-------------|---------|---------|
| `->` | Get field by key (returns JSON) | `jsonb` | `data -> 'address'` |
| `->>` | Get field by key (returns text) | `text` | `data ->> 'email'` |
| `@>` | Contains: left contains right | `boolean` | `data @> '{"role":"admin"}'` |
| `<@` | Contained by: right contains left | `boolean` | `data <@ '{"a":1,"b":2}'` |
| `?` | Key exists | `boolean` | `data ? 'email'` |
| `?\|` | Any of the given keys exist | `boolean` | `data ?\| ARRAY['email','phone']` |
| `?&` | All of the given keys exist | `boolean` | `data ?& ARRAY['id','name']` |
| `#>` | Path access (returns JSON) | `jsonb` | `data #> '{address,city}'` |
| `#>>` | Path access (returns text) | `text` | `data #>> '{address,city}'` |

Use `->` when the result will be passed to another JSON operator. Use `->>` when you need a text value for comparison, concatenation, or casting.

---

## Schema setup

```typescript
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  profiles: {
    id: 'integer',
    userId: 'integer',
    data: 'jsonb',    // raw document column
  },
  audit_log: {
    id: 'integer',
    action: 'string',
    details: 'jsonb',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });
```

---

## Pattern: extract a scalar value (`->>`)

Filter rows where a text field inside the JSON document matches a value:

```typescript
import { schema, createOrm, op, exprRef, param, literal } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ profiles: { id: 'integer', userId: 'integer', data: 'jsonb' } } as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

// WHERE data->>'email' = $1
orm.select('profiles')
  .where(op('=', op('->>', exprRef('data'), literal('email')), param('alice@example.com')))
  .dump();
// SQL: SELECT ... FROM "profiles"
// WHERE "data" ->> 'email' = $1
// params: ['alice@example.com']
```

`op()`, `exprRef()`, `param()`, and `literal()` are from `@dbsp/core`. See [Expression Primitives](./expression-primitives) for full signatures.

---

## Pattern: containment check (`@>`)

Find all profiles with a specific role embedded in the document:

```typescript
import { schema, createOrm, op, exprRef, param, cast } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ profiles: { id: 'integer', userId: 'integer', data: 'jsonb' } } as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const roleFilter = { role: 'admin' };

// WHERE data @> $1::jsonb
orm.select('profiles')
  .where(op('@>', exprRef('data'), cast(param(JSON.stringify(roleFilter)), 'jsonb')))
  .dump();
// SQL: SELECT ... FROM "profiles"
// WHERE "data" @> $1::jsonb
// params: ['{"role":"admin"}']
```

The `cast(..., 'jsonb')` is necessary because `$N` parameters are untyped — PostgreSQL needs the explicit cast to apply the `@>` operator.

---

## Pattern: check if a key exists (`?`)

Check whether a specific key is present in the document:

```typescript
// doctest: skip — '?' operator not in the static operator allowlist; valid at PostgreSQL runtime
import { schema, createOrm, op, exprRef, literal } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ profiles: { id: 'integer', userId: 'integer', data: 'jsonb' } } as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

// WHERE data ? 'phone'
orm.select('profiles')
  .where(op('?', exprRef('data'), literal('phone')))
  .dump();
// SQL: SELECT ... FROM "profiles"
// WHERE "data" ? 'phone'
```

Use `?|` or `?&` (note: in TypeScript string literals, write `'?|'` and `'?&'`) for array key-existence checks.

---

## Pattern: array element extraction (`->`)

Drill into a nested array in the JSONB document — for example, accessing the first tag in a tags array:

```typescript
import { schema, createOrm, op, exprRef, literal } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ profiles: { id: 'integer', userId: 'integer', data: 'jsonb' } } as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

// Select first element: data->'tags'->0
orm.select('profiles')
  .columns([
    'id',
    op('->', op('->', exprRef('data'), literal('tags')), literal(0)),
  ])
  .dump();
// SQL: SELECT "id", "data" -> 'tags' -> 0 FROM "profiles"
```

Integer indexes into JSON arrays use a bare integer literal (not quoted). The result type is `jsonb`; cast to `text` via `->>` or `cast(..., 'text')` for string comparisons.

---

## Pattern: aggregate across JSONB (jsonb_agg / jsonb_build_object)

Build a JSON aggregation in a GROUP BY query:

```typescript
import { schema, createOrm, fn, exprRef } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ profiles: { id: 'integer', userId: 'integer', data: 'jsonb' } } as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

// SELECT userId, jsonb_agg(data) AS allData FROM profiles GROUP BY userId
orm.select('profiles')
  .columns([
    'userId',
    fn('jsonb_agg', exprRef('data')).as('allData'),
  ])
  .groupBy('userId')
  .dump();
// SQL: SELECT "userId", jsonb_agg("data") AS "allData"
// FROM "profiles" GROUP BY "userId"
```

`fn(name, ...args)` calls a named PostgreSQL function. It is part of the expression primitives — see [Expression Primitives](./expression-primitives) for the full signature.

---

## Indexing strategies

| Index type | When to use | DDL hint |
|------------|-------------|----------|
| `GIN` on the column | `@>`, `?`, `?|`, `?&`, `@?`, `@@` operators (containment / existence) | `CREATE INDEX ON profiles USING GIN (data)` |
| `GIN` with `jsonb_path_ops` | `@>` only — smaller index, faster containment lookups | `USING GIN (data jsonb_path_ops)` |
| Expression index | Equality on a specific path (`data->>'email' = ?`) | `CREATE INDEX ON profiles ((data->>'email'))` |
| `BTREE` on extracted cast | Range queries on a numeric field (`(data->>'score')::int`) | `CREATE INDEX ON profiles (((data->>'score')::integer))` |

For expression indexes via dbsp DDL helpers, see [DDL Helpers](./ddl-helpers).

---

## Common pitfalls

### `->` returns `jsonb`, not text

Comparing `data -> 'email' = 'alice@example.com'` produces a type error because `jsonb` does not equal `text`. Use `->>` to get text:

```typescript
// doctest: skip — illustrates the wrong pattern
op('=', op('->', exprRef('data'), literal('email')), param('alice@example.com'))
// ↑ type error at DB: operator does not exist: jsonb = text

op('=', op('->>', exprRef('data'), literal('email')), param('alice@example.com'))
// ↑ correct: ->> returns text
```

### Null semantics

`data ->> 'missing_key'` returns SQL `NULL`, not a JSON `null`. Filter with `IS NOT NULL` accordingly.

### Performance vs normalized columns

JSONB is not a silver bullet. For columns you filter on frequently with equality or range queries, a normalized scalar column with a `BTREE` index outperforms a JSONB expression index by a large margin. Reserve JSONB for genuinely sparse or variable-shape data.

### Casting parameters

Any `$N` parameter compared against a JSONB operator must be cast. Omitting `::jsonb` causes a PostgreSQL error at runtime:
`operator does not exist: jsonb @> unknown`.

---

## See also

- [Expression Primitives](./expression-primitives) — `op()`, `fn()`, `exprRef()`, `param()`, `cast()`, `literal()` signatures
- [Extensions (pgvector, ParadeDB)](./extensions) — other operator-heavy extension patterns
- [Schema Definition](./schema) — declaring `jsonb` columns in your schema
