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

For CLI tooling, SQL preview, or offline testing, use `createPgsqlCompileOnlyAdapter()`. It constructs a normal PostgreSQL adapter without a connection, so planning, compilation, and `.dump()` work without a database. Execution methods remain present and refuse at runtime with the attempted operation and a pointer to `createPgsqlAdapter(pool)`.

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

## Correlation IDs in dumps and hooks

Attach a correlation ID to a dump to annotate that compile-only result:

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

The correlation ID appears in `dump.meta.correlationId` and is not sent to PostgreSQL. `.dump()` does not mutate the builder, so this value is not propagated to a later `.all()` call or its hook context. To add a correlation ID to an executing query's hook context, return it from `beforeQuery`:

```typescript
import { createHookManager } from '@dbsp/core';

const hooks = createHookManager().beforeQuery((ctx) => ({
  ...ctx,
  correlationId: 'req-123',
}));
```

---

## Query Hooks

`@dbsp/core` provides lifecycle hooks at the ORM instance via `createHookManager()`. Use `beforeQuery` / `observeAfterQuery` for cross-cutting concerns such as logging, metrics, and slow-query detection:

```typescript
// doctest: skip — requires real PostgreSQL pool
import { createOrm, createHookManager, schema } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ users: { id: 'integer', name: 'string' } } as const);

const hooks = createHookManager()
  .beforeQuery((ctx) => {
    logger.debug({ table: ctx.table, operation: ctx.operation, correlationId: ctx.correlationId }, 'query start');
    return ctx;
  })
  .observeAfterQuery((ctx, results) => {
    if (ctx.duration && ctx.duration > 1000) {
      logger.warn({ durationMs: ctx.duration }, 'slow query');
    }
    metrics.histogram('db.query.duration', ctx.duration ?? 0);
  });

const orm = createOrm({ schema: db, adapter: createPgsqlAdapter(pool), hooks });
```

| Hook | Type | When called |
|------|------|-------------|
| `beforeQuery` | `BeforeQueryHook` | Before the query executes |
| `observeAfterQuery` | `AfterQueryObserver` | After successful query execution only; cannot replace results |
| `afterQuery` | `AfterQueryHook` | After successful query execution only |
| `onError` | `OnErrorHook` | When the query throws (errors bypass `afterQuery`) |

`PgsqlAdapterOptions` (the second argument to `createPgsqlAdapter`) does not accept query callbacks — use ORM-level hooks via `createHookManager()` instead.

### Observer diagnostics

Observer failures and snapshot skips are sent to the optional ORM-level
`onObserverError` sink. It is always non-fatal: its return value is ignored,
and an exception from the sink is contained. `onHookError` remains the
control-flow handler for before-hooks and result transformers only; returning
`'abort'` there never changes the outcome of an observer.

```typescript
import { createHookManager, createOrm, schema } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ users: { id: 'integer', name: 'string' } } as const);
const hooks = createHookManager();
const telemetry = {
  captureException(_error: unknown, _context: unknown) {},
};

const orm = createOrm({
  schema: db,
  adapter: createPgsqlCompileOnlyAdapter(),
  hooks,
  onObserverError(error, observerName, phase) {
    telemetry.captureException(error, { observerName, phase });
  },
});
```

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
  .observeAfterQuery((ctx, results) => {
    console.log(`[${ctx.table}] returned ${Array.isArray(results) ? results.length : 1} row(s) in ${ctx.duration}ms`);
  });

const orm = createOrm({ schema: db, adapter: createPgsqlAdapter(pool), hooks });
```

Source: `packages/core/src/dx/hooks.ts` — `createHookManager()` returns a `HookManager`.

### Observer and transformer hook types

Observers receive an `unknown` result and cannot replace it; their return values are ignored. The existing parametric `after*` hooks are result-preserving transformers. All are defined in `packages/core/src/dx/hooks.ts`.

| Hook | Type | Context | Can transform |
|------|------|---------|---------------|
| `beforeQuery` | `BeforeQueryHook` | `QueryHookContext` | Yes — return modified ctx |
| `observeAfterQuery` | `AfterQueryObserver` | `QueryHookContext` | No |
| `afterQuery` | `AfterQueryHook` | `QueryHookContext` | Yes — preserve result shape |
| `beforeMutation` | `BeforeMutationHook` | `MutationHookContext<T>` | Yes — return modified ctx |
| `observeAfterMutation` | `AfterMutationObserver` | `MutationHookContext` | No |
| `afterMutation` | `AfterMutationHook` | `MutationHookContext<T>` | Yes — preserve result shape |
| `onError` | `OnErrorHook` | Error + context | No |

Each hook receives a **frozen** context object (`Object.freeze` is applied at construction time). Before-hooks can modify the context by returning a new one; transformers can return the same result shape; observer return values are ignored. Each observer receives its own `structuredClone` snapshots of both the result and the context, including mutable `intent`, `data`, and `parameters` members, so it cannot affect callers, transformers, or another observer. If either snapshot cannot be cloned, that observer is skipped and `onObserverError` receives the observer name and the cloning error. It never receives a live fallback value.

Shared-memory buffers are outside this observer snapshot contract because `structuredClone` preserves their shared backing store. PostgreSQL driver results on supported paths are plain data and do not use them.

### Hook context fields

**`QueryHookContext`** (beforeQuery / afterQuery):

| Field | Available in | Description |
|-------|-------------|-------------|
| `table` | both | Root table name |
| `operation` | both | Always `'select'` |
| `intent` | both | Full `QueryIntent` AST |
| `schemaName` | both | Schema if `withSchema()` was used |
| `inTransaction` | both | Whether inside `orm.transaction()` |
| `correlationId` | both | Optional value returned by a `beforeQuery` hook |
| `resultType` | both | `'all'`, `'first'`, or `'exists'` |
| `sql` | afterQuery only | Compiled SQL string |
| `parameters` | afterQuery only | Bound parameters (may contain PII) |
| `duration` | afterQuery only | Execution time in ms |

`resultType` has only three reachable values:

| Terminal execution | `resultType` |
|---|---|
| `all()` — including a builder modified by `count()` or another aggregate method | `'all'` |
| `first()` | `'first'` |
| `exists()` | `'exists'` |

Aggregate methods, including `count()`, modify the builder. They are materialized by a terminal such as `all()`; they are not separate terminal result types. This is a breaking type-surface change shipped in the same major version.

**`MutationHookContext<T>`** (beforeMutation / afterMutation) adds:

| Field | Description |
|-------|-------------|
| `operation` | `'insert'`, `'update'`, `'delete'`, `'upsert'` |
| `intent` | The mutation intent AST |
| `cardinality` | `'single'` or `'bulk'` |
| `data` | The values being written |
| `affectedRows` | afterMutation only — row count |

### NQL tag mutations

NQL tag mutations use the same mutation hook pipeline as fluent mutation builders when they execute through `.all()` or `.run()`. A mutation `.dump()` remains compile-only: it returns SQL and `parameters` without executing or firing hooks.

```typescript
const { createHookManager } = await import('@dbsp/core');

