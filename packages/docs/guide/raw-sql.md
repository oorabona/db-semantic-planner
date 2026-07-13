# How to use raw SQL safely

## When

You reach for `orm.raw()` / `adapter.executeRaw()` because dbsp cannot express something. That is what it is for. This guide is about the places raw SQL and dbsp genuinely collide: **inside a transaction dbsp is managing**, and anywhere raw SQL leaves session state on a pooled PostgreSQL connection.

## The short version

| | |
|---|---|
| Raw SQL **outside** a dbsp transaction | It is your statement on a pooled connection. Data changes are just PostgreSQL, but session state you create — `SET`, `LISTEN`, prepared statements, temp tables, session advisory locks — can outlive the call and affect the next borrower. |
| Raw SQL **inside** `orm.transaction()` | Read the rest of this page. |
| Raw SQL inside **your own** transaction, on a borrowed client | dbsp savepoints statements **it** issues so dbsp failures do not poison your transaction. Your raw transaction-control SQL is no safer here: `COMMIT` still commits, `ROLLBACK` still rolls back, and savepoint control still changes your savepoint stack. |

## What dbsp guarantees inside a transaction it manages

- The callback's work commits together, or not at all.
- A statement issued inside the transaction **never executes after the boundary** — not even one you forgot to `await`.
- A nested `transaction()` is a real savepoint, and if it fails it does not take the parent's work with it.
- A nested transaction that fails **fails its parent**, even if you did not `await` it.
- The connection never returns to the pool with a transaction still open on it.
- dbsp never reports success when nothing committed: PostgreSQL answers `COMMIT` on a broken transaction with the tag `ROLLBACK`, and dbsp checks.

## What it cannot guarantee

**Raw SQL that ends the transaction ends it.**

```ts
// doctest: skip — this demonstrates the hazard. Running it would commit.
await orm.transaction(async (tx) => {
  await tx.into(tx.tables.orders).values({ id: 1 }).execute();
  await tx.raw('COMMIT');                       // ← this commits. Right now.
  await tx.into(tx.tables.orders).values({ id: 2 }).execute();
});                                             // throws — but order 1 is committed
```

PostgreSQL reports what a statement *was* only **after it has run**. So dbsp learns about your `COMMIT` when it is already done. What it does then is everything it still can: it kills the scope, so nothing after it escapes into a transaction that no longer exists, and it throws loudly.

What it cannot do is un-run your statement. **`transaction()` rejecting does not mean nothing was committed.**

The same is true of several commands in one call — `tx.raw('COMMIT; INSERT …')` — and of `PREPARE TRANSACTION`, and of raw savepoint control (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`), which can rearrange the savepoint stack under dbsp's feet before dbsp sees the tag.

**And raw SQL makes session state that no rollback undoes.** A sequence that advanced stays advanced. An advisory lock stays held. A `PREPARE`, a `SET` (not `SET LOCAL`), a `LISTEN`, a temp table — all of them ride the connection back into the pool, and the next caller inherits them. dbsp cleans up only what dbsp created.

This is not an oversight. It is what an escape hatch *is*, and the alternative — parsing your SQL to decide what it will do — is exactly the guessing this adapter was rewritten to remove. See [#327](https://github.com/oorabona/db-semantic-planner/issues/327).

## Do this instead

If you need transaction control, **own the transaction**:

```ts
// doctest: real-db-only — checks out a real client and owns a real transaction
const client = await pool.connect();
let committed = false;
try {
  await client.query('BEGIN');

  // dbsp works inside YOUR transaction, and savepoints statements it
  // issues so a failure of its own does not poison it.
  const orm = createOrm({
    schema: db,
    adapter: createPgsqlAdapter(client, { borrowedClient: true }),
  });
  await orm.into(orm.tables.orders).values({ id: 1 }).execute();
  await client.query('SAVEPOINT my_own');       // yours to manage

  await client.query('COMMIT');
  committed = true;
} finally {
  // The transaction is yours, so ending it is yours too. Release a client while
  // a transaction is still open on it and the next borrower inherits it — which
  // is the whole hazard this page is about. `finally` alone does not save you.
  if (!committed) {
    await client.query('ROLLBACK').catch(() => undefined);
  }
  client.release();
}
```

Note the missing `managedTransactions: true`. Without it, `orm.transaction()` **throws** rather than running a transaction on a connection that is not dbsp's — which is the point. The connection is yours, so the transaction is yours, and dbsp says so instead of guessing.

This does not make raw transaction control safe through dbsp. If you call `orm.raw('COMMIT')` on that borrowed client, PostgreSQL commits your transaction; dbsp can report what happened, but it cannot undo it. Send transaction-control commands through the client you own, where that control is explicit.

## Gotchas

- **Raw SQL outside a dbsp transaction still runs on a pooled session.** Avoid session-level changes unless you also reset them, or use a client whose lifetime you control.
- **`transaction()` rejecting is not proof nothing committed** — if the callback used raw transaction control, read the error. `PgsqlRawSqlTransactionControlError` means exactly this happened.
- **Catch an error inside `orm.transaction()` and the transaction stays poisoned.** dbsp does not savepoint each statement, so a failed statement aborts the transaction, as PostgreSQL intends. Swallowing the error does not give you a usable transaction back; it gives you a poisoned one, and dbsp will refuse the next statement rather than let it run outside the transaction you think you are in.
- **On a borrowed client that is inside *your* transaction, dbsp does savepoint its own statements** — because breaking a transaction that belongs to you is not dbsp's right.

## Key files

- `packages/adapter-pgsql/src/pgsql-adapter.ts` — the scope registry, the transaction contract, `PgsqlRawSqlTransactionControlError`
- `tests/e2e/raw-sql-transaction-savepoint.test.ts` — the guarantees above, against a real PostgreSQL
- `tests/e2e/borrowed-client-ownership.test.ts` — who owns the connection, and what follows from that
