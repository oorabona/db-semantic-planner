---
title: CASE Expressions
---

# How to Use CASE Expressions

The `caseWhen()` builder lets you add conditional logic directly in SELECT columns, ORDER BY clauses or WHERE conditions without writing raw SQL strings. Use it when you need label mapping, numeric bucketing, or status display logic that belongs in the query rather than in application code.

## When

When you need conditional logic in SELECT columns (e.g. label mapping, status display, bucketing)
or ORDER BY clauses. `caseWhen()` builds an `ExpressionRef`, so the result goes wherever an
expression does: `.columns([...])` with `.as()` for the alias, `.orderBy(...)`, or `.where(...)`
through its comparison methods (`.eq()`, `.gt()` …).

## API

```typescript
// doctest: skip — API signature reference (TypeScript function signature, not executable code)
import { caseWhen } from '@dbsp/core'

caseWhen(condition: WhereIntent, result: CaseValue): CaseBuilder
  .when(condition: WhereIntent, result: CaseValue): CaseBuilder  // chain additional WHEN clauses
  .else(result: CaseValue): ExpressionRef                        // CASE … ELSE … END
  .toExpr(): ExpressionRef                                       // CASE … END, without ELSE
  .as(alias: string): ExpressionRef                              // CASE … END AS alias, without ELSE
```

A condition is a `WhereIntent`, built with the filter helpers: `eq()`, `gt()`, `gte()`, `and()`,
`or()`, `isNull()` and the others. Its values are bound parameters, as in `.where()`.

## Results

