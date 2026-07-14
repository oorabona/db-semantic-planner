# How to use raw SQL safely

## When

You reach for `orm.raw()` / `adapter.executeRaw()` because dbsp cannot express something. That is what it is for. This guide is about the places raw SQL and dbsp genuinely collide: **inside a transaction dbsp is managing**, and anywhere raw SQL leaves session state on a pooled PostgreSQL connection.

## The short version

| | |
|---|---|
| Raw SQL **outside** a dbsp transaction | It is your statement on a pooled connection. Data changes are just PostgreSQL, but committed session changes can affect the next borrower: a plain `SET`, a committed `LISTEN`, prepared statements, temp tables, and session-level advisory locks. Sequence advances are not reclaimed by rollback. |
| Raw SQL **inside** `orm.transaction()` | Read the rest of this page. |
| Raw SQL inside **your own** transaction, on a borrowed client | dbsp savepoints statements **it** issues so dbsp failures do not poison your transaction. Your raw transaction-control SQL is no safer here: `COMMIT` still commits, `ROLLBACK` still rolls back, and savepoint control still changes your savepoint stack. |

## What dbsp guarantees inside a transaction it manages

- The callback's work commits together, or not at all.
- A statement issued inside the transaction **never executes after the boundary** — not even one you forgot to `await`.
- A nested `transaction()` is a real savepoint, and if you await it you can catch its failure without losing the parent's work.
- A nested `transaction()` **must be awaited** before the parent callback returns.
- The connection never returns to the pool with a transaction still open on it.
- dbsp never reports success when nothing committed: PostgreSQL answers `COMMIT` on a broken transaction with the tag `ROLLBACK`, and dbsp checks.

## What it cannot guarantee

**Raw SQL that ends the transaction ends it.**

```ts
// doctest: skip — this demonstrates the hazard. Running it would commit.
await orm.transaction(async (tx) => {
  await tx.into(tx.tables.users).values({ id: idA, name: 'Ada' }).execute();
  await tx.raw('COMMIT');                       // ← this commits. Right now.
  await tx.into(tx.tables.users).values({ id: idB, name: 'Grace' }).execute();
});                                             // throws — but Ada is committed
```

PostgreSQL reports what a statement *was* only **after it has run**. So dbsp learns about your `COMMIT` when it is already done. What it does then is everything it still can: it kills the scope, so nothing after it escapes into a transaction that no longer exists, and it throws loudly.

What it cannot do is un-run your statement. **`transaction()` rejecting does not mean nothing was committed.**

The same is true of several commands in one call — `tx.raw('COMMIT; INSERT …')` — and of `PREPARE TRANSACTION`, and of raw savepoint control (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`), which can rearrange the savepoint stack or discard work done since a savepoint before dbsp sees the tag.

**And raw SQL can leave effects outside the rollback boundary.** These survive a rollback: a sequence advanced by `nextval`, a session-level advisory lock such as `pg_advisory_lock`, a prepared statement created with `PREPARE`, and a temp table created outside the transaction being rolled back. A transaction-level advisory lock such as `pg_advisory_xact_lock` is released when the transaction ends.

Do not put `SET` or `LISTEN` in that bucket. A plain `SET` inside a transaction is undone by `ROLLBACK`; both `SET` and `SET LOCAL` are canceled by `ROLLBACK TO SAVEPOINT` when the savepoint predates the command, and `SET LOCAL` never persists past transaction end. A committed plain `SET` still persists on the pooled connection, and `LISTEN` changes the session's registrations only when its transaction commits. dbsp cleans up only what dbsp created.

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
  const scopedOrm = createOrm({
    schema: db,
    adapter: createPgsqlAdapter(client, { borrowedClient: true }),
  });
  await scopedOrm
    .into(scopedOrm.tables.users)
    .values({
      id: crypto.randomUUID(),
      name: 'Ada',
      email: 'ada@example.com',
      createdAt: new Date(),
      active: true,
    })
    .execute();
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
