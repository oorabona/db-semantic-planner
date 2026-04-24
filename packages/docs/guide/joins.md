---
title: Manual Joins
---

# How to Use Manual Joins

The `.join()` method adds a flat SQL JOIN to a query without triggering the nested-object hydration that `include()` performs. Use it when you need to filter the root table by a condition on a related table, perform a self-join, or join a table that has no declared foreign-key relation in your schema.

## When

When you need a flat, non-hydrating SQL JOIN on the root query — cross-table filtering,
self-joins, or joining tables that have no declared FK relation. Unlike `include()`, which
hydrates nested objects, `.join()` merges columns into a flat result row.

Use `.join()` when:
- You need to filter the root table by a condition on a related table (semi-join / anti-join pattern)
- You need a self-join (e.g. comparing rows in the same table)
- The join target has no FK relation declared in the schema
- You want flat rows (not nested objects)

Use `include()` instead when you want nested hydration (e.g. `user.posts[]`).

## API

```typescript
// doctest: skip — type signature illustration, not executable
// Overload 1 — Relation mode: FK auto-resolved from schema
.join(relationName: string, opts?: {
  type?: 'inner' | 'left';  // default: 'inner'
  as?: string;              // output alias (optional)
}): QueryBuilder<TResult>

// Overload 2 — Table mode: explicit table + ON condition
.join(table: string, opts: {
  on: WhereIntent;          // required — ON condition (use eq, lt, and, etc.)
  type?: 'inner' | 'left';  // default: 'inner'
  as?: string;              // alias for the joined table (required for self-joins)
}): QueryBuilder<TResult>
```

**Mode discrimination:** the presence of `opts.on` determines the mode.
- **No `on`** → relation mode: the first argument is a relation name defined in the schema;
  the FK column and target table are resolved automatically.
- **With `on`** → table mode: the first argument is a raw table name; the ON condition
  must be provided explicitly.

The builder is **immutable** — each `.join()` call returns a new `QueryBuilder` instance.
Chaining multiple `.join()` calls accumulates joins in order.

## Examples

### 1. Basic relation join (FK auto-resolved)

Given a schema with `calls.caller_id → symbols`:

```typescript
// doctest: skip — relation-mode join requires model in compileDeps; compile-only adapter does not populate deps.model
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
import { createOrm } from '@dbsp/core';

const results = await orm.select('calls')
  .join('caller')
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM (calls JOIN symbols AS caller ON caller_id = caller.id) caller
```

The FK column (`caller_id`) and target table (`symbols`) are resolved from the schema.
The default join type is `INNER JOIN`.

> **Why the parenthesized FROM with an outer alias?** The compiler wraps the join pair in
> parentheses and re-aliases the result (`... caller`) so that outer clauses (WHERE, ORDER BY,
> additional joins) can reference the join result as a named unit. This mirrors PostgreSQL's
> associativity rules for chained joins and ensures column references remain unambiguous when
> multiple joins are stacked (see Example 4).

### 2. Left join (keep root rows without a match)

```typescript
// doctest: skip — relation-mode join requires model in compileDeps; compile-only adapter does not populate deps.model
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
const results = await orm.select('calls')
  .join('callee', { type: 'left' })
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM (calls LEFT JOIN symbols AS callee ON callee_id = callee.id) callee
```

Use `type: 'left'` when root rows without a matching related row should still appear
(with NULL columns for the joined side).

### 3. Join with WHERE on root table

`.join()` and `.where()` compose freely. The WHERE applies after the join:

```typescript
// doctest: skip — relation-mode join requires model in compileDeps; compile-only adapter does not populate deps.model
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
import { eq } from '@dbsp/core';

const results = await orm.select('calls')
  .join('caller')
  .where(eq('id', 42))
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM (calls JOIN symbols AS caller ON caller_id = caller.id) caller
WHERE "calls"."id" = $1
-- params: [42]
```

### 4. Multiple chained joins

Chain `.join()` calls to add more than one join. They accumulate left-to-right:

```typescript
// doctest: skip — relation-mode join requires model in compileDeps; compile-only adapter does not populate deps.model
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
const results = await orm.select('calls')
  .join('caller')
  .join('callee', { type: 'left' })
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM ((calls JOIN symbols AS caller ON caller_id = caller.id) caller
      LEFT JOIN symbols AS callee ON callee_id = callee.id) callee
```

### 5. Self-join with alias (table mode)

When joining a table to itself, provide `as` (required to disambiguate) and an explicit
`on` condition using `ref()` for column references:

