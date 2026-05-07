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
import { schema, createOrm, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ users: { id: 'integer', name: 'string' } } as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const userId = 1;
const requestId = 'req-123';

const dump = orm.select('users')
  .where(eq('id', userId))
  .dump({ queryName: 'fetch-user', correlationId: requestId });

console.log(dump.meta?.correlationId); // 'req-123'
console.log(dump.meta?.queryName);     // 'fetch-user'
```

The correlation ID appears in `dump.meta.correlationId` and is not sent to PostgreSQL — it is purely a client-side metadata field for log correlation.

---

## Query Hooks

`@dbsp/core` provides lifecycle hooks at the ORM instance via `createHookManager()`. Use `beforeQuery` / `afterQuery` for cross-cutting concerns such as logging, metrics, and slow-query detection:

```typescript
// doctest: skip — requires real PostgreSQL pool
import { createOrm, createHookManager, schema } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ users: { id: 'integer', name: 'string' } } as const);

const hooks = createHookManager()
  .beforeQuery((ctx) => {
    logger.debug({ sql: ctx.intent }, 'query start');
    return ctx;
  })
  .afterQuery((ctx, results) => {
    if (ctx.duration && ctx.duration > 1000) {
      logger.warn({ durationMs: ctx.duration }, 'slow query');
    }
    metrics.histogram('db.query.duration', ctx.duration ?? 0);
    return results;
  });

const orm = createOrm({ schema: db, adapter: createPgsqlAdapter(pool), hooks });
```

| Hook | Type | When called |
|------|------|-------------|
| `beforeQuery` | `BeforeQueryHook` | Before the query executes |
| `afterQuery` | `AfterQueryHook` | After the query returns (success or error) |

`PgsqlAdapterOptions` (the second argument to `createPgsqlAdapter`) does not accept query callbacks — use ORM-level hooks via `createHookManager()` instead.

---

## ORM-instance hooks

`@dbsp/core` provides a lifecycle hook system at the ORM instance. These hooks let you compose cross-cutting concerns — soft-delete default filters, audit trails, per-request metrics — as reusable units that attach to the ORM at creation time.

### Hook registration

Create a `HookManager` with `createHookManager()` and chain your hooks before passing it to `createOrm()`. Hooks are **frozen on ORM creation** — no new hooks can be registered after `createOrm()` is called.

```typescript
// doctest: skip — requires real PostgreSQL pool; illustrates hook registration pattern
import { createOrm, createHookManager, schema } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ users: { id: 'integer', name: 'string', deletedAt: 'timestamp' } } as const);

const hooks = createHookManager()
  .beforeQuery((ctx) => {
    console.log(`[${ctx.table}] ${ctx.operation} starting`);
    return ctx; // return ctx (or undefined) to continue; the returned value becomes the new ctx
  })
  .afterQuery((ctx, results) => {
    console.log(`[${ctx.table}] returned ${Array.isArray(results) ? results.length : 1} row(s) in ${ctx.duration}ms`);
    return results; // return results (or undefined) to pass them through unchanged
  });