const __nqlHookDb = schema({
  users: {
    id: { type: 'integer', primaryKey: true },
    name: 'string',
    email: 'string',
  },
} as const);

const __nqlHookAdapter = createPgsqlCompileOnlyAdapter() as unknown as NonNullable<
  Parameters<typeof createOrm>[0]['adapter']
>;
__nqlHookAdapter.executeWithMeta = async () => ({ rows: [{ id: 1 }], rowCount: 1 });
Object.defineProperty(__nqlHookAdapter, 'connectionAvailability', {
  value: { status: 'available' },
  configurable: true,
});

const __nqlHookEvents: string[] = [];
const __nqlHooks = createHookManager()
  .beforeMutation((ctx) => {
    __nqlHookEvents.push(`before:${ctx.operation}:${ctx.table}`);
    return ctx;
  })
  .afterMutation((ctx, rows) => {
    __nqlHookEvents.push(`after:${ctx.operation}:${ctx.table}:${rows.length}`);
    return rows;
  });

const __nqlHookOrm = createOrm({
  schema: __nqlHookDb,
  adapter: __nqlHookAdapter,
  hooks: __nqlHooks,
});

const __nqlHookDump = __nqlHookOrm.nql<unknown>`
  insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | select id
`.dump() as { sql: string; parameters: readonly unknown[] };

if (__nqlHookEvents.length !== 0 || !__nqlHookDump.sql.includes('INSERT INTO users')) {
  throw new Error('NQL mutation dump should compile without firing hooks');
}

const __nqlHookRows = await __nqlHookOrm.nql<{ id: number }>`
  insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | select id
`.all();

if (
  __nqlHookRows.length !== 1 ||
  __nqlHookEvents.join(',') !== 'before:insert:users,after:insert:users:1'
) {
  throw new Error('NQL mutation hooks did not run as expected');
}
```

### Lifecycle order

For materializing SELECT terminals (`all()`, `first()`, and `exists()`), hooks fire in this order. Aggregate methods, including `count()`, are builder modifiers materialized by one of those terminals:

1. ORM `beforeQuery` hooks (in registration order — FIFO)
2. PostgreSQL executes the query
3. ORM `observeAfterQuery` observers (in reverse registration order — LIFO; return values ignored)
4. ORM `afterQuery` transformers (in reverse registration order — LIFO, middleware semantics)

For mutations, replace `beforeQuery`/`afterQuery` with `beforeMutation`/`afterMutation`; `observeAfterMutation` likewise runs before the transformers. Before-hooks are FIFO and each after phase is LIFO.

`stream()` does not materialize a result and never runs observers or transformers.

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

### Pattern: best-effort mutation telemetry

Use `observeAfterMutation` for best-effort mutation telemetry:

```typescript
// doctest: skip — requires real PostgreSQL connection
import { createHookManager } from '@dbsp/core';

const hooks = createHookManager()
  .observeAfterMutation(async (ctx, _results) => {
    if (ctx.operation === 'update' || ctx.operation === 'delete') {
      // Fire-and-forget — don't await to avoid slowing the main path
      auditLogger.log({
        table: ctx.table,
        operation: ctx.operation,
        affectedRows: ctx.affectedRows,
        at: new Date(),
      }).catch(console.error);
    }
});
```

> **Warning:** this is not an audit log. Observers run after statement execution but before a surrounding transaction commits, and the fire-and-forget call can fail or be lost. There is no commit notification hook. For an audit trail, use a database trigger or transactional outbox.

### Composability and ordering

`before*` hooks run in **registration order (FIFO)**. `observeAfter*` observers and `after*` transformers each run in **reverse registration order (LIFO)**; observers run before transformers and their return values are ignored. Observer failures are reported to `onObserverError` when configured (or to `console.error` otherwise) and never change the operation outcome. Each transformer in its chain receives the output of the previous transformer:

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
