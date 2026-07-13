# ADR 0002: Recovery Primitives Are an Engine Property, Not an Assumption

Status: canonical

## Context

dbsp describes a **desired schema** and works out how to reach it: introspect the
database, diff it against the model, emit the statements that close the gap. That is
the declarative, Terraform-shaped model, and dbsp already runs it both ways — `push`
converges directly, `migrate` writes a reviewable versioned migration instead.

Two of the mechanisms that make it work on PostgreSQL are not general SQL. They are
**PostgreSQL recovery primitives**, and this project has now twice designed against
the assumption that they are universal.

**Canonicalising a CHECK expression.** The model holds what the author wrote;
PostgreSQL returns what its deparser re-printed. They never match, so the diff
reports drift forever. The fix is to ask PostgreSQL for its own rendering: create a
temp table shaped from the desired model inside a transaction, add the constraint,
read back `pg_get_constraintdef()`, and roll the whole thing back. It relies on
**DDL being transactional**.

**Executing raw SQL on a borrowed connection.** A caller can hand dbsp a client
inside a transaction they own. Some statements are forbidden inside a transaction
block, and one of them reaching PostgreSQL aborts the caller's entire transaction.
Enumerating them with a regex is fail-open by construction — comments, non-leading
statements, and every command nobody thought of get through. The fix is to stop
enumerating: wrap the statement in a `SAVEPOINT`, let PostgreSQL refuse it, roll back
to the savepoint so the caller's transaction survives, and surface PostgreSQL's own
error. It relies on **savepoint containment**.

Both follow the same discipline, which is the right one: *ask the engine, do not
enumerate what it forbids.* This project deliberately refuses to parse SQL — no
parser, no WASM, no hand-rolled grammar — so the engine is the only authority
available.

What is **not** portable is the primitive each trick rests on.

## Decision

**A recovery primitive is a capability an adapter declares, not a property of SQL.**
The *pattern* — ask the engine rather than enumerate — generalises. The *mechanism*
does not, and no adapter may inherit PostgreSQL's by default.

The precise property the savepoint guard depends on is **savepoint containment for
the statement**:

- no implicit commit,
- no whole-transaction rollback,
- no non-rollbackable side effect,
- no session-state escape that survives `ROLLBACK TO SAVEPOINT`.

"Requires transactional DDL" describes the scratch-table trick, but it is too narrow
for this one. Savepoint containment is the sharper boundary, and it is what an
adapter must be able to answer for.

## Consequences per engine

### PostgreSQL — has both, mostly

Transactional DDL, and forbidden-in-transaction statements are refused *before* any
side effect, so a savepoint recovers cleanly.

The *mostly* has to be documented rather than assumed. Some effects are not
transactional and survive a savepoint rollback: sequence advancement (`nextval`,
`setval`), session-level advisory locks. And `RELEASE SAVEPOINT` **does not commit** —
it merges the work into the surrounding transaction, so work dbsp "succeeded" at on a
borrowed connection is still undone if the caller later rolls back. Nothing in dbsp
may describe that as atomic, because it is not.

### SQLite — partial, and not a completeness proof

Savepoints exist, and a normal statement error does not abort a SQLite transaction the
way it does in PostgreSQL. But savepoint containment does not hold:

- `ON CONFLICT ROLLBACK`, `INSERT OR ROLLBACK`, and a trigger's `RAISE(ROLLBACK, …)`
  roll back the **whole** transaction. A nested savepoint does not contain that — after
  the rollback the savepoint is gone.
- Severe errors (`SQLITE_FULL`, `SQLITE_IOERR`, `SQLITE_NOMEM`, `SQLITE_BUSY`,
  `SQLITE_INTERRUPT`) may or may not roll back; the only reliable answer is asking the
  connection (`sqlite3_txn_state()`).

So savepoints buy statement-level atomicity in SQLite, and nothing stronger. They are
not a substitute for knowing.

Separately: SQLite still needs the 12-step table rebuild for changing a column's type
or adding and removing constraints, even though modern versions have `RENAME`,
`RENAME COLUMN`, `ADD COLUMN`, `DROP COLUMN`, and (3.53+) `ALTER COLUMN … SET/DROP NOT NULL`.

### MySQL — has neither

**DDL causes an implicit commit**, and the list is broader than DDL: account
management, transaction control, locking, administrative and replication statements,
some data-loading. Many commit *both before and after* execution. And a commit
**destroys every savepoint**, so `SAVEPOINT sp; CREATE INDEX …; ROLLBACK TO sp` is not
protection — the caller's work was already committed before the statement ran.

The hazard is a different one, and worse. On PostgreSQL it is *"the statement is
refused and takes your transaction down with it"* — unpleasant, and recoverable. On
MySQL it is *"the statement silently commits your uncommitted work"* — not recoverable,
and not even an error.

That calls for a guard of the opposite kind: a **refusal before executing**, not a
recovery afterwards. And "refuse DDL" is too narrow to be that guard.

There is no escape hatch: XA transactions do forbid implicit-commit statements, but a
borrowed local transaction cannot be wrapped into XA after the fact. There is no API to
ask MySQL whether a statement *would* implicitly commit without running it.

So on MySQL, a borrowed connection inside a caller's transaction must **refuse raw SQL
entirely**, or accept only a narrow, API-level class of known DML. Blunt, complete, and
it never commits someone else's data by accident.

## Consequences for the declarative model

The same asymmetry limits the Terraform-shaped model itself.

A state diff **cannot recover intent**. A rename and a drop-plus-add produce identical
end states with opposite consequences for data. Backfills and column splits are not
derivable at all. And a diff can produce a plan that is correct and **not executable** —
dbsp hit this with an enum: PostgreSQL will not let a migration use a value that the same
transaction added, so the honest answer was to refuse and hand the problem back.

That is the model reaching its limit, not a bug. It is why **versioned migrations are the
supported production path** and `push` is a development convenience: the diff should
*author* a reviewable artefact, and the un-derivable parts become a draft a human
corrects once.

## Rules that follow

1. An adapter **declares** its recovery primitives. It does not inherit PostgreSQL's.
2. A guard that enumerates what an engine forbids is fail-open and will always be one
   spelling behind. Ask the engine.
3. When the engine cannot be asked safely — MySQL's implicit commit — **refuse**. Do not
   guess, and do not proceed.
4. Never describe as atomic something that a caller's rollback can undo.
5. Before porting any mechanism that relies on undoing work, state which primitive it
   needs and check the target engine has it.
