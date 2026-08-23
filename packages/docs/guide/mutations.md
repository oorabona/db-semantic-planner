---
title: Mutations
---

# Mutations

`@dbsp/core` provides four mutation builders — insert, update, delete, and upsert. All require an explicit `.execute()` call; none run implicitly. Every builder also supports `.dump()` for SQL inspection without hitting the database.

---

## Insert

`values()` checks column keys and value types, but it cannot yet derive which
columns are database-generated or have defaults. Required-column enforcement
therefore remains with the database; an empty row is rejected before SQL is
compiled.

```typescript
// Insert a single row
orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .dump();
```

### Bulk Insert

Pass an array to `.values()` to insert multiple rows in a single statement:

```typescript
orm.insert('users')
  .values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob',   email: 'bob@example.com'   },
  ])
  .dump();
```

### RETURNING

Use `.returning()` to get back specific columns from the inserted rows:

```typescript
const { sql: newUserSql } = orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'name', 'createdAt'])
  .dump();

```

---

## Update

```typescript
const userId = 1;

import { eq } from '@dbsp/core';

orm.update('users')
  .set({ name: 'Alice Smith' })
  .where(eq('id', userId))
  .dump();
```

`update()` **requires a `.where()` clause**. Omitting it throws `UnsafeOperationError` — this is a safety guard against accidental full-table updates.

### Update All Rows (Intentional Full-Table)

When you genuinely need to update every row, use `updateAll()`:

```typescript
orm.updateAll('users')
  .set({ active: false })
  .dump();
```

### Update with RETURNING

```typescript
import { eq } from '@dbsp/core';

const { sql: updatedSql } = orm.update('users')
  .set({ active: true })
  .where(eq('email', 'alice@example.com'))
  .returning(['id', 'name', 'active'])
  .dump();
```

---

## Delete

```typescript
import { eq } from '@dbsp/core';

orm.delete('posts')
  .where(eq('published', false))
  .dump();
```

Like `update()`, `delete()` **requires a `.where()` clause**. Use `deleteAll()` when you intend to remove every row:

```typescript
orm.deleteAll('users').dump();
```

### Delete with RETURNING

```typescript
import { eq } from '@dbsp/core';

const { sql: removedSql } = orm.delete('posts')
  .where(eq('published', false))
  .returning(['id', 'title'])
  .dump();
```

### Relation guards with exists()

Mutation `WHERE` clauses can use relation-aware `exists()` guards. The relation must be declared in the schema; the compiler emits the foreign-key correlation and your extra relation filter. `.dump()` compiles the mutation without opening a database connection.

```typescript
const __mutationGuardDb = schema({
  posts: {
    id: { type: 'integer', primaryKey: true },
    title: 'string',
    archived: 'boolean',
  },
  comments: {
    id: { type: 'integer', primaryKey: true },
    postId: ref('posts'),
    flagged: 'boolean',
  },
} as const);

const __mutationGuardOrm = createOrm({
  schema: __mutationGuardDb,
  adapter: createPgsqlCompileOnlyAdapter({ model: __mutationGuardDb.model }),
});

const __mutationGuardDump = __mutationGuardOrm.update('posts')
  .set({ archived: true })
  .where(exists('comments', { where: eq('flagged', true) }))
  .dump();

if (
  !__mutationGuardDump.sql.includes('WHERE EXISTS') ||
  !__mutationGuardDump.sql.includes('comments_exists_0.flagged = $2') ||
  __mutationGuardDump.parameters.length !== 2 ||
  __mutationGuardDump.parameters[0] !== true ||
  __mutationGuardDump.parameters[1] !== true
) {
  throw new Error('mutation exists() relation guard did not compile as expected');
}
```

---

## Upsert

Insert a row, or update it on conflict:

```typescript
// Auto-update all non-conflict columns
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate()
  .dump();

// Update only specific columns on conflict
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate({ name: 'Alice Updated', active: true })
  .dump();

// Skip the row silently on conflict
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doNothing()
  .dump();

// Conflict by constraint name instead of columns
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflictConstraint('users_email_unique')
  .doNothing()
  .dump();

// With RETURNING
const { sql: resultSql } = orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doUpdate()
  .returning(['id', 'name'])
  .dump();
```

### Advanced ON CONFLICT patterns

The basic upsert patterns above cover most use cases. The following patterns handle edge cases you will encounter in production schemas.

#### Selecting a specific constraint

When a table has multiple unique constraints, specify which one governs conflict detection. Use `.onConflictConstraint(name)` to target a named constraint instead of listing columns:

