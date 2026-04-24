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
const { sql: updatedSql } = orm.update('users')
  .set({ active: true })
  .where(eq('email', 'alice@example.com'))
  .returning(['id', 'name', 'active'])
  .dump();
```

---

## Delete

```typescript
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
