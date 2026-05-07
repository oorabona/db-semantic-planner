---
title: Set Operations
description: Combine multiple query results with UNION, INTERSECT, and EXCEPT using the @dbsp/core set operation builders.
---

# Set Operations

Set operations combine the results of two or more queries into a single result set. They are the right tool when you need to merge heterogeneous query shapes that a single query with filters or JOINs cannot express cleanly — for example, pulling active users and recent admin accounts from different sources and deduplicating the list.

## Why this matters

The common misconception is "I can use `.include()` or a JOIN for this." Includes and JOINs work on a single root table. Set operations work across queries that may target different tables, different filter combinations, or post-filter aggregations. They also do not add rows to the row set — they combine two already-complete result shapes column-by-column.

---

## The six operators

All six operators are defined in `packages/core/src/dx/set-operation-builder.ts`.

| Method | SQL | Duplicates | Description |
|--------|-----|-----------|-------------|
| `.union(q)` | `UNION` | removed | All rows from both, deduped |
| `.unionAll(q)` | `UNION ALL` | kept | All rows from both, no dedup — faster |
| `.intersect(q)` | `INTERSECT` | removed | Only rows present in both queries |
| `.intersectAll(q)` | `INTERSECT ALL` | kept | Common rows, including duplicates |
| `.except(q)` | `EXCEPT` | removed | Rows in left but not in right |
| `.exceptAll(q)` | `EXCEPT ALL` | kept | Rows in left but not right, with duplicates |

All six return a `SetOperationBuilder<TResult>` which supports `.all()`, `.first()`, and `.dump()`. You can chain further set operations on the result (e.g. `q1.union(q2).intersect(q3)`).

---

## Pattern: merging two filtered slices

Combine active users and recently-activated accounts into a single deduped list:

```typescript
import { schema, createOrm, eq, gt } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: { id: 'integer', name: 'string', active: 'boolean', activatedAt: 'timestamp' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const active = orm.select('users').where(eq('active', true)).columns(['id', 'name']);
const recentlyActivated = orm.select('users')
  .where(gt('activatedAt', new Date('2024-01-01')))
  .columns(['id', 'name']);

active.union(recentlyActivated).dump();
// SQL: (SELECT "id", "name" FROM "users" WHERE "active" = $1)
// UNION
// (SELECT "id", "name" FROM "users" WHERE "activatedAt" > $2)
// params: [true, 2024-01-01T00:00:00.000Z]
```

Use `.unionAll()` instead of `.union()` when you know there are no duplicates and want to avoid the deduplication sort.

**When to use UNION vs UNION ALL:** `UNION ALL` skips the deduplication step and is significantly faster on large result sets. Use `UNION` only when you need deduplication. `UNION ALL` is almost always the right choice for combining disjoint data sources.

---

## Pattern: combining queries across different tables

Collect all "notable entity" IDs from two unrelated tables — users and organizations — for a shared notification system:

```typescript
import { schema, createOrm, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: { id: 'integer', name: 'string', notificationsEnabled: 'boolean' },
  organizations: { id: 'integer', name: 'string', notificationsEnabled: 'boolean' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const notifiableUsers = orm.select('users')
  .where(eq('notificationsEnabled', true))
  .columns(['id', 'name']);

const notifiableOrgs = orm.select('organizations')
  .where(eq('notificationsEnabled', true))
  .columns(['id', 'name']);

notifiableUsers.unionAll(notifiableOrgs).dump();
// SQL: (SELECT "id", "name" FROM "users" WHERE "notificationsEnabled" = $1)
// UNION ALL
// (SELECT "id", "name" FROM "organizations" WHERE "notificationsEnabled" = $2)
```

The column shape must match between both sides — same count, compatible types. The column names in the result come from the left-hand query.

---

## Pattern: audit log diff with EXCEPT

Find rows present in a snapshot table but missing from the current live table — useful for detecting deletions:

```typescript
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  products: { id: 'integer', sku: 'string', price: 'decimal' },
  products_snapshot: { id: 'integer', sku: 'string', price: 'decimal' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const snapshot = orm.select('products_snapshot').columns(['id', 'sku', 'price']);
const live = orm.select('products').columns(['id', 'sku', 'price']);

snapshot.except(live).dump();
// SQL: (SELECT "id", "sku", "price" FROM "products_snapshot")
// EXCEPT
// (SELECT "id", "sku", "price" FROM "products")
// Rows = products that existed in the snapshot but have been deleted from live
```

---

## Chaining set operations

Set operations return a `SetOperationBuilder` which itself exposes all six methods, so you can chain:

```typescript
// doctest: skip — illustrative chaining example
const combined = q1.union(q2).union(q3);
// SQL: (q1) UNION (q2) UNION (q3)
```

Chaining is left-associative: `(q1 UNION q2) UNION q3`. If you need a different grouping, structure the builders accordingly.

---

## Common pitfalls

### Column shape must match

Both queries must select the same number of columns with compatible PostgreSQL types. A type mismatch causes a database error at runtime, not a compile-time TypeScript error:

```typescript
// doctest: skip — illustrates the wrong pattern
const q1 = orm.select('users').columns(['id', 'name']);   // id: integer, name: text
const q2 = orm.select('users').columns(['id', 'active']); // id: integer, active: boolean
q1.union(q2); // Runtime error: column 2 types (text vs boolean) don't match
```

### No automatic alias propagation

The result column names come from the left-hand query. Aliases set in the right-hand query are ignored by PostgreSQL:

```typescript
// doctest: skip — alias behavior note
// The result column is named "name", not "fullName":
orm.select('users').columns(['id', 'name'])
  .union(
    orm.select('users').columns(['id', 'name']) // alias on right side is irrelevant
  );
```

### Set operations bypass the semantic planner

Set operation results have no `plan` in their `Dump` (it is `undefined`). Guard with `dump.plan?.decisions` when writing generic observability code that reads plan decisions — see [Observability](./observability):55.

### Locking clauses and set operations

`FOR UPDATE` / `FOR SHARE` lock modifiers cannot be applied to a query that is part of a set operation. Apply locking in a wrapping CTE or in separate queries inside a transaction.

---

## See also

- [Queries](./queries) — base query builder
- [Subqueries](./subqueries) — scalar subqueries and EXISTS patterns
- [Observability](./observability) — dump() and the plan report
- [Transactions](./transactions) — combining multiple operations atomically
