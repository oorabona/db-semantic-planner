# ADR 0008: The Convergence Program

## Status

Accepted (2026-09-29). It records the decision taken on #837. The check mode, `initialize` and
application steps are shipped; the program signature below is the accepted target, and "Deliveries" gives the state of each part.

## Context

ADR 0007 gives an application one call, `convergePg`, that brings its declared model to the database at
start. An application still runs its own work around that call: one-time data backfills, a deliberate
drop of an obsolete table, repairs of triggers and CHECK constraints, and a way to tell whether the
database is current without changing it. It therefore keeps its own run-once registry and advisory
locks beside dbsp's ledger and ledger lock, so two registries and two lock systems govern one database,
and each dbsp upgrade can break the pairing.

## Decision

dbsp owns one convergence program: `convergePg(pool, program, { mode, initialize })`, where the program
holds the model, the schema, `dbCasing`, the external indexes and the application's declared steps. dbsp
computes every fingerprint and records every step run in its ledger under its lock.

### `check` plans without committing

`mode: 'check'` runs the path `apply` runs before executing (the ledger lock, the version and ledger checks,
`database-read-only` before the comparison, every planning refusal, manifest validation) and returns
`{ kind: 'no-drift' }` or `{ kind: 'would-apply', planDigest, steps }` instead of executing. It writes
nothing durable: the comparison's expression canonicalisation runs in a transaction that is always
rolled back. A check is a point-in-time answer. Another session can change the database before a later
apply, and the checks the executor makes at execution time (ledger physical shape, adoption
re-verification at claim time, lock timeouts) do not run.

### Application steps are transactional and recorded in the ledger

- `once` `{ id, digest, scope, phase, apply(tx) }` runs once; a changed step needs a new id.
- `assert` `{ id, digest, scope, phase, inspect(tx), apply(tx) }`: `inspect` is read-only and runs on
  every check; `apply` runs in apply mode when inspection reports the database unhealthy.

How they are recorded and run:

- **No new ledger event.** A step's address is `kind: 'application-step'`, `name: id` in the target
  schema's ledger. A recorded run is an `intent` claim of the claim species `application-step`, declaring
  `{ id, digest, step }`, closed by `observed`. The ledger shape, its 14 event kinds and its deparse
  fixtures are unchanged; an application step is not a declarable object and has no catalogue identity.
- **Admission.** A `once` is admitted only from `unknown`; recorded with the same digest it is complete,
  with another digest it refuses `application-step-changed`. An `assert` is admitted from `unknown` or
  `managed`, keeping the controller check.
- **One transaction per step** on converge's locked connection: `lock_timeout` 5 s unless the step sets
  `lockTimeoutMs`, `statement_timeout` only if it sets `statementTimeoutMs`. An `assert` inspects first
  and records nothing when healthy; otherwise it claims, applies, and inspects again, and records
  `observed` only if the database is now healthy. An error before `COMMIT`, or a `COMMIT` PostgreSQL
  rejects, rolls the step back, records nothing, and stops converge with `application-step-failed`;
  earlier steps and DDL stay committed. A `COMMIT` whose acknowledgement is lost is
  `transport-ambiguous`, as for generated steps. Session-level effects of a step are not part of it;
  converge closes its connection after any step ran instead of returning it to the pool.
- **Placement.** `phase: 'before-generated-ddl'` runs after every planning refusal and before the first
  generated DDL step; `'after-generated-ddl'` after the last. `no-drift` needs every `once` recorded and
  every `assert` healthy. Check mode runs `inspect` read-only and never `apply`.
- **The digest is the caller's contract.** dbsp cannot hash a function: a `once` whose body changes
  needs a new id, and an `assert` records the digest it last repaired with.
- Schema scope only in this delivery; `scope: 'database'` is refused until needed.
- **A step does not touch what the comparison sees.** Converge compares a declared table's columns,
  keys, foreign keys, CHECK constraints and indexes; a step that creates or changes one of them makes
  the next call refuse `unsupported-change` during planning, before any step runs. Functions,
  triggers, data and undeclared tables are outside the comparison. An application that repairs a
  declared CHECK or column type needs an ownership mask, the next delivery.

### Initialisation and adoption are a library operation

`initialize: 'never' | 'pristine' | 'adopt-existing'` replaces the application's call to the preflight,
without its file output. It is evaluated at every start, like the rest of the program:

- When the schema's ledger is absent, `'pristine'` and `'adopt-existing'` create it through the
  preflight code before converge takes its lock; `'pristine'` first refuses `initialization-refused`
  if a declared table or standalone sequence exists, inside the preflight's own scope transaction.
  The preflight runs only when converge saw the schema ledger absent; a ledger another initialiser
  creates in between is re-inspected under the preflight's lock and left `unchanged`. A ledger whose
  identity no longer matches the database, on `dbsp_meta` or the schema, fails initialisation, so
  initialisation never archives a ledger; archiving stays with an explicit
  `runPgReinitializePreflight`. The schema's ledger is prepared only after `dbsp_meta` is ready.
- `'adopt-existing'` then treats, on every call, each declared table and standalone sequence that
  exists as marked `adopt: true`, and each that does not as unmarked. Adoption commits per table, so
  this is what lets a start that stopped part-way resume; it also adopts a table created later outside
  dbsp with exactly its declared shape.
- Check mode never initialises: with no ledger it refuses `ledger-absent`.
- The target schema must exist; initialisation creates `dbsp_meta` and the journal, so the converging
  role needs `CREATE` on the database.

### Not built

A converged-state marker or `isConverged` check, SQL migration files, non-transactional steps, and
retries. Extensions stay in the application's privileged bootstrap, since creating one needs a role an
application should not run as.

## Deliveries

1. `check` mode on `convergePg` (`ConvergePgCheckOptions`, `PgConvergeCheckResult`): shipped.
2. Initialisation and adoption as a library operation (`initialize`, refusal `initialization-refused`):
   shipped.
3. `once` and `assert` steps (`steps` option, refusals `application-step-changed` and
   `application-step-failed`): shipped.
4. Ownership: an `assert` declares the named CHECK constraints, column types and named indexes it
   owns, and converge leaves them out of every comparison (diff, planning refusals, generated DDL,
   `no-drift`, check plan, plan digest), so the model can still declare them. Not shipped.
5. Composition into the program signature: not shipped. Until it ships, `convergePg` takes a model,
   and check mode is selected with `ConvergePgCheckOptions`.

## Consequences

- `PgConvergeResult` and `dbsp migrate` are unchanged by the check mode: it has its own options and
  result types, so the command's exhaustive handling of results still compiles.
- The check cost is a full planning pass. Measured on one application's install, a `no-drift` converge
  takes 570 ms at the median.