```typescript
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
import { eq, ref } from '@dbsp/core';

// Find all pairs where embeddings.id < e2.id
const results = await orm.select('embeddings')
  .join('embeddings', {
    on: { kind: 'comparison', field: 'embeddings.id', operator: 'lt',
          value: { kind: 'fieldRef', column: 'id', scope: 'outer' } },
    as: 'e2',
    type: 'inner',
  })
  .dump();
```

Generated SQL:
```sql
SELECT embeddings.*
FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id
```

For simpler equality ON conditions you can use the `eq` filter helper directly. Use
dotted `'table.column'` notation to qualify column references in the ON condition:

```typescript
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
import { eq } from '@dbsp/core';

// Explicit equality ON condition
const results = await orm.select('embeddings')
  .join('embeddings', {
    on: eq('embeddings.id', 1),
    as: 'e2',
    type: 'inner',
  })
  .dump();
```

### 6. Relation mode with custom alias

Use `as` to override the alias the joined table receives in the query:

```typescript
// doctest: skip — relation-mode join requires model in compileDeps; compile-only adapter does not populate deps.model
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
const results = await orm.select('calls')
  .join('caller', { as: 'c', type: 'inner' })
  .dump();
```

Generated SQL includes `symbols AS c` — the FK is still resolved from `caller`, not `c`:

```sql
SELECT calls.*
FROM (calls JOIN symbols AS c ON caller_id = c.id) c
```

### 7. Join types summary

| `type` value | SQL keyword | Root rows without match |
|---|---|---|
| `'inner'` (default) | `INNER JOIN` | Excluded |
| `'left'` | `LEFT JOIN` | Included (NULLs for joined side) |

Note: `right` and `full` outer joins are not supported by `.join()`. Use a raw SQL
escape hatch or restructure the query (swap root table / use `union`) if needed.

### 8. Using expression helpers in ON conditions

The `on` parameter accepts any `WhereIntent` — the same filter helpers used in `.where()`:

```typescript
const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgsqlCompileOnlyAdapter() });
import { and, eq, gt } from '@dbsp/core';

// ON condition with AND
const results = await orm.select('calls')
  .join('symbols', {
    on: and(
      eq('calls.caller_id', 'symbols.id'),
      gt('symbols.score', 0),
    ),
    as: 'caller',
  })
  .dump();
```

All standard filter helpers (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `and`,
`or`, `not`, `isNull`, `isNotNull`, `inArray`) are valid in the `on` option.

## Key Files

- `packages/core/src/dx/query-builder-types.ts` — `join()` method signatures (overloads 1 and 2)
- `packages/core/src/dx/query-builder.ts` — immutable `join()` implementation, builds `JoinIntent`
- `packages/types/src/intent/query-intent.ts` — `JoinIntent` discriminated union (relation / table / batchValues modes)
- `packages/adapter-pgsql/src/adapter-compiler-select.ts` — `compileJoinIntents()` translates `JoinIntent[]` to SQL JOIN clauses
- `packages/adapter-pgsql/src/__tests__/join-api.test.ts` — SQL compilation tests (exact SQL assertions)
- `packages/core/src/dx/__tests__/join.test.ts` — unit tests for intent shape, immutability, mode discrimination

## Gotchas

- **Relation mode vs table mode is determined by `opts.on`** — if you pass `on`, it is table mode regardless of whether the first argument matches a relation name. Omit `on` for FK auto-resolution.
- **`as` does not change FK resolution in relation mode** — `.join('caller', { as: 'c' })` resolves the FK from the `caller` relation, not from `c`. The alias only affects the SQL output name.
- **Self-joins require `as`** — without an alias the two references to the same table are ambiguous in SQL. The compiler will produce a valid but potentially confusing query; always pass `as` for self-joins.
- **Result columns are flat** — `.join()` does not hydrate nested objects. All columns from the joined table appear as top-level keys in the result. Use `include()` for nested hydration.
- **Right and full outer joins are not supported** — only `'inner'` and `'left'` are valid values for `type`.
- **Dotted column notation in ON conditions** — use `'table.column'` (e.g. `'embeddings.id'`) to produce qualified column references in the ON clause. Unqualified names may be ambiguous when both sides of the join expose the same column name.
- **Multiple joins nest left-to-right** — the SQL FROM clause wraps joins progressively: `((A JOIN B) JOIN C)`. This matches standard PostgreSQL left-associative join behavior and is transparent to the query result.