```typescript
// doctest: skip — constraint names are DB-specific
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', externalId: 'ext-001' })
  .onConflictConstraint('users_email_unique')
  .doUpdate({ name: 'Alice Updated' })
  .dump();
// SQL: INSERT INTO "users" (...) VALUES ($1, $2, $3)
// ON CONFLICT ON CONSTRAINT "users_email_unique"
// DO UPDATE SET "name" = $4
```

Source: `onConflictConstraint(constraintName: string)` in `packages/core/src/dx/mutation-builders.ts`.

#### Partial-index conflict targets with a WHERE clause

PostgreSQL partial indexes restrict conflict detection to rows that satisfy a condition. The fluent `.onConflict()` API accepts only a column array and cannot express the partial-index predicate, so do not use it to target a partial unique index. Use a non-partial unique constraint with the fluent builder, or an explicit SQL escape hatch when you must target a partial index.

```typescript
// A non-partial unique index: CREATE UNIQUE INDEX ON "products" ("sku")
orm.upsert('products')
  .values({ sku: 'ABC', price: 99.99, active: true })
  .onConflict(['sku'])
  .doUpdate({ price: 99.99 })
  .dump();
// SQL: INSERT INTO "products" ("sku", "price", "active") VALUES ($1, $2, $3)
// ON CONFLICT ("sku")
// DO UPDATE SET "price" = $4
```

> **Note:** The `WHERE` passed as the second argument to `.doUpdate()` applies to the UPDATE action, not to conflict-target inference.

#### Conditional DO UPDATE predicates

Use the second argument to `.doUpdate(set, where)` when conflict detection should happen normally, but the conflicting row should only be updated if the existing target row matches a predicate:

```typescript
import { eq } from '@dbsp/core';

orm.upsert('products')
  .values({ sku: 'ABC', price: 99.99, active: true })
  .onConflict(['sku'])
  .doUpdate({ price: 99.99 }, eq('active', true))
  .dump();
// SQL: INSERT INTO "products" ("sku", "price", "active") VALUES ($1, $2, $3)
// ON CONFLICT ("sku") DO UPDATE SET "price" = excluded."price"
// WHERE "products"."active" = $4
```

This `WHERE` belongs to the `DO UPDATE` action. If it evaluates to false, PostgreSQL leaves the existing conflicting row unchanged.

#### Multi-column conflict targets

List all columns that compose the unique constraint when the conflict target spans multiple columns:

```typescript
orm.upsert('user_roles')
  .values({ userId: 1, roleId: 3, grantedAt: new Date() })
  .onConflict(['userId', 'roleId'])
  .doUpdate({ grantedAt: new Date() })
  .dump();
// SQL: INSERT INTO "user_roles" (...) VALUES ($1, $2, $3)
// ON CONFLICT ("userId", "roleId")
// DO UPDATE SET "grantedAt" = $4
```

#### DO NOTHING vs DO UPDATE — when to use each

| Need | Use |
|------|-----|
| Idempotent insert: ignore if already exists | `.doNothing()` |
| Upsert: create if new, update if exists | `.doUpdate()` (no args = auto-update all non-conflict columns) |
| Selective upsert: update only specific fields | `.doUpdate({ col: value })` |
| Conditional upsert: only update if a condition holds | `.doUpdate({ col: value }, whereCondition)` |

`.doNothing()` compiles to `ON CONFLICT DO NOTHING` — the entire row is left unchanged on a conflict. It is the correct choice for "insert if not exists" patterns where updating the existing row would be incorrect (e.g., first-write-wins semantics).

---

## Safety Rules

| Builder | Safety rule |
|---------|-------------|
| `orm.update()` | Requires `.where()` — throws `UnsafeOperationError` without it |
| `orm.delete()` | Requires `.where()` — throws `UnsafeOperationError` without it |
| `orm.updateAll()` | No WHERE required — explicit opt-in for full-table update |
| `orm.deleteAll()` | No WHERE required — explicit opt-in for full-table delete |
| `values()` / `doUpdate()` / `set()` | Column keys and value types are checked; INSERT requiredness remains database-enforced until default/serial metadata is modeled |

These rules prevent silent data loss from forgotten filter conditions.

---

## Observability with dump()

All mutation builders support `.dump()` — inspect the SQL and parameters without executing:

```typescript
const { sql, parameters } = orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .dump();

console.log(sql);
// INSERT INTO "users" ("name", "email") VALUES ($1, $2)

console.log(parameters);
// ['Alice', 'alice@example.com']
```

This works even without a database connection (compile-only mode). See [Observability](./observability) for more on `dump()`.
