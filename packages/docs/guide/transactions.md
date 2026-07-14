---
title: Transactions
description: What orm.transaction() guarantees, what it refuses, and what it cannot promise.
---

# Transactions

By default every `orm.select('users')` read and every executed mutation builder (`orm.into(...)`, `orm.modify(...)`, `orm.removeFrom(...)`, `orm.upsertInto(...)`) runs as its own auto-committed statement on a pooled connection. `orm.transaction()` puts a group of them behind one boundary: they commit together, or none of them does.

```typescript
// doctest: real-db-only — requires a live PostgreSQL connection
import { eq } from '@dbsp/core';

const adaId = crypto.randomUUID();
const graceId = crypto.randomUUID();
await orm
  .into(orm.tables.users)
  .values([
    {
      id: adaId,
      name: 'Ada',
      email: 'ada@example.com',
      createdAt: new Date(),
      active: true,
    },
    {
      id: graceId,
      name: 'Grace',
      email: 'grace@example.com',
      createdAt: new Date(),
      active: false,
    },
  ])
  .execute();

const result = await orm.transaction(async (tx) => {
  // Use `tx`, never the outer `orm`, for anything that must be inside.
  const { users } = tx.tables;
  await tx
    .modify(users)
    .set({ active: false })
    .where(eq(users.id, adaId))
    .execute();
  await tx
    .modify(users)
    .set({ active: true })
    .where(eq(users.id, graceId))
    .execute();
  return { updated: 2 };
});

if (result.updated !== 2) {
  throw new Error('both updates should commit together');
}
```

The callback receives `tx`, an ORM instance bound to the connection the transaction is running on. Its return value becomes the resolved value of `orm.transaction()`.

## What it guarantees

- The callback's work commits together, or not at all.
- **A statement issued inside the transaction never executes after the boundary** — not even one you forgot to `await`. It is drained before the commit, or refused.
- A nested `transaction()` is a real savepoint. If you await it, you can catch its failure without losing the parent's work.
- **A nested `transaction()` must be awaited** before the parent callback returns.
- The connection never returns to the pool with a transaction still open on it.
- dbsp never reports success when nothing committed. PostgreSQL answers `COMMIT` on a broken transaction with the command tag `ROLLBACK`, and dbsp checks.

## Errors, and the one thing that surprises people

Usually, a `throw` inside the callback rolls the transaction back and re-throws the same error. You never call rollback yourself. The important exception is cleanup: raw transaction control such as an unawaited `tx.raw('COMMIT')`, or a rollback/release failure while dbsp is closing the scope, can surface over the callback error. In that case the callback error is retained as the surfaced error's `cause`.

But **catching a database error *inside* the callback does not give you a usable transaction back.**

```typescript
// doctest: real-db-only — requires a live PostgreSQL connection
const existingId = crypto.randomUUID();
await orm
  .into(orm.tables.users)
  .values({
    id: existingId,
    name: 'Ada',
    email: 'ada@example.com',
    createdAt: new Date(),
    active: true,
  })
  .execute();

let refused = false;
try {
  await orm.transaction(async (tx) => {
    const { users } = tx.tables;
    try {
      await tx
        .into(users)
        .values({
          id: existingId,
          name: 'Ada again',
          email: 'ada2@example.com',
          createdAt: new Date(),
          active: true,
        })
        .execute();
    } catch {
      // Swallowing the error does NOT put the transaction back in a usable state.
    }

    // This statement is refused. The transaction was aborted by the failure above.
    await tx
      .into(users)
      .values({
        id: crypto.randomUUID(),
        name: 'Grace',
        email: 'grace@example.com',
        createdAt: new Date(),
        active: true,
      })
      .execute();
  });
} catch (error) {
  if (error instanceof Error && error.name === 'PgsqlTransactionAbortedError') {
    refused = true;
  }
}

if (!refused) {
  throw new Error('the aborted transaction should refuse the second insert');
}
```

This is PostgreSQL's own semantics, not a dbsp choice: **a failed statement aborts the whole transaction**, and every statement after it is rejected until the transaction ends. dbsp does not savepoint each statement behind your back, so it cannot hide this from you — and it will not pretend otherwise. It refuses the next statement rather than let it run outside the transaction you believe you are still in.

That paragraph is not a claim you have to take on trust. It is a test. CI runs it against a real PostgreSQL on every pull request that touches these docs, and it fails if the transaction ever accepts that second statement:

```typescript
// doctest: real-db-only — this proves the paragraph above
function errorProperty(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function assertPgCode(error: unknown, code: string, label: string): void {
  if (errorProperty(error, 'code') !== code) {
    throw new Error(`${label} failed for the wrong reason`);
  }
}

function assertTransactionAborted(error: unknown, label: string): void {
  if (
    !(error instanceof Error) ||
    error.name !== 'PgsqlTransactionAbortedError' ||
    errorProperty(error, 'dbspTransactionAborted') !== true
  ) {
    throw new Error(`${label} was not dbsp's aborted-transaction refusal`);
  }
}