A result of `caseWhen(condition, result)`, `.when(condition, result)` or `.else(result)`
follows the [argument rule](./expression-primitives.md#argument-rule) of the
expression primitives, with one addition: `null` is SQL `NULL`.

| Result | SQL |
|--------|-----|
| `'title'` (a string) | the column `title` |
| `10`, `true`, `2n` | inlined: `10`, `true`, `2` |
| `literal('Active')` | inlined: `'Active'`, in the SELECT list, ORDER BY and WHERE alike |
| `null` | `NULL` |
| `NaN`, `Infinity`, an array, a `Date` | a bound parameter `$N` |
| `exprRef()`, `fn()`, `subquery('t').count().asExpr('n')` … | the expression, a subquery as `(SELECT …)` |

`undefined`, a plain object and a `sql()` marker are refused with `InvalidOperationError`.

```typescript
import { caseWhen, createOrm, eq, literal, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const caseDb = schema({
  posts: { id: { type: 'integer', primaryKey: true }, score: 'integer', title: 'text' },
});
const caseOrm = createOrm({
  schema: caseDb,
  adapter: createPgCompileOnlyAdapter({ model: caseDb.model }),
});

const { sql, params } = caseOrm
  .select('posts')
  .columns([caseWhen(eq('score', 1), literal('A')).else('title').as('label')])
  .dump();
// sql:    SELECT CASE WHEN posts.score = $1 THEN 'A' ELSE title END AS label FROM posts
// params: [1]
```

## Examples

### 1. Simple status label

```typescript
import { caseWhen, createOrm, eq, literal, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  orders: { id: { type: 'integer', primaryKey: true }, total: 'integer', status: 'text' },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('orders')
  .columns([
    'id',
    'total',
    caseWhen(eq('status', 'pending'), literal('Awaiting payment'))
      .when(eq('status', 'shipped'), literal('In transit'))
      .when(eq('status', 'delivered'), literal('Delivered'))
      .else(literal('Unknown'))
      .as('statusLabel'),
  ])
  .dump();
// params: ['pending', 'shipped', 'delivered']
```

Generated SQL:
```sql
SELECT orders.id, orders.total,
       CASE WHEN orders.status = $1 THEN 'Awaiting payment'
            WHEN orders.status = $2 THEN 'In transit'
            WHEN orders.status = $3 THEN 'Delivered'
            ELSE 'Unknown'
       END AS "statusLabel"
FROM orders
```

### 2. Numeric bucketing

```typescript
import { caseWhen, createOrm, gt, literal, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  employees: { id: { type: 'integer', primaryKey: true }, salary: 'integer' },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('employees')
  .columns([
    'id',
    caseWhen(gt('salary', 80000), literal('senior'))
      .when(gt('salary', 50000), literal('mid'))
      .else(literal('junior'))
      .as('level'),
  ])
  .dump();
// params: [80000, 50000]
```

Generated SQL:
```sql
SELECT employees.id,
       CASE WHEN employees.salary > $1 THEN 'senior'
            WHEN employees.salary > $2 THEN 'mid'
            ELSE 'junior'
       END AS level
FROM employees
```

### 3. Column reference in THEN/ELSE

A plain string result is a column:

```typescript
import { caseWhen, createOrm, eq, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: {
    id: { type: 'integer', primaryKey: true },
    role: 'text',
    adminName: 'text',
    displayName: 'text',
  },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('users')
  .columns([
    'id',
    caseWhen(eq('role', 'admin'), 'adminName').else('displayName').as('resolvedName'),
  ])
  .dump();
// params: ['admin']
```

Generated SQL:
```sql
SELECT users.id,
       CASE WHEN users.role = $1 THEN "adminName"
            ELSE "displayName"
       END AS "resolvedName"
FROM users
```

### 4. Boolean flag column

```typescript
import { caseWhen, createOrm, gte, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: { id: { type: 'integer', primaryKey: true }, score: 'integer' },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('users')
  .columns(['id', caseWhen(gte('score', 90), 1).else(0).as('passed')])
  .dump();
// params: [90]
```

Generated SQL:
```sql
SELECT users.id,
       CASE WHEN users.score >= $1 THEN 1
            ELSE 0
       END AS passed
FROM users
```

Numeric values are inlined directly (not parameterized — see Gotchas).

### 5. CASE in ORDER BY

```typescript
import { caseWhen, createOrm, eq, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  tasks: { id: { type: 'integer', primaryKey: true }, title: 'text', priority: 'text' },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('tasks')
  .columns(['id', 'title', 'priority'])
  .orderBy(
    caseWhen(eq('priority', 'critical'), 1)
      .when(eq('priority', 'high'), 2)
      .when(eq('priority', 'medium'), 3)
      .else(4),
  )
  .dump();
// params: ['critical', 'high', 'medium']
```

Generated SQL:
```sql
SELECT tasks.id, tasks.title, tasks.priority
FROM tasks
ORDER BY CASE WHEN tasks.priority = $1 THEN 1
              WHEN tasks.priority = $2 THEN 2
              WHEN tasks.priority = $3 THEN 3
              ELSE 4
         END ASC
```

### 6. DISTINCT ON + CASE pattern

```typescript
import { caseWhen, createOrm, eq, literal, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  events: {
    id: { type: 'integer', primaryKey: true },
    userId: 'integer',
    type: 'text',
    createdAt: 'timestamp',
  },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('events')
  .distinctOn('userId')
  .columns([
    'userId',
    caseWhen(eq('type', 'login'), literal('active'))
      .else(literal('inactive'))
      .as('lastEventType'),
  ])
  .orderBy('userId')
  .orderBy('createdAt', 'desc')
  .dump();
// params: ['login']
```

Generated SQL:
```sql
SELECT DISTINCT ON ("userId") events."userId",
       CASE WHEN events.type = $1 THEN 'active'
            ELSE 'inactive'
       END AS "lastEventType"
FROM events
ORDER BY events."userId" ASC, events."createdAt" DESC
```

### 7. CASE without ELSE

`.toExpr()` (or `.as(alias)` directly on the builder) ends the CASE without an ELSE, so
non-matching rows get `NULL`:

```typescript
import { caseWhen, createOrm, eq, literal, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: { id: { type: 'integer', primaryKey: true }, role: 'text' },
});
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

const { sql, params } = orm
  .select('users')
  .columns(['id', caseWhen(eq('role', 'admin'), literal('yes')).toExpr().as('isAdmin')])
  .dump();
// params: ['admin']
```

Generated SQL:
```sql
SELECT users.id,
       CASE WHEN users.role = $1 THEN 'yes'
       END AS "isAdmin"
FROM users
```

## Key Files

- **Builder:** `packages/core/src/dx/case-when-builder.ts` — `caseWhen()`, `CaseBuilder`, `CaseValue`
- **Result rule:** `packages/core/src/dx/coerce.ts` — the argument rule CASE results share with the expression primitives
- **Lowering:** `packages/adapter-pgsql/src/handlers/expression/case-value.ts` compiles THEN/ELSE results in the SELECT list; `packages/core/src/resolved-conditions.ts` resolves them in a WHERE condition

## Gotchas

- **Numeric and boolean results are inlined, not parameterized** — `caseWhen(gt('x', 1), 42)` produces `THEN 42`, not `THEN $N`. An inlined constant keeps its SQL type, where a bound parameter would be sent as text.
- **A plain string result is a column, not a string** — `caseWhen(eq('role', 'admin'), 'adminName')` reads the column `adminName`. Write `literal('Admin')` for the string `'Admin'`; it is inlined, with single quotes escaped as `''`.
- **Condition values are bound** — `eq('status', 'pending')` compiles to `status = $1` with `'pending'` in the parameters.
- **`null` is `NULL`; `undefined` is refused** — a missing result is an error, not an implicit `NULL`. Write `null` or `literal(null)`, or end the CASE with `.toExpr()`.
- **Aliases are quoted, not validated** — `.as('statusLabel')` emits `AS "statusLabel"`, and an alias with spaces or upper-case letters is emitted quoted.
