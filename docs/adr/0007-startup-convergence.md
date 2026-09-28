# ADR 0007: Startup Convergence

## Status

Accepted (2026-09-28). It records the decisions taken on #769 (issuecomment-5840677018,
issuecomment-5858590586, issuecomment-5860057918) and shipped in #805, #808, #809, #811, #812,
#813, #814 and #816. It supersedes two rules of ADR 0006, named in "What ADR 0006 no longer says".

## Context

An application that owns its schema must bring the database to its declared model at every start,
in-process, with no operator reviewing a plan. ADR 0006 gives managed DDL one path, `dbsp apply`,
which persists a run, presents it and executes on confirmation, and it deleted `migrate`. An
application therefore had no managed way to create its tables on a fresh install, add a column on
upgrade, or take ownership of tables an earlier version created outside the ledger.

## Decision

### `convergePg` is a second entry point to the one executor

`convergePg(pool, model, options)` compares the declared model with the live schema on a
lock-holding connection, builds a generator manifest, and executes it through the same executor and
outcome protocol as `dbsp apply`: token-gated managed DDL, a ledger claim and terminal per step. It
differs from `dbsp apply` in what it admits and in what it records: planning and execution happen in
one call, nothing is written to the transition journal, and every call plans again from the live
database.

### It admits only startup-safe additions

- Tables and sequences that do not exist yet. Indexes, CHECK constraints and foreign keys only on
  tables created by the same call. A foreign key also needs both of its tables created by the call,
  its referenced columns covered by a primary key, a unique column or a declared unique index that is
  neither partial nor on an expression, and, for a single-column key, a declared index on its column.
- Columns added to managed tables: nullable without a default, or NOT NULL with a boolean,
  finite-number or non-function string literal default; a defaulted column's type must be a
  PostgreSQL built-in base type or an enum.
- Indexes the caller manages itself, named in `externalIndexes`, are never dropped and are not
  reported as drift.

Everything else — removals, alterations, children on an existing table, `replace`, `readdress` —
refuses before converge writes anything.

### The tables a call creates commit atomically

The `create_table` steps of a call and every change on those tables run in one transaction: a
failure rolls back their DDL, claims and terminals together, so the next call starts from absent
tables. A sequence created by the same call commits on its own and can remain after a failure.
Admitting children on an existing table by ledger provenance was rejected: a table's catalogue
identity is its OID, which proves neither emptiness nor unchanged shape.

### Its runs are not journaled, and it never starts over another writer's open claim

Every step converge emits is transactional, so an interrupted call leaves no open claim; recording
its run would keep evidence no recovery reads. Before comparing, converge refuses while the target
schema's ledger has a live reservation: `busy` when the owning run still holds its lock,
`recovery-required` otherwise, carrying the run ids to reconcile (`reconcilePgTransitionRun` or
`dbsp reconcile`) and the executions no readable journal run explains.

### The ledger and journal come from a separate preflight

Converge requires the schema's ledger and refuses `ledger-absent` without it; it never creates the
ledger or the transition journal. `runPgReinitializePreflight` creates and owns both, and converge
runs as the same PostgreSQL role, so it can read the journal. The ledger requires PostgreSQL 15
(`unsupported-server` below it).

### Adoption is declared by the caller's model

A table the model marks `adopt: true` is taken into management when it exists, the ledger projects
its address as unknown, and it matches the declaration exactly after `externalIndexes` masking,
using the comparison converge plans with, re-run on the locked session inside the adoption claim. A
mismatch found while planning refuses `adoption-refused` before anything is written. Each table is
adopted in its own transaction, so a table that changes while its adoption runs is refused after
earlier tables of the same call were adopted; the next call skips those. The caller sets `adopt` for
the one pass over an existing install and omits it afterwards.

## What ADR 0006 no longer says

**"Managed DDL has one apply path."** Managed DDL has one executor and outcome protocol, reached
from two entry points: the reviewed `dbsp apply`, and `convergePg`, which admits only the additions
and adoptions above.

**Adoption's grant "belongs in the reviewed plan."** Through `convergePg`, the grant is the caller's
`adopt: true` declaration, compared and re-verified as above; no plan is presented for review. The
CLI still presents adoption in the reviewed plan.

## Consequences

- Converge holds the schema ledger's session lock for its whole call, and transition writers take
  that lock without waiting, so a `dbsp apply` run that reaches its next ledger transaction while
  converge runs gets `busy` and stops there; several application instances starting together get
  `busy` from one another the same way. Open on #769 (issuecomment-5860782599).
- An install whose tables lag the model cannot be adopted as it is: adopting a table and then adding
  its missing columns is not offered.
- A new index, CHECK or foreign key on an existing managed table is refused; the caller either
  creates it as an external index or plans it through `dbsp apply`.
- `dbsp apply` re-checks an adoption with a weaker comparison than `dbsp plan` (#815); converge does
  not share that gap.
- Recording converge runs is revisited when converge emits a non-transactional step or a claim can
  outlive its transaction, when a caller needs to resume a converge run after a crash, or when mapping
  an execution id to a durable converge run becomes necessary for recovery or audit.