const existing = crypto.randomUUID();
await orm
  .into(orm.tables.users)
  .values({
    id: existing,
    name: 'Ada',
    email: 'ada@example.com',
    createdAt: new Date(),
    active: true,
  })
  .execute();

let duplicateKeyError: unknown;
let refusedStatementError: unknown;
let transactionError: unknown;

try {
  await orm.transaction(async (tx) => {
    try {
      // Duplicate primary key. PostgreSQL aborts the transaction right here.
      await tx
        .into(tx.tables.users)
        .values({
          id: existing,
          name: 'Ada again',
          email: 'ada2@example.com',
          createdAt: new Date(),
          active: true,
        })
        .execute();
    } catch (error) {
      // Caught. And the transaction is still aborted — catching did not heal it.
      duplicateKeyError = error;
    }
    assertPgCode(duplicateKeyError, '23505', 'the duplicate insert');

    try {
      await tx
        .into(tx.tables.users)
        .values({
          id: crypto.randomUUID(),
          name: 'Grace',
          email: 'grace@example.com',
          createdAt: new Date(),
          active: true,
        })
        .execute();
    } catch (error) {
      refusedStatementError = error;
    }
    assertTransactionAborted(refusedStatementError, 'the second insert');
    if (errorProperty(refusedStatementError, 'cause') !== duplicateKeyError) {
      throw new Error('the refusal did not point back to the swallowed statement failure');
    }
  });

  throw new Error('the transaction unexpectedly committed');
} catch (error) {
  transactionError = error;
}

assertTransactionAborted(transactionError, 'transaction()');
if (errorProperty(transactionError, 'cause') !== duplicateKeyError) {
  throw new Error('transaction() rejected for the wrong reason');
}
```

If you genuinely need to carry on past a statement that may fail, isolate it in a nested `transaction()` — that *is* a savepoint, and the section below shows how.

## Nested transactions are savepoints

A `transaction()` inside a `transaction()` is a real `SAVEPOINT`, so a failure inside it can be caught and survived without losing the parent's work:

```typescript
// doctest: real-db-only — requires a live PostgreSQL connection
import { inArray } from '@dbsp/core';

const orderId = crypto.randomUUID();
const extraId = crypto.randomUUID();
const auditId = crypto.randomUUID();

await orm.transaction(async (tx) => {
  const { users } = tx.tables;
  await tx
    .into(users)
    .values({
      id: orderId,
      name: 'Order owner',
      email: 'order@example.com',
      createdAt: new Date(),
      active: true,
    })
    .execute();

  try {
    await tx.transaction(async (nested) => {
      await nested
        .into(nested.tables.users)
        .values({
          id: extraId,
          name: 'Optional extra',
          email: 'extra@example.com',
          createdAt: new Date(),
          active: true,
        })
        .execute();
      throw new Error('extras unavailable');
    });
  } catch {
    // The savepoint rolled back. The order above is still there,
    // and the transaction is still usable.
  }

  await tx
    .into(users)
    .values({
      id: auditId,
      name: 'Audit row',
      email: 'audit@example.com',
      createdAt: new Date(),
      active: true,
    })
    .execute();
}); // commits the outer rows, without the nested row

const rows = await orm
  .select('users')
  .where(inArray('id', [orderId, extraId, auditId]))
  .all();
if (rows.length !== 2 || rows.some((row) => row.id === extraId)) {
  throw new Error('the nested insert should have rolled back to its savepoint');
}
```

The savepoint's name is unguessable by design — see [Raw SQL](./raw-sql) for why that matters.

**A nested `transaction()` must be awaited.** dbsp refuses an unobserved child before the parent commits, even if the child already succeeded. A forgotten `await` cannot leave dbsp guessing whether a savepoint scope was part of the work you meant to commit.

::: warning Nested transactions changed in 3.0.0
Before 3.0.0 a nested `transaction()` did nothing at all — it simply ran your callback on the parent's connection, with no savepoint. So a failure inside it aborted the **whole** transaction, and the pattern above could not work: there was nothing to roll back *to*. It is a real savepoint now, which means a sub-block can fail and be survived. Code that relied on a nested transaction being flat will find it is no longer flat.
:::

## Who owns the connection

`orm.transaction()` runs a transaction on the connection, which means it has to be dbsp's to run one on.

```typescript
// doctest: real-db-only — requires a live PostgreSQL connection
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

// dbsp owns the pool: it checks out a connection, and transaction() works.
const owned = createOrm({ schema: db, adapter: createPgsqlAdapter(pool) });
await owned.transaction(async (tx) => {
  await tx.raw('SELECT 1');
});

