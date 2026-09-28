---
title: Startup Convergence
---

# How to converge a schema at application start

`convergePg` brings a PostgreSQL schema to your declared model from inside your application, at
every start, with no plan to review. It applies only additions that are safe to run unattended and
refuses everything else before writing anything. Use `dbsp plan` and `dbsp apply` for any change it
refuses. The decision and its limits are recorded in
[ADR 0007](https://github.com/oorabona/db-semantic-planner/blob/main/docs/adr/0007-startup-convergence.md).

## When

- Your application owns its schema and must create it on a fresh install.
- A new version adds tables, or columns that are nullable or NOT NULL with a literal default.
- An earlier version created the tables outside dbsp, and you want dbsp to manage them from now on.

## The startup sequence

1. **Once, with a role allowed to create tables in the schema:** `runPgReinitializePreflight` creates
   and owns the schema's ledger and the transition journal. `convergePg` never creates them and
   refuses `ledger-absent` without them.
2. **At every start, as the same role:** `convergePg(pool, model, { schema })`.
3. **After converge:** create or repair the indexes you manage yourself (see
   [External indexes](#external-indexes)).

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

// Once per database, before the first convergePg call.
await runPgReinitializePreflight({
  pool,
  schemas: ['converge_guide'],
  declarations: { version: 1, digest: 'none', declarations: [] },
  writeAdoptionFile: async () => {},
});

// At every start: 'applied' the first time, 'no-drift' afterwards.
const result = await convergePg(pool, app.model, { schema: 'converge_guide' });
if (result.kind !== 'applied' && result.kind !== 'no-drift') {
  throw new Error(`unexpected converge result ${result.kind}`);
}
```

## What converge applies

- **New tables and sequences.** Indexes, CHECK constraints and foreign keys are created only on
  tables the same call creates (for a foreign key, both tables). A single-column foreign key needs a
  declared index on its column.
- **New columns on tables dbsp already manages:** nullable without a default, or NOT NULL with a
  boolean, finite-number or string literal default (not a function call such as `now()`), of a
  PostgreSQL built-in type or an enum. Adding a column takes an `ACCESS EXCLUSIVE` lock on its table,
  bounded by a five-second `lock_timeout`.
- **Adoption** of existing tables you mark `adopt: true` (see
  [Adopting an existing install](#adopting-an-existing-install)).

The tables a call creates and every change on them commit in one transaction: if one of them fails,
none of them remains and the next call starts again from absent tables. A sequence created by the
same call commits on its own and can remain after a failure.

Converge never drops, alters or renames anything, and it refuses a table declared with `replace` or
`readdress`.

## Results

| `result.kind` | Meaning |
|---|---|
| `no-drift` | The schema already matches the model. |
| `applied` | Every planned step committed; `applied` lists their change kinds. |
| `partially-applied` | Some steps committed (`completedStepKeys`), the rest did not start (`notStartedStepKeys`); `detail` says why. Call converge again after fixing the cause. |
| `transport-ambiguous` | The connection was lost while a COMMIT was in flight. The next call observes whichever state PostgreSQL holds. |

## Refusals

Every other outcome throws `PgConvergeRefusalError`. Its `refusal` field names the case, `changes`
lists the changes involved, and `detail` explains.

| `refusal` | Cause | What to do |
|---|---|---|
| `invalid-options` | `externalIndexes` is malformed, duplicated, names an undeclared table, or names a declared index. | Fix the option. |
| `ledger-absent` | The schema has no ledger. | Run `runPgReinitializePreflight` first. |
| `incompatible-ledger` | The schema's ledger fails its currency check; `detail` gives the reason. | Read `detail`; [ADR 0006](https://github.com/oorabona/db-semantic-planner/blob/main/docs/adr/0006-managed-state-ledger.md) ("Lineage") covers a ledger restored or copied from another database. |
| `unsupported-server` | PostgreSQL is older than 15. | Upgrade PostgreSQL. |
| `busy` | Another converge call holds the schema's ledger lock, or every open claim belongs to a run still executing (`busyRunIds`). | Retry once that call or run finishes. |
| `recovery-required` | An earlier run left an open claim. | Reconcile each run in `runIds` with `reconcilePgTransitionRun(pool, runId)` (the pool must allow two connections) or `dbsp reconcile --db <database> <run-id>`; `executionIds` lists claims no readable journal run explains, which the ledger or journal owner must resolve. Then call converge again. |
| `unsupported-change` | The model asks for something converge does not apply: a removal, an alteration, a child on an existing table, a column outside the rules above, `replace` or `readdress`. | Plan it with `dbsp plan` and `dbsp apply`, or change the model. |
| `unmanaged-object` | A declared table or sequence exists but dbsp does not manage it. | Adopt it, or remove it. |
| `unmanaged-parent` | A change targets a table dbsp does not manage. | Adopt the table first. |
| `concurrent-drift` | A declared object disappeared while converge was planning. | Call converge again. |
| `adoption-refused` | A table marked `adopt: true` is absent, differs from its declaration, or has ledger history that forbids adoption (for example, it was managed, then dropped and recreated). | Make the live table match the declaration, or leave it unadopted. |
| `execution-refused` | A step was refused while executing; its transaction rolled back. | Read `detail`, fix the cause, call converge again. |

## Adopting an existing install

If an earlier version of your application created its tables without dbsp, `convergePg` refuses
them as `unmanaged-object`. Take them into management with one pass in which the model marks each
table `adopt: true`, then drop the flag:

- A table is adopted only if it exists and matches its declaration exactly, columns, types,
  defaults, keys and indexes included (after [External indexes](#external-indexes) masking).
  Anything else refuses `adoption-refused` before anything is written.
- `adopt: true` on a table that does not exist is refused, so do not set it on a fresh install.
- An install that lags the model, for example a missing column, must be brought to the model before
  the adoption pass; adopting a table and then adding its columns in the same call is not offered.

```typescript
// doctest: real-db-only — adopts a table created outside dbsp
import { convergePg, runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';

await pool.query('CREATE SCHEMA IF NOT EXISTS converge_guide');
await runPgReinitializePreflight({
  pool,
  schemas: ['converge_guide'],
  declarations: { version: 1, digest: 'none', declarations: [] },
  writeAdoptionFile: async () => {},
});
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

Each entry names an existing declared table and the exact physical index name. Converge never drops
a live index named here and does not report it as drift. A name that is also a declared index is
refused as `invalid-options`.

## Running alongside `dbsp apply`

Converge holds the schema's ledger lock for its whole call, and `dbsp apply` takes that lock without
waiting at each step. A `dbsp apply` run that is between two steps when converge starts gets `busy`
on its next step; if it had already changed the database, it ends `recovery-required`, which
`dbsp reconcile` resolves. Avoid running both on the same schema at the same time.
