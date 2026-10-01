# ADR 0008: The Convergence Program

## Status

Accepted (2026-09-29). It records the decision taken on #837. The check mode, `initialize` and
application steps and ownership are shipped; "Deliveries" gives the state of each part.

ADR 0009 supersedes the call shape given here: `convergePg(pool, physical, options)` takes a
`PgPhysicalModel`, which carries the schema, the naming choice and `fkAutoIndex`; `options` no longer
holds `schema` or `dbCasing`.

## Context

ADR 0007 gives an application one call, `convergePg`, that brings its declared model to the database at
start. An application still runs its own work around that call: one-time data backfills, a deliberate
drop of an obsolete table, repairs of triggers and CHECK constraints, and a way to tell whether the
database is current without changing it. It therefore keeps its own run-once registry and advisory
locks beside dbsp's ledger and ledger lock, so two registries and two lock systems govern one database,
and each dbsp upgrade can break the pairing.

## Decision

dbsp owns one convergence program: `convergePg(pool, model, options)`, where `options` holds the schema,
`dbCasing`, the external indexes, the application's declared steps, `mode` and `initialize`. dbsp computes
every fingerprint and records every step run in its ledger under its lock.

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
- `assert` `{ id, digest, scope, phase, inspect(tx, owned), apply(tx, owned) }`: `inspect` is read-only; every apply
  runs it by the assert's phase, and a check runs it only when nothing else is pending.
  `apply` runs in apply mode when inspection reports the database unhealthy.

How they are recorded and run:

- **No new ledger event.** A step's address is `kind: 'application-step'`, `name: id` in the target
  schema's ledger. A recorded run is an `intent` claim of the claim species `application-step`, declaring
  `{ id, digest, step }`, closed by `observed`. The ledger shape, its 14 event kinds and its deparse
  fixtures are unchanged; an application step is not a declarable object and has no catalogue identity.
- **Admission.** A `once` is admitted only from `unknown`; recorded with the same digest it is complete,
  with another digest it refuses `application-step-changed`. An `assert` is admitted from `unknown` or
  `managed`, keeping the controller check.
- **One execution transaction per step** on converge's locked connection (a planning inspection of an
  `assert`, when it happens, is a separate read-only transaction that is rolled back): `lock_timeout` 5 s unless the step sets
  `lockTimeoutMs`, `statement_timeout` only if it sets `statementTimeoutMs`. An `assert` inspects first
  and records nothing when healthy; otherwise it claims, applies, and inspects again, and records
  `observed` only if the database is now healthy. An error before `COMMIT`, or a `COMMIT` PostgreSQL
  rejects, rolls the step back, records nothing, and stops converge with `application-step-failed`;
  earlier steps and DDL stay committed. A `COMMIT` whose acknowledgement is lost is
  `transport-ambiguous`, as for generated steps. Session-level effects of a step are not part of it;
  converge closes its connection after any step ran instead of returning it to the pool. Each step
  transaction sets `search_path` to the target schema, `pg_temp`, then the connection's entries
  (transaction-local), so `current_schema()` is the target and unqualified creation lands there;
  unless the connection's path names `pg_catalog` explicitly, PostgreSQL searches it first, so
  built-in names win; otherwise a name that exists
  in the target resolves there and a session temporary table cannot shadow it, while a name absent
  from it continues down the path. A target schema literally named `$user` cannot host steps; since ADR 0009
  it cannot be a converge target at all, because `convergePg` refuses a schema the renderers cannot write.
  An owned-CHECK state rendering failure during planning or execution is `application-step-failed`
  naming the step with the original error as `cause`; failed rendering-scope cleanup destroys the
  session, so planning rolls back only that scope without running a step while execution rolls back
  its step transaction. Step timeouts are PostgreSQL's per-statement and lock-wait limits in those transactions, not a
  deadline on the callback; planning admission runs without them.
- **Placement.** `phase: 'before-generated-ddl'` runs after every planning refusal and before the first
  generated DDL step; `'after-generated-ddl'` after the last. `no-drift` needs every `once` recorded and
  every `assert` healthy. An `assert` is inspected before anything runs only when nothing else is
  pending and no earlier assert is unhealthy, since only then does its answer decide `no-drift`;
  otherwise it is inspected at its phase, so it can read what earlier steps and generated DDL made.
  Every step's ledger admission still runs before anything executes. Check mode never runs `apply` and lists an
  assert it could not inspect ahead of pending work with `inspected: false`. A step must not release
  advisory locks: converge's session lock lives on the same connection.
- **The digest is the caller's contract.** dbsp cannot hash a function: a `once` whose body changes
  needs a new id, and an `assert` records the digest it last repaired with.
- Schema scope only in this delivery; `scope: 'database'` is refused until needed.
- **A step does not touch what the comparison sees unless it owns the surface.** An `assert` can
  declare named CHECK constraints, column types, and named indexes in `owns`. Converge removes those
  declared and live surfaces from its schema comparison, planning and adoption path; fresh generated
  DDL omits owned CHECKs and indexes. Owned CHECKs are rendered separately to produce the state handed
  to the assertion's `inspect` and `apply`, which alone maintain them. Ownership is validated before connecting, cannot be duplicated, and
  an assert that owns a CHECK or an index must be `after-generated-ddl`. All other declared columns,
  keys, foreign keys, CHECKs and indexes remain compared; functions, triggers, data and undeclared
  tables remain outside it.

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
   owns, and converge leaves them out of schema comparison, planning refusals, `no-drift` and adoption
   re-verification, so the model can still declare them. Owned CHECKs and indexes are left out of
   generated DDL, while an owned column type is still emitted with its declared type when its table or
   column is created; each step's canonical `owns` is included in `planDigest`. `inspect` remains
   read-only and receives canonical owned-CHECK health state. Shipped.
5. Composition into a `convergePg(pool, program, { mode, initialize })` signature: dropped
   (operator decision 2026-09-30). It only regrouped what `(pool, model, options)` already carries and
   would have cost a deprecation path on a published API. It is reconsidered if a consumer needs to load
   a program as one value, for example `dbsp migrate` loading declared steps from a module.

## Consequences

- `PgConvergeResult` and `dbsp migrate` are unchanged by the check mode: it has its own options and
  result types, so the command's exhaustive handling of results still compiles.
- The check cost is a full planning pass. Measured on one application's install, a `no-drift` converge
  takes 570 ms at the median.
