---
title: Mutations
---

# Mutations

`@dbsp/core` provides four mutation builders — insert, update, delete, and upsert. All require an explicit `.execute()` call; none run implicitly. Every builder also supports `.dump()` for SQL inspection without hitting the database.

---

## Insert

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

Source: `packages/core/src/dx/mutation-builders.ts:870` — `onConflictConstraint(constraintName: string)`.

#### Conditional updates with a WHERE clause on DO UPDATE

`doUpdate()` accepts an optional second argument for a WHERE condition on the conflict update. Only rows matching that condition are updated; conflicting rows that do not match are effectively skipped:

```typescript
// doctest: skip — conditional update pattern
import { gt } from '@dbsp/core';

// Only update the price if the incoming value is higher than the stored one
orm.upsert('products')
  .values({ sku: 'ABC', price: 99.99 })
  .onConflict(['sku'])
  .doUpdate(
    { price: 99.99 },
    gt('products.price', 50) // WHERE condition on the existing row
  )
  .dump();
```

Source: `packages/core/src/dx/mutation-builders.ts:887` — `doUpdate(set?, where?)`.

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
| Conditional upsert: only update if a condition holds | `.doUpdate(set, whereCondition)` |

`.doNothing()` compiles to `ON CONFLICT DO NOTHING` — the entire row is left unchanged on a conflict. It is the correct choice for "insert if not exists" patterns where updating the existing row would be incorrect (e.g., first-write-wins semantics).

---

## Safety Rules

| Builder | Safety rule |
|---------|-------------|
| `orm.update()` | Requires `.where()` — throws `UnsafeOperationError` without it |
| `orm.delete()` | Requires `.where()` — throws `UnsafeOperationError` without it |
| `orm.updateAll()` | No WHERE required — explicit opt-in for full-table update |
| `orm.deleteAll()` | No WHERE required — explicit opt-in for full-table delete |

These rules prevent silent data loss from forgotten filter conditions.

---

## Observability with dump()

All mutation builders support `.dump()` — inspect the SQL and parameters without executing:

```typescript
const { sql, params } = orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .dump();

console.log(sql);
// INSERT INTO "users" ("name", "email") VALUES ($1, $2)

console.log(params);
// ['Alice', 'alice@example.com']
```

This works even without a database connection (compile-only mode). See [Observability](./observability) for more on `dump()`.
