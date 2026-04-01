---
title: Mutations
---

# Mutations

`@dbsp/core` provides four mutation builders — insert, update, delete, and upsert. All require an explicit `.execute()` call; none run implicitly. Every builder also supports `.dump()` for SQL inspection without hitting the database.

---

## Insert

```typescript
// Insert a single row
await orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .execute();
```

### Bulk Insert

Pass an array to `.values()` to insert multiple rows in a single statement:

```typescript
await orm.insert('users')
  .values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob',   email: 'bob@example.com'   },
  ])
  .execute();
```

### RETURNING

Use `.returning()` to get back specific columns from the inserted rows:

```typescript
const [newUser] = await orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'name', 'createdAt'])
  .execute();

console.log(newUser.id); // UUID assigned by the database
```

---

## Update

```typescript
import { eq } from '@dbsp/core';

await orm.update('users')
  .set({ name: 'Alice Smith' })
  .where(eq('id', userId))
  .execute();
```

`update()` **requires a `.where()` clause**. Omitting it throws `UnsafeOperationError` — this is a safety guard against accidental full-table updates.

### Update All Rows (Intentional Full-Table)

When you genuinely need to update every row, use `updateAll()`:

```typescript
await orm.updateAll('users')
  .set({ active: false })
  .execute();
```

### Update with RETURNING

```typescript
const updated = await orm.update('users')
  .set({ active: true })
  .where(eq('email', 'alice@example.com'))
  .returning(['id', 'name', 'active'])
  .execute();
```

---

## Delete

```typescript
await orm.delete('posts')
  .where(eq('published', false))
  .execute();
```

Like `update()`, `delete()` **requires a `.where()` clause**. Use `deleteAll()` when you intend to remove every row:

```typescript
await orm.deleteAll('users').execute();
```

### Delete with RETURNING

```typescript
const removed = await orm.delete('posts')
  .where(eq('published', false))
  .returning(['id', 'title'])
  .execute();
```

---

## Upsert

Insert a row, or update it on conflict:

```typescript
// Auto-update all non-conflict columns
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate()
  .execute();

// Update only specific columns on conflict
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate({ name: 'Alice Updated', active: true })
  .execute();

// Skip the row silently on conflict
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doNothing()
  .execute();

// Conflict by constraint name instead of columns
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflictConstraint('users_email_unique')
  .doNothing()
  .execute();

// With RETURNING
const result = await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doUpdate()
  .returning(['id', 'name'])
  .execute();
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
