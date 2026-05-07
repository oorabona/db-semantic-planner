---
title: Transactions
description: Run multiple operations atomically with orm.transaction() — auto-commit on success, auto-rollback on any thrown error.
---

# Transactions

By default, every `orm.select()`, `orm.insert()`, `orm.update()`, and `orm.delete()` call runs as an independent, auto-committed statement. That is fine for isolated reads and writes, but it means two related writes can partially succeed if an error occurs between them. Transactions give you an all-or-nothing boundary: either every operation inside the callback commits, or the entire group rolls back automatically.

## Why this matters

The classic misconception is "I can catch the error myself and roll back manually." In practice, managing connection-level transaction state by hand across async callbacks leads to leaked connections, partial commits, and state corruption. The `orm.transaction()` callback pattern eliminates that class of bugs by handling BEGIN / COMMIT / ROLLBACK for you.

---

## Basic usage

```typescript
// doctest: skip — requires real PostgreSQL connection
import { eq } from '@dbsp/core';

const result = await orm.transaction(async (tx) => {
  // Use `tx` (not `orm`) for every operation inside the transaction.
  await tx.insert('audit_events')
    .values({ userId: 1, action: 'transfer', createdAt: new Date() })
    .execute();

  await tx.update('accounts')
    .set({ balance: 900 })
    .where(eq('id', 1))
    .execute();

  await tx.update('accounts')
    .set({ balance: 600 })
    .where(eq('id', 2))
    .execute();

  return { transferred: 100 };
});

console.log(result.transferred); // 100 — all three statements committed atomically
```

The callback receives `tx`, a transaction-scoped `OrmInstance` backed by the same connection being held open for the transaction. The callback's return value becomes the resolved value of `orm.transaction()`.

Source reference: `packages/core/src/dx/orm-instance.ts:796` — `transaction<T>(fn)` delegates to `adapter.transaction(txAdapter => fn(txOrm))` where `txOrm` is a fresh ORM instance with `inTransaction: true`.

---

## Error handling and rollback

Any `throw` — whether a database error, a validation error, or any JavaScript exception — inside the callback automatically triggers a `ROLLBACK` before the error propagates:

```typescript
// doctest: skip — requires real PostgreSQL connection
import { eq } from '@dbsp/core';

try {
  await orm.transaction(async (tx) => {
    await tx.insert('orders')
      .values({ userId: 1, total: 250 })
      .execute();

    // Simulate a validation failure mid-transaction
    const user = await tx.select('users').where(eq('id', 1)).first();
    if (!user?.creditApproved) {
      throw new Error('Credit check failed'); // ← triggers automatic ROLLBACK
    }

    await tx.update('inventory')
      .set({ reserved: 1 })
      .where(eq('productId', 42))
      .execute();
  });
} catch (err) {
  // Both inserts above were rolled back — the DB is unchanged.
  console.error('Transaction failed:', err.message);
}
```

You do not need to call any rollback method manually. The adapter catches the thrown error, issues `ROLLBACK`, releases the connection back to the pool, then re-throws so your `catch` block receives the original error.

---

## Return values

`orm.transaction()` is fully typed. The return type is `Promise<T>` where `T` is inferred from the callback's return type:

```typescript
// doctest: skip — requires real PostgreSQL connection
import { eq } from '@dbsp/core';

// TypeScript infers Promise<{ orderId: number }>
const { orderId } = await orm.transaction(async (tx) => {
  const [order] = await tx.insert('orders')
    .values({ userId: 42, total: 99 })
    .returning(['id'])
    .execute();

  return { orderId: order.id };
});
```

---

## Transaction-scoped vs pool-scoped

**Only use `tx` inside the callback, never the outer `orm`.** Queries sent through `orm` outside the callback run on a different pooled connection and are not part of the transaction:

```typescript
// doctest: skip — illustrates the wrong pattern
await orm.transaction(async (tx) => {
  await tx.insert('events').values({ type: 'start' }).execute();

  // WRONG: this query runs outside the transaction on a different connection.
  // It will not see the uncommitted 'events' insert above.
  await orm.select('events').all();

  // CORRECT: use tx for every query that needs to be inside the transaction.
  await tx.select('events').all();
});
```

The `tx` instance shares all schema, hooks, schema-scoping (`withSchema`), and default filters configured on the original `orm` — the only thing that changes is the underlying connection context.

---

## Interaction with hooks

ORM-level hooks (registered via `createHookManager()`) **do fire** inside transactions. The `QueryHookContext` and `MutationHookContext` both carry an `inTransaction: boolean` flag (defined in `packages/core/src/dx/hooks.ts:55`) so your hooks can adapt their behavior — for example, deferring expensive audit writes until after commit:

```typescript
// doctest: skip — requires real PostgreSQL connection
import { createHookManager, createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const hooks = createHookManager()
  .afterMutation((ctx, results) => {
    if (!ctx.inTransaction) {
      // Only emit metrics for committed (non-transactional) mutations.
      metrics.increment(`mutation.${ctx.operation}`);
    }
    return results;
  });

const orm = createOrm({ schema: db, adapter: createPgsqlAdapter(pool), hooks });
```

ORM-level `beforeQuery` / `afterQuery` hooks also fire per-statement inside the transaction. If you need post-commit semantics (e.g. publishing an event only after the transaction succeeds), do that after `await orm.transaction(...)` returns.

---

## Compile-only mode

`orm.transaction()` **requires a real adapter**. Calling it with `createPgsqlCompileOnlyAdapter()` throws:

```
Error: transaction() requires an adapter. Pass an adapter when creating the ORM.
```

Use `.dump()` on the individual builders inside your transaction callback when you need to inspect SQL without executing.

---

## Common pitfalls

### Forgetting to use `tx`

The most common mistake. If you query through `orm` inside the callback, those queries run outside the transaction:

```typescript
// doctest: skip — illustrates the wrong pattern
await orm.transaction(async (tx) => {
  await orm.insert('events').values({ type: 'x' }).execute(); // ← wrong: uses outer orm
  await tx.insert('events').values({ type: 'y' }).execute();  // ← correct: uses tx
});
```

### Not awaiting inside the callback

Forgetting `await` on an async operation causes the callback to return before the query completes, so the transaction commits before the statement finishes:

```typescript
// doctest: skip — illustrates the wrong pattern
await orm.transaction(async (tx) => {
  tx.insert('events').values({ type: 'x' }).execute(); // ← missing await: races with commit
});
```

### Async work escaping the callback

Passing the `tx` reference to an external function that stores it and uses it later is unsafe — after the callback returns the connection is returned to the pool:

```typescript
// doctest: skip — illustrates the wrong pattern
let storedTx: typeof tx;
await orm.transaction(async (tx) => {
  storedTx = tx; // ← never do this
});
await storedTx.select('users').all(); // ← undefined behavior: connection released
```

---

## See also

- [Mutations](./mutations) — insert, update, delete, upsert builders
- [Locking](./locking) — FOR UPDATE / SKIP LOCKED inside transactions
- [Observability](./observability) — dump(), hooks, and correlation IDs
