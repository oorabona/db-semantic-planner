---
title: CASE Expressions
---

# How to Use CASE Expressions

The `caseWhen()` builder lets you add conditional logic directly in SELECT columns or ORDER BY clauses without writing raw SQL strings. Use it when you need label mapping, numeric bucketing, or status display logic that belongs in the query rather than in application code.

## When

When you need conditional logic in SELECT columns (e.g. label mapping, status display, bucketing)
or ORDER BY clauses. The `caseWhen()` builder produces a `CaseExpr` that integrates directly with
the query builder API via `.as()` for aliasing.

## API

```typescript
import { caseWhen, ref } from '@dbsp/core'

caseWhen<T>()
  .when(condition: string, result: T | ColumnRef): CaseBuilder<T>
  .when(...)                                       // chain additional WHEN clauses
  .else(result: T | ColumnRef): CaseExpr<T>        // finalizes — ELSE is required

// CaseExpr<T> methods:
caseExpr.as(alias: string): CaseExpr<T>  // add or override alias (validates identifier)
```

The condition string passed to `.when()` is a SQL boolean expression using the same syntax as
WHERE clauses. Result values can be:

- **Literals:** strings, numbers, booleans — passed directly (strings single-quoted, numerics/booleans inlined)
- **Column references:** `ref('columnName')` — compiled to a qualified column reference

`.else()` is required to finalize the builder. A `CASE` without an ELSE clause returns `NULL` for
non-matching rows; to replicate that, use `ref` with a null-typed column or use `literal(null)`.

## Examples

### 1. Simple status label

```typescript
import { caseWhen } from '@dbsp/core'

const query = orm.select('orders')
  .columns([
    'id',
    'total',
    caseWhen<string>()
      .when("status = 'pending'", 'Awaiting payment')
      .when("status = 'shipped'", 'In transit')
      .when("status = 'delivered'", 'Delivered')
      .else('Unknown')
      .as('statusLabel'),
  ])
```

Generated SQL:
```sql
SELECT "orders"."id",
       "orders"."total",
       CASE WHEN status = 'pending' THEN 'Awaiting payment'
            WHEN status = 'shipped' THEN 'In transit'
            WHEN status = 'delivered' THEN 'Delivered'
            ELSE 'Unknown'
       END AS "statusLabel"
FROM "orders"
```

### 2. Numeric bucketing

```typescript
caseWhen<string>()
  .when('salary > 80000', 'senior')
  .when('salary > 50000', 'mid')
  .else('junior')
  .as('level')
```

Generated SQL fragment:
```sql
CASE WHEN salary > 80000 THEN 'senior'
     WHEN salary > 50000 THEN 'mid'
     ELSE 'junior'
END AS "level"
```

### 3. Column reference in THEN/ELSE

```typescript
import { caseWhen, ref } from '@dbsp/core'

// Use a column value as the result
caseWhen()
  .when("role = 'admin'", ref('adminName'))
  .else(ref('displayName'))
  .as('resolvedName')
```

Generated SQL fragment:
```sql
CASE WHEN role = 'admin' THEN "adminName"
     ELSE "displayName"
END AS "resolvedName"
```

### 4. Boolean flag column

```typescript
caseWhen<number>()
  .when('score >= 90', 1)
  .else(0)
  .as('passed')
```

Generated SQL fragment:
```sql
CASE WHEN score >= 90 THEN 1
     ELSE 0
END AS "passed"
```

Numeric values are inlined directly (not parameterized — see Gotchas).

### 5. CASE in ORDER BY

```typescript
const query = orm.select('tasks')
  .columns(['id', 'title', 'priority'])
  .orderBy([
    caseWhen<number>()
      .when("priority = 'critical'", 1)
      .when("priority = 'high'", 2)
      .when("priority = 'medium'", 3)
      .else(4)
      .as('priorityRank'),
  ])
```

Generated SQL:
```sql
SELECT "tasks"."id", "tasks"."title", "tasks"."priority"
FROM "tasks"
ORDER BY CASE WHEN priority = 'critical' THEN 1
              WHEN priority = 'high' THEN 2
              WHEN priority = 'medium' THEN 3
              ELSE 4
         END ASC
```

### 6. DISTINCT ON + CASE pattern

```typescript
const query = orm.select('events')
  .distinctOn(['userId'])
  .columns([
    'userId',
    caseWhen<string>()
      .when("type = 'login'", 'active')
      .else('inactive')
      .as('lastEventType'),
  ])
  .orderBy([{ column: 'userId' }, { column: 'createdAt', direction: 'desc' }])
```

Generated SQL:
```sql
SELECT DISTINCT ON ("events"."userId")
       "events"."userId",
       CASE WHEN type = 'login' THEN 'active'
            ELSE 'inactive'
       END AS "lastEventType"
FROM "events"
ORDER BY "events"."userId", "events"."createdAt" DESC
```

## Key Files

- **Builder + types:** `packages/core/src/dx/functions.ts` — `caseWhen()`, `CaseBuilder<T>`, `CaseExpr<T>`, `CaseWhenClause<T>`, `CaseBuilderImpl`
- **Adapter handler:** `packages/adapter-pgsql/src/handlers/expression/case.ts` — compiles `CaseExpr` intent into SQL fragments

## Gotchas

- **Numeric and boolean literals are inlined, not parameterized** — `caseWhen().when('x > 1', 42)` produces `THEN 42`, not `THEN $N`. This is intentional for SQL readability and matches how PostgreSQL handles constant folding, but means the same plan is not cached differently for different constants.
- **String literals are single-quoted inline** — `.else('Unknown')` produces `ELSE 'Unknown'`, not `ELSE $N`. Single quotes inside the string are escaped as `''` (SQL standard).
- **Conditions are raw SQL strings** — the condition passed to `.when()` is not parsed or validated. Use the same expression syntax as a WHERE clause but written as a string. Column references in conditions should use unquoted names unless they conflict with PostgreSQL reserved words.
- **Use `ref('col')` for column references in results** — passing a column name as a plain string to THEN/ELSE treats it as a string literal. Use `ref('columnName')` to reference a column value.
- **`.else()` is required** — the builder enforces ELSE at the TypeScript level. To produce a CASE without ELSE (implicit NULL), this API does not support it directly; use the lower-level `op()` / `fn()` expression primitives instead.
- **Alias validation** — `.as(alias)` calls `validateAlias(alias)` internally. Invalid identifiers (e.g. names with spaces or SQL keywords) will throw at build time.