const orm = createOrm({ schema: db, adapter: createPgsqlAdapter(pool), hooks });
```

Source: `packages/core/src/dx/hooks.ts:523` — `createHookManager()` returns a `HookManager`.

### Hook types

Five hook types are available. All are defined in `packages/core/src/dx/hooks.ts`.

| Hook | Type | Context | Can transform |
|------|------|---------|---------------|
| `beforeQuery` | `BeforeQueryHook` | `QueryHookContext` | Yes — return modified ctx |
| `afterQuery` | `AfterQueryHook` | `QueryHookContext` | Yes — return modified results |
| `beforeMutation` | `BeforeMutationHook` | `MutationHookContext<T>` | Yes — return modified ctx |
| `afterMutation` | `AfterMutationHook` | `MutationHookContext<T>` | Yes — return modified results array |
| `onError` | `OnErrorHook` | Error + context | No |

Each hook receives a **frozen** context object (`Object.freeze` is applied at construction time). To modify the context, return a new object from the hook. Returning `undefined` passes the original context unchanged.

### Hook context fields

**`QueryHookContext`** (beforeQuery / afterQuery):

| Field | Available in | Description |
|-------|-------------|-------------|
| `table` | both | Root table name |
| `operation` | both | Always `'select'` |
| `intent` | both | Full `QueryIntent` AST |
| `schemaName` | both | Schema if `withSchema()` was used |
| `inTransaction` | both | Whether inside `orm.transaction()` |
| `correlationId` | both | Correlation ID from `.dump()` options |
| `resultType` | both | `'all'`, `'first'`, `'count'`, etc. |
| `sql` | afterQuery only | Compiled SQL string |
| `parameters` | afterQuery only | Bound parameters (may contain PII) |
| `duration` | afterQuery only | Execution time in ms |

**`MutationHookContext<T>`** (beforeMutation / afterMutation) adds:

| Field | Description |
|-------|-------------|
| `operation` | `'insert'`, `'update'`, `'delete'`, `'upsert'` |
| `intent` | The mutation intent AST |
| `cardinality` | `'single'` or `'bulk'` |
| `data` | The values being written |
| `affectedRows` | afterMutation only — row count |

### Lifecycle order

For a SELECT query, hooks fire in this order:

1. ORM `beforeQuery` hooks (in registration order — FIFO)
2. PostgreSQL executes the query
3. ORM `afterQuery` hooks (in reverse registration order — LIFO, middleware semantics)

For mutations, replace `beforeQuery`/`afterQuery` with `beforeMutation`/`afterMutation` — the same ordering applies: before-hooks FIFO, after-hooks LIFO.

### Pattern: soft-delete default WHERE filter

Use `beforeQuery` to inject a `deletedAt IS NULL` filter on every SELECT without requiring every call site to remember it:

```typescript
// doctest: skip — requires real PostgreSQL connection
import { createHookManager, createOrm, schema } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  posts: { id: 'integer', title: 'string', deletedAt: 'timestamp' },
} as const);

const hooks = createHookManager()
  .beforeQuery((ctx) => {
    // Inject soft-delete filter for posts table
    if (ctx.table === 'posts') {
      return {
        ...ctx,
        intent: {
          ...ctx.intent,
          // WhereIntent is a discriminated union — use the 'null' variant
          where: { kind: 'null', field: 'deletedAt', operator: 'isNull' },
        },
      };
    }
    return ctx;
  });

const orm = createOrm({ schema: db, adapter: createPgsqlAdapter(pool), hooks });
```

> **Note:** `schema()` accepts a `defaultFilters` option as its third argument for table-level default WHERE clauses. Use `defaultFilters` for simple equality/null checks — it is more idiomatic than a manual `beforeQuery` hook for this pattern:
>
> ```typescript
> const db = schema(
>   { posts: { id: 'integer', title: 'string', deletedAt: 'timestamp' } } as const,
>   undefined,
>   { defaultFilters: { posts: { deletedAt: null } } },
> );
> ```

### Pattern: audit log on mutations

Use `afterMutation` to record every write to a separate audit table:

```typescript
// doctest: skip — requires real PostgreSQL connection
import { createHookManager } from '@dbsp/core';

const hooks = createHookManager()
  .afterMutation(async (ctx, results) => {
    if (ctx.operation === 'update' || ctx.operation === 'delete') {
      // Fire-and-forget — don't await to avoid slowing the main path
      auditLogger.log({
        table: ctx.table,
        operation: ctx.operation,
        affectedRows: ctx.affectedRows,
        at: new Date(),
      }).catch(console.error);
    }
    return results;
  });
```

### Composability and ordering

`before*` hooks run in **registration order (FIFO)**; `after*` hooks run in **reverse registration order (LIFO)** — this mirrors standard middleware stacking where the last-registered wrapper is the outermost layer. Each hook in the chain receives the output of the previous hook:

```typescript
// doctest: skip — illustrative chaining; hookA/hookB/hookC are user-defined functions
const hooks = createHookManager()
  .beforeQuery(hookA)  // receives original ctx, returns ctx1 (runs first)
  .beforeQuery(hookB)  // receives ctx1, returns ctx2
  .beforeQuery(hookC); // receives ctx2 (runs last before query)
// afterQuery hooks fire in reverse: hookC → hookB → hookA
```

If a hook returns `undefined`, the previous ctx/results are forwarded unchanged. Hooks cannot be added after `createOrm()` — the manager is frozen internally at that point. Attempting to add hooks to a frozen manager throws:
`HookManager is frozen — hooks cannot be added after ORM creation.`