// You own the client: dbsp is a guest on it.
const client = await pool.connect();
try {
  const guest = createOrm({
    schema: db,
    adapter: createPgsqlAdapter(client, { borrowedClient: true }),
  });
  let refusedBorrowedTransaction = false;
  try {
    await guest.transaction(async () => {});
  } catch {
    // Expected: the connection is not dbsp's.
    refusedBorrowedTransaction = true;
  }
  if (!refusedBorrowedTransaction) {
    throw new Error('borrowed clients must opt in to managed transactions');
  }

  // Unless you say otherwise:
  const delegated = createOrm({
    schema: db,
    adapter: createPgsqlAdapter(client, {
      borrowedClient: true,
      managedTransactions: true, // "run transactions on my client"
    }),
  });
  await delegated.transaction(async (tx) => {
    await tx.raw('SELECT 1');
  });
} finally {
  client.release();
}
```

The declaration is the point. dbsp does not inspect the object you handed it and guess whether it may open a transaction on it — a checked-out client belongs to whoever checked it out, and dbsp refuses rather than assume. On a borrowed client it also savepoints the statements *it* issues, so a dbsp failure does not poison a transaction that is yours.

## What it cannot promise

**Raw SQL that ends the transaction ends it.** `tx.raw('COMMIT')` commits — right then, before dbsp can learn what the statement was. dbsp reports it loudly and kills the scope so nothing after it escapes, but it cannot un-run it: **`transaction()` rejecting is not proof that nothing was committed.** The same goes for raw `ROLLBACK` and `PREPARE TRANSACTION`, which also end the transaction.

**Raw savepoint control is a different hazard.** `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` do *not* end the transaction — they rearrange its savepoint stack, which is the stack dbsp is using to keep your nested transactions isolated. `RELEASE SAVEPOINT a` destroys every savepoint established after it, so a raw release can quietly delete the savepoint a nested `transaction()` is relying on. `ROLLBACK TO SAVEPOINT a` keeps the transaction open, but discards every change made after that savepoint and destroys later savepoints. The containment you thought you had can be gone, and so can work you already issued.

Neither is an oversight — it is what an escape hatch is. [Raw SQL](./raw-sql) covers both in full, along with effects outside the normal rollback boundary: advanced sequences, session-level advisory locks, prepared statements, and temp tables created outside the rolled-back transaction.

## Use `tx`, not `orm`

Inside the callback, the outer `orm` is a different connection. Statements sent through it are not in your transaction and will not see its uncommitted work:

```typescript
// doctest: skip — illustrates the wrong pattern
import { eq } from '@dbsp/core';

await orm.transaction(async (tx) => {
  const id = crypto.randomUUID();
  await tx
    .into(tx.tables.users)
    .values({
      id,
      name: 'Uncommitted user',
      email: 'uncommitted@example.com',
      createdAt: new Date(),
      active: true,
    })
    .execute();

  // WRONG — different connection, cannot see the insert
  await orm.select('users').where(eq('id', id)).all();
  await tx.select('users').where(eq('id', id)).all(); // right
});
```

`tx` carries everything the outer `orm` was configured with — schema, hooks, `withSchema()` scoping, default filters. The connection is the only thing that changes.

## Hooks

Hooks fire inside transactions. `QueryHookContext` and `MutationHookContext` both carry `inTransaction?: boolean`; inside `transaction()` it is `true`, and outside a transaction the property is omitted. A hook can still tell the difference — useful when an effect should only happen once the work is actually committed:

```typescript
// doctest: real-db-only — verifies hooks can see transaction scope
const { createHookManager } = await import('@dbsp/core');

const seenScopes: Array<boolean | undefined> = [];
const hooks = createHookManager().afterMutation((ctx, results) => {
  seenScopes.push(ctx.inTransaction);
  return results;
});

const hookedOrm = createOrm({ schema: db, adapter, hooks });

await hookedOrm.transaction(async (tx) => {
  await tx
    .into(tx.tables.users)
    .values({
      id: crypto.randomUUID(),
      name: 'Inside transaction',
      email: 'inside@example.com',
      createdAt: new Date(),
      active: true,
    })
    .execute();
});

await hookedOrm
  .into(hookedOrm.tables.users)
  .values({
    id: crypto.randomUUID(),
    name: 'Outside transaction',
    email: 'outside@example.com',
    createdAt: new Date(),
    active: true,
  })
  .execute();

if (seenScopes[0] !== true || seenScopes[1] !== undefined) {
  throw new Error('mutation hooks should distinguish transaction scope');
}
```

For anything that must happen only after a successful commit — publishing an event, sending a mail — do it after `await orm.transaction(...)` returns. A hook cannot know whether the commit will succeed.

## Compile-only mode

`createPgsqlCompileOnlyAdapter()` is an adapter, but it declares `capabilities.supportsTransactions: false`. Calling `orm.transaction()` with it rejects with `ExecutionError`:

```
Cannot execute transaction(): The adapter does not declare capabilities.supportsTransactions: true for this ORM instance.

To fix: Use an adapter that implements transaction() and withSchema(), and declare adapter.capabilities.supportsTransactions: true.
```

To inspect the SQL of the statements a transaction would run, call `.dump()` on the individual builders.

## See also

- [Raw SQL](./raw-sql) — the escape hatch, and exactly what it costs
- [Mutations](./mutations) — insert, update, delete, upsert
- [Locking](./locking) — `FOR UPDATE` / `SKIP LOCKED` inside a transaction
- [Observability](./observability) — `dump()`, hooks, correlation IDs
