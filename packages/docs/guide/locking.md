---
title: Row-Level Locking
description: Pessimistic concurrency control with FOR UPDATE, FOR SHARE, SKIP LOCKED, and NOWAIT in @dbsp/core.
---

# Row-Level Locking

Row-level locks let you claim exclusive or shared access to specific rows for the duration of a transaction. They are the right tool for pessimistic concurrency — state machines, queue workers, balance transfers, and "first one wins" reservation systems — where you cannot afford to retry on a conflict.

## Why this matters

The common misconception is "I'll use an optimistic lock with a version column." Optimistic locking is fine for low-contention writes, but under high contention it degrades to a retry storm. Pessimistic locking with `FOR UPDATE` eliminates the retry loop by serializing access at the database level. It only works correctly inside a transaction — the lock is held until the transaction commits or rolls back.

---

## The four lock strengths

All four are defined in `packages/core/src/dx/query-builder-types.ts:372-381`.

| Method | SQL | Conflicts with | Use when |
|--------|-----|----------------|----------|
| `.forUpdate()` | `FOR UPDATE` | UPDATE, DELETE, FOR NO KEY UPDATE, other FOR UPDATE | You will write to the locked row |
| `.forNoKeyUpdate()` | `FOR NO KEY UPDATE` | FOR UPDATE, FOR NO KEY UPDATE | You will update non-FK columns only |
| `.forShare()` | `FOR SHARE` | FOR UPDATE, FOR NO KEY UPDATE | You are reading data another writer must not change |
| `.forKeyShare()` | `FOR KEY SHARE` | FOR UPDATE | You are referencing a FK and need the PK row to remain stable |

Use `.forUpdate()` as the default for write-intent locks. The others are finer-grained and reduce deadlock probability in scenarios with many concurrent readers.

---

## Wait policies

After a lock method, chain a wait policy. Without one, the default is to block until the lock is available.

| Method | SQL | Behavior |
|--------|-----|----------|
| `.skipLocked()` | `SKIP LOCKED` | Skip rows locked by other transactions — returns only unlocked rows |
| `.noWait()` | `NOWAIT` | Fail immediately if any selected row is already locked |

Source: `packages/core/src/dx/query-builder-types.ts:401` (skipLocked) and `:410` (noWait).

Both methods must be called after a lock method. Calling them without a preceding lock method compiles to invalid SQL.

---

## Pattern: queue worker (FOR UPDATE SKIP LOCKED)

The canonical job queue pattern: claim the next pending job without blocking other workers:

```typescript
// doctest: skip — requires real PostgreSQL connection and transaction
import { eq } from '@dbsp/core';

const job = await orm.transaction(async (tx) => {
  const claimed = await tx.select('jobs')
    .where(eq('status', 'pending'))
    .orderBy('createdAt', 'asc')
    .limit(1)
    .forUpdate()
    .skipLocked()
    .first();

  if (!claimed) return null;

  await tx.update('jobs')
    .set({ status: 'processing', claimedAt: new Date() })
    .where(eq('id', claimed.id))
    .execute();

  return claimed;
});
```

`SKIP LOCKED` means each worker sees a different row — workers never block each other. Without it, all workers would queue on the same row, serializing throughput.

---

## Pattern: balance transfer (deterministic lock ordering)

Lock both accounts before transferring funds. Always lock in a **deterministic order** (by ID ascending) to prevent deadlocks when two concurrent transfers involve the same pair of accounts in reverse order:

```typescript
// doctest: skip — requires real PostgreSQL connection and transaction
import { inArray, eq } from '@dbsp/core';

const fromId = 1;
const toId = 2;
const [lowerId, higherId] = [fromId, toId].sort((a, b) => a - b);

await orm.transaction(async (tx) => {
  // Lock both rows in ascending ID order to avoid deadlock
  const [lower, higher] = await tx.select('accounts')
    .where(inArray('id', [lowerId, higherId]))
    .orderBy('id', 'asc')
    .forUpdate()
    .all();

  const from = lower.id === fromId ? lower : higher;
  const to   = lower.id === toId   ? lower : higher;

  if (from.balance < 100) throw new Error('Insufficient funds');

  await tx.update('accounts').set({ balance: from.balance - 100 }).where(eq('id', from.id)).execute();
  await tx.update('accounts').set({ balance: to.balance + 100 }).where(eq('id', to.id)).execute();
});
```

---

## Pattern: fail-fast with NOWAIT

When you want to fail immediately instead of blocking — for example in an interactive request where waiting would time out the user — use `.noWait()`:

```typescript
// doctest: skip — requires real PostgreSQL connection and transaction
import { eq } from '@dbsp/core';

try {
  await orm.transaction(async (tx) => {
    const record = await tx.select('documents')
      .where(eq('id', docId))
      .forUpdate()
      .noWait()
      .first();

    if (!record) throw new Error('Document not found');
    // ... proceed with update
  });
} catch (err) {
  if (err.message.includes('could not obtain lock')) {
    // Another session holds the lock — inform the user to retry
    return { conflict: true };
  }
  throw err;
}
```

---

## Optimistic vs pessimistic: quick decision

| Signal | Choose |
|--------|--------|
| Low contention, acceptable retries | Optimistic (version column + conditional UPDATE) |
| Queue / worker pattern | Pessimistic `FOR UPDATE SKIP LOCKED` |
| State machine with competing writers | Pessimistic `FOR UPDATE` |
| High read concurrency, rare write | `FOR SHARE` (allows parallel reads, blocks writes) |
| Interactive request, must not block | `FOR UPDATE NOWAIT` + handle lock error |

---

## Common pitfalls

### Locks only work inside transactions

A lock acquired outside a transaction is released immediately after the statement completes. Always use locking inside `orm.transaction()`:

```typescript
// doctest: skip — illustrates the wrong pattern
// WRONG: lock released as soon as the SELECT completes
const row = await orm.select('jobs').forUpdate().first();

// CORRECT: lock held until transaction commits
await orm.transaction(async (tx) => {
  const row = await tx.select('jobs').forUpdate().first();
  // ... update row before transaction ends
});
```

### Deadlock avoidance

Two transactions can deadlock if they each hold a lock the other wants. Rules to avoid it:
1. Always acquire locks on multiple rows in the same order (e.g. ascending primary key).
2. Keep transactions short — acquire locks as late as possible, release as early as possible.
3. Prefer `SKIP LOCKED` over blocking when the order of processing does not matter.

### Do not FOR UPDATE on JOIN targets

Applying `FOR UPDATE` to a query that joins another table locks rows in *both* tables. Use the `OF table` clause (via [Expression Primitives](./expression-primitives)) if you need to lock only specific tables in a join.

### Locks and set operations

Lock clauses cannot be combined with set operations (`UNION`, `INTERSECT`, `EXCEPT`) at the SQL level — PostgreSQL rejects the combination. Apply locks in individual queries before combining results, or restructure the query to avoid set operations at the locked level.

---

## See also

- [Transactions](./transactions) — required wrapper for all locking patterns
- [Queries](./queries) — base query builder reference
- [Expression Primitives](./expression-primitives) — for advanced lock targeting (`OF table`)
