---
title: Observability
---

# Observability

Every query and mutation builder in `@dbsp/core` exposes a `.dump()` method that returns the compiled SQL, bound parameters, and the full planner report — without touching the database. This makes it straightforward to inspect, log, and test every query your application generates.

---

## dump()

Call `.dump()` on any builder to get a `Dump` object:

```typescript
import { eq } from '@dbsp/core';

const dump = orm.select('users')
  .where(eq('active', true))
  .include('posts')
  .dump();

console.log(dump.sql);
// SELECT "t0"."id", "t0"."name", ..., json_agg(...) AS "posts"
// FROM "users" AS "t0"
// LEFT JOIN "posts" AS "t1" ON "t1"."author_id" = "t0"."id"
// WHERE "t0"."active" = $1
// GROUP BY "t0"."id"

console.log(dump.params);
// [true]

console.log(dump.plan?.decisions);
// [{ type: 'include-strategy', relation: 'posts', choice: 'json_agg', reason: '...' }]

console.log(dump.plan?.warnings);
// [] — empty means no performance concerns
```

### Dump structure

```typescript
type Dump = {
  sql:    string;                        // Compiled SQL with $N parameters
  params: readonly unknown[];            // Bound parameter values, in order
  readonly plan?: PlanReport | undefined; // Planner decisions, warnings, and metadata
  meta?: {
    schema?:        string;  // Schema name if using orm.withSchema()
    queryName?:     string;  // Optional label set with .as()
    correlationId?: string;  // Tracing ID
  };
};
```

> **Note:** `plan` is omitted for set-operation dumps (UNION / INTERSECT / EXCEPT) because those queries bypass the semantic planner. Use `dump.plan?.decisions` or guard with `if (dump.plan)` when writing observability hooks that need to be generic across all query types.

---

## Plan Decisions

The `plan.decisions` array records every choice the planner made and why. Use it to understand what the planner did and to verify behaviour in tests.

```typescript
const dump = orm.select('users').include('posts').dump();

for (const decision of dump.plan?.decisions ?? []) {
  console.log(decision.type, decision.choice, decision.reason);
}
// include-strategy  json_agg  "simple 1:N with no filter on relation"
// filter-strategy   where     "eq on scalar column"
```

Common decision types:

| Type | Description |
|------|-------------|
| `include-strategy` | Which SQL strategy was chosen for an `.include()` call |
| `filter-strategy` | How a WHERE condition was compiled |
| `cte-extraction` | Whether a subquery was lifted into a CTE |
| `join-type` | INNER vs LEFT JOIN for a relation |

---

## Warnings

`plan.warnings` is an array of advisory messages. An empty array means the planner has no concerns.

```typescript
const dump = orm.select('users').include('posts').include('posts.comments').dump();

for (const w of dump.plan?.warnings ?? []) {
  console.warn(w.type, w.message);
}
// performance  "Deep nesting may produce large intermediate result sets"
```

Warnings do not stop execution — they surface potential performance or correctness concerns for you to act on.

---

## Compile-Only Mode

For CLI tooling, SQL preview, or offline testing, use `createPgsqlCompileOnlyAdapter()`. It compiles any query to SQL without requiring a database connection. Calling `.execute()` or `.all()` throws `ExecutionError`; only `.dump()` works.

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const orm = createOrm({
  schema: db,
  adapter: createPgsqlCompileOnlyAdapter(),
});

const dump = orm.select('users')
  .where(eq('active', true))
  .dump();

console.log(dump.sql);    // SELECT "t0".* FROM "users" AS "t0" WHERE "t0"."active" = $1
console.log(dump.params); // [true]
```

This is the recommended pattern for integration with migration tools, schema diffing, and test assertions that verify SQL output.

---

## Correlation IDs for Distributed Tracing

Attach a correlation ID to a query to propagate request context through your logs:

```typescript
// doctest: skip — .as() chaining before .dump() not available in this form; use .dump() directly
// Assumes `db` from `schema({...})` and `orm` from `createOrm({ schema: db, adapter })` are in scope.
import { eq } from '@dbsp/core';

const userId = 1;
const requestId = 'req-123';

const dump = orm.select('users')
  .where(eq('id', userId))
  .as('fetch-user', { correlationId: requestId })
  .dump();

console.log(dump.meta?.correlationId); // the request ID you passed
```

The correlation ID appears in `dump.meta.correlationId` and is not sent to PostgreSQL — it is purely a client-side metadata field for log correlation.

---

## Query Hooks

The adapter supports `onQuery` and `onQueryComplete` lifecycle hooks for cross-cutting concerns such as logging, metrics, and slow-query detection:

```typescript
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlAdapter(pool, {
  onQuery(dump) {
    logger.debug({ sql: dump.sql, params: dump.params }, 'query start');
  },
  onQueryComplete(dump, durationMs) {
    metrics.histogram('db.query.duration', durationMs);
    if (durationMs > 1000) {
      logger.warn({ sql: dump.sql, durationMs }, 'slow query');
    }
  },
});
```

| Hook | Signature | When called |
|------|-----------|-------------|
| `onQuery` | `(dump: Dump) => void` | Before the query executes |
| `onQueryComplete` | `(dump: Dump, durationMs: number) => void` | After the query returns (success or error) |

Both hooks receive the full `Dump` object, including SQL, parameters, and the plan report.
