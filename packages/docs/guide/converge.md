---
title: Startup Convergence
---

# How to converge a schema at application start

`convergePg` applies the additions your declared model needs to a PostgreSQL schema, from inside
your application, at every start, with no plan to review. It compares the tables and sequences the
model declares, and the schema's enums. Changes it does not apply unattended are refused while
planning; plan those with
`dbsp plan` and `dbsp apply`. The decision and its limits are recorded in
[ADR 0007](https://github.com/oorabona/db-semantic-planner/blob/main/docs/adr/0007-startup-convergence.md).

## When

- Your application owns its schema and must create it on a fresh install.
- A new version adds tables, or columns that are nullable or NOT NULL with a literal default.
- An earlier version created the tables outside dbsp, and you want dbsp to manage them from now on.

## The startup sequence

1. **Before the first `convergePg` call on a schema, with a role allowed to create schemas and
   tables:** `runPgReinitializePreflight` creates and owns the `dbsp_meta` schema, the ledger of each
   schema it is given, and the transition journal. Run it again when you add a schema to converge.
   Check both channels it fails through: scopes reported as `failed` or `not-attempted` in the
   returned report, and a rejected promise. `convergePg` never creates these tables, and refuses
   `ledger-absent` when the schema has no ledger.
2. **At every start, as the same role:** `convergePg(pool, model, { schema })`. When several
   instances start together, one converges and the others get `busy`: retry `busy` after a delay, or
   converge from a single instance.
3. **After converge, from a single instance:** create or repair the indexes you manage yourself (see
   [External indexes](#external-indexes)). The ledger lock is released when `convergePg` returns, so
   it does not serialize this step.

The ledger needs PostgreSQL 15 or later.

```typescript
// doctest: real-db-only — runs the preflight and converges a real schema
import { convergePg, runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';

const app = schema({
  settings: {
    id: { type: 'integer', primaryKey: true },
    name: 'string',
  },
});

await pool.query('CREATE SCHEMA IF NOT EXISTS converge_guide');

// Before the first convergePg call on this schema.
const report = await runPgReinitializePreflight({
  pool,
  schemas: ['converge_guide'],
  declarations: { version: 1, digest: 'none', declarations: [] },
  writeAdoptionFile: async () => {},
});
const unprepared = report.scopes.filter(
  (scope) => scope.outcome === 'failed' || scope.outcome === 'not-attempted',
);
if (unprepared.length > 0) {
  throw new Error(`preflight did not prepare ${JSON.stringify(unprepared)}`);
}

// At every start: 'applied' the first time, 'no-drift' afterwards.
const result = await convergePg(pool, app.model, { schema: 'converge_guide' });
if (result.kind !== 'applied' && result.kind !== 'no-drift') {
  throw new Error(`unexpected converge result ${result.kind}`);
}
```

## What converge applies

- **New tables**, with the indexes, CHECK constraints and foreign keys declared on them.
- **New sequences.** A sequence's declared name must be its physical name: a name `dbCasing` would
  change is refused.
- **New columns on tables dbsp already manages**, within the rules below.
- **Adoption** of existing tables you mark `adopt: true` (see
  [Adopting an existing install](#adopting-an-existing-install)).

It does not drop, rename or change existing definitions, it does not add indexes, CHECK constraints
or foreign keys to a table that already exists, and it refuses `replace` and `readdress`. It does not
create enums or extensions: those the model uses must already exist. An enum in the schema that the
model does not declare also makes it refuse `unsupported-change`
([#817](https://github.com/oorabona/db-semantic-planner/issues/817)).

- A foreign key needs both of its tables created by the same call, its referenced columns covered by
  a primary key, a unique column or a declared unique index that is neither partial nor on an
  expression, and, for a single-column key, a declared index on its referencing column.
- A new column on a managed table is nullable without a default, or NOT NULL with a boolean,
  finite-number or string literal default (not a function call such as `now()`). A column with a
  default must use a PostgreSQL built-in type or an enum. Adding a column takes an
  `ACCESS EXCLUSIVE` lock on its table, bounded by a five-second `lock_timeout`.

The tables a call creates and every change on them commit in one transaction: if one of them fails,
none of them remains and the next call starts again from absent tables. A sequence created by the
same call commits on its own and can remain after a failure.

## Results

| `result.kind` | Meaning |
|---|---|
| `no-drift` | Nothing to apply: no change for the declared tables and sequences, and no enum difference. |
| `applied` | Every planned step committed; `applied` lists their change kinds. |
| `partially-applied` | The steps in `completedStepKeys` committed; those in `notStartedStepKeys` did not commit (a step whose transaction rolled back is listed there too). `detail` says why. |
| `transport-ambiguous` | The connection was lost while a COMMIT was in flight. The next call observes whichever state PostgreSQL holds. |

## Refusals

A refusal throws `PgConvergeRefusalError`: `refusal` names the case and `detail` explains it;
`changes` carries planning context and can be empty. An error raised before execution starts — an
invalid model, a connection failure, a database error while planning — is thrown as it is. A failure
during execution becomes an `execution-refused` or `adoption-refused` refusal, or a
`partially-applied` or `transport-ambiguous` result.

| `refusal` | Meaning |
|---|---|
| `invalid-options` | `externalIndexes` is malformed, duplicated, names an undeclared table, or names a declared index. |
| `ledger-absent` | The schema has no ledger: run `runPgReinitializePreflight`. |
| `incompatible-ledger` | The schema's ledger fails its currency check; `detail` gives the reason. |
| `unsupported-server` | PostgreSQL is older than 15. |
| `busy` | Another converge call or transition writer holds the schema's ledger lock, or every open claim belongs to a run still executing. Retry after a delay. |
| `recovery-required` | Earlier runs left open claims. Reconcile each run in `runIds` with `reconcilePgTransitionRun(pool, runId)` (the pool must allow two connections) or `dbsp reconcile --db <database> <run-id>`; `busyRunIds` lists runs still executing. `executionIds` lists claims no readable journal run explains; no public operation resolves a claim by execution id, so they need the ledger owner. Call converge again once no claim is open. |
| `unsupported-change` | The model asks for a change converge does not apply. Plan it with `dbsp plan` and `dbsp apply`, or change the model. |
| `unmanaged-object` | A live object at an address converge would manage is not managed by dbsp: an existing table or sequence, or an object created while converge was running. |
| `unmanaged-parent` | A change targets a table dbsp does not manage. |
| `concurrent-drift` | A declared object disappeared while converge was planning. |
| `adoption-refused` | A table marked `adopt: true` could not be adopted: it is absent, differs from its declaration, or its ledger state is not unknown. A managed table that was dropped and recreated is in that last case, and converge offers no way to take it over. |
| `execution-refused` | The executor refused or failed a step; `detail` says why. |

## Adopting an existing install

If an earlier version of your application created its tables without dbsp, `convergePg` refuses
them as `unmanaged-object`. Take them into management with one pass in which the model marks each
table `adopt: true`, then drop the flag:

- A table is adopted only if it exists, its ledger state is unknown, and it matches its declaration
  exactly, columns, types, defaults, keys and indexes included (after
  [External indexes](#external-indexes) masking). A mismatch found while planning refuses
  `adoption-refused` before anything is written.
- Each table is adopted in its own transaction. A table that changes while its adoption runs is
  refused, and tables adopted earlier in the same call stay adopted; the next call skips them.
- `adopt: true` on a table that does not exist is refused, so do not set it on a fresh install.
- An install that lags the model, for example a missing column, must be brought to the model before
  the adoption pass.

```typescript
// doctest: real-db-only — adopts a table created outside dbsp
import { convergePg, runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';

await pool.query('CREATE SCHEMA IF NOT EXISTS converge_guide');
const report = await runPgReinitializePreflight({
  pool,
  schemas: ['converge_guide'],
  declarations: { version: 1, digest: 'none', declarations: [] },
  writeAdoptionFile: async () => {},
});
if (report.scopes.some((scope) => scope.outcome === 'failed' || scope.outcome === 'not-attempted')) {
  throw new Error('preflight did not prepare every scope');
}
// A table an earlier version created by hand.
await pool.query(
  'CREATE TABLE IF NOT EXISTS converge_guide.legacy_notes ("id" integer NOT NULL PRIMARY KEY, "body" text NOT NULL)',
);

const tables = {
  legacy_notes: {
    id: { type: 'integer', primaryKey: true },
    body: 'text',
  },
} as const;

// The one-time pass over the existing install.
await convergePg(pool, schema(tables, { legacy_notes: { adopt: true } }).model, {
  schema: 'converge_guide',
});

// Every later start omits adopt.
const result = await convergePg(pool, schema(tables).model, { schema: 'converge_guide' });
if (result.kind !== 'no-drift') throw new Error(`expected no-drift, got ${result.kind}`);
```

## External indexes

Some indexes cannot be declared in the model, for example indexes with extension-specific options.
Create them yourself after `convergePg`, and name them so converge leaves them alone:

```typescript
// doctest: skip — illustrates the option only
await convergePg(pool, model, {
  schema: 'app',
  externalIndexes: [{ table: 'documents', name: 'documents_search_index' }],
});
```

Each entry names a declared table and the exact physical index name. Converge never drops a live
index named here and does not report it as drift.

## Running alongside `dbsp apply`

`convergePg` and `dbsp apply` take the same ledger lock without waiting. On the same schema at the
same time, a `convergePg` call that finds the lock taken refuses `busy`, and a `dbsp apply` run stops
at the contested step with `execution-failed`, or `partially-applied` after earlier steps. Run them
one after the other.
