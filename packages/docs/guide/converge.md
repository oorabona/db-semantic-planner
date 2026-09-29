---
title: Startup Convergence
---

# How to converge a schema at application start

`convergePg` applies the additions your declared model needs to a PostgreSQL schema, from inside
your application, at every start, with no plan to review. It compares the tables, sequences and
enums the model declares. Changes it does not apply unattended are refused while
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

## From the command line

`dbsp migrate` runs the same convergence from a schema file, for a deployment step that runs before
the application starts:

```bash
dbsp preflight --reinitialize --db "$DATABASE_URL" --schema-file ./schema.ts --scope app --out ./adoption.json
dbsp migrate ./schema.ts --db "$DATABASE_URL" --schema app
```

The preflight runs once per schema, as in step 1 above. `dbsp migrate` reads `dbCasing` from the
schema file, takes each external index as `--external-index <model-table>:<index>` (the same naming as
`externalIndexes` below), and prints the result
or refusal below as its outcome, with an exit code `dbsp migrate --help` lists (`no-drift` and
`applied` exit 0). A `recovery-required` refusal lists the run ids to pass to `dbsp reconcile`, the
runs still executing, and the execution ids no dbsp command resolves, whose owner its detail names.

## What converge applies

- **New tables**, with the indexes, CHECK constraints and foreign keys declared on them.
- **New sequences.** A sequence is created under its physical name, the declared name mapped through
  `dbCasing` like a table's (`orderNumberSeq` becomes `order_number_seq` under `snake_case`). A raw
  `nextval(...)` default is not rewritten, so it names the physical sequence. When a live sequence
  still carries the raw declared name from an earlier version and the physical one does not exist,
  converge throws before writing anything; the error message gives the schema-qualified
  `ALTER SEQUENCE … RENAME TO …` that fixes it.
- **New columns on tables dbsp already manages**, within the rules below.
- **Adoption** of existing tables and standalone sequences you mark `adopt: true` (see
  [Adopting an existing install](#adopting-an-existing-install)).

It does not drop, rename or change existing definitions, it does not add indexes, CHECK constraints
or foreign keys to a table that already exists, and it refuses `replace` and `readdress`. It does not
create enums or extensions: those the model uses must already exist. An enum's declared name is its
physical PostgreSQL type name under every `dbCasing`, the name its columns' types refer to, so
declare `mood_type` to match a live `mood_type`.

- A foreign key needs both of its tables created by the same call, its referenced columns covered by
  a primary key, a unique column or a declared unique index that is neither partial nor on an
  expression, and, for a single-column key, a declared index on its referencing column: any
  single-column index on it (a partial `WHERE <column> IS NOT NULL` index included), or a primary key
  or non-partial btree index without expressions whose first column it is.
- A new column on a managed table is nullable without a default, or NOT NULL with a boolean,
  finite-number or string literal default (not a function call such as `now()`). A column with a
  default must use a PostgreSQL built-in base type or an enum, whether it is declared by a neutral type
  or by `originalDbType`; a range such as `daterange` is refused. A new column whose type names its schema
  (`originalDbTypeSchema`), as an enum column in a non-public schema does, is refused. Adding a
  column takes an `ACCESS EXCLUSIVE` lock on its table, bounded by a five-second `lock_timeout`.

The tables a call creates and every change on them commit in one transaction: if one of them fails,
none of them remains and the next call starts again from absent tables. A sequence created by the
same call commits on its own and can remain after a failure.

## Results

| `result.kind` | Meaning |
|---|---|
| `no-drift` | Nothing to apply for the declared tables, sequences and enums. |
| `applied` | Every planned step committed; `applied` lists their change kinds. |
| `partially-applied` | The steps in `completedStepKeys` committed; those in `notStartedStepKeys` did not commit (a step whose transaction rolled back is listed there too). `detail` says why. |
| `transport-ambiguous` | The connection was lost while a COMMIT was in flight. The next call observes whichever state PostgreSQL holds. |

## Checking without applying

`convergePg(pool, model, { schema, mode: 'check' })` takes the ledger lock, runs every check and
planning refusal that an apply runs, and returns without executing:

| `result.kind` | Meaning |
|---|---|
| `no-drift` | An apply would find nothing to do. |
| `would-apply` | `steps` lists, in execution order, the steps an apply would run: each has `stepKey`, `kind` (a change kind, `adopt_table` or `adopt_sequence`), `address`, and the `table`, `column` and `details` of its change. `planDigest` identifies that plan. |

A check refuses exactly as an apply would (`busy`, `ledger-absent`, `database-read-only`,
`unsupported-change`, …) and writes nothing to the database or the ledger. Its answer holds for the
moment it was taken: another session can change the database before your next apply, and checks the
executor makes only while executing, such as re-verifying an adopted table when it claims it, do not
run. The options type is `ConvergePgCheckOptions` and the result type `PgConvergeCheckResult`;
[ADR 0008](https://github.com/oorabona/db-semantic-planner/blob/main/docs/adr/0008-convergence-program.md)
records the decision.

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
| `database-read-only` | The target refuses writes (a standby, or a session whose transactions are read-only); converge checks this before comparing and writes nothing, even when the model already matches. A target that becomes read-only after that check and before converge's first write is reported `execution-refused`, with the reason in `detail`; after earlier steps committed, the result is `partially-applied`. |
| `busy` | Another converge call or transition writer holds the schema's ledger lock, or every open claim belongs to a run still executing. Retry after a delay. |
| `recovery-required` | Earlier runs left open claims. Reconcile each run in `runIds` with `reconcilePgTransitionRun(pool, runId)` (the pool must allow two connections) or `dbsp reconcile --db <database> <run-id>`; `busyRunIds` lists runs still executing. `executionIds` lists claims no readable journal run explains; no public operation resolves a claim by execution id, so they need the ledger owner. Call converge again once no claim is open. |
| `unsupported-change` | The model asks for a change converge does not apply. Plan it with `dbsp plan` and `dbsp apply`, or change the model. |
| `unmanaged-object` | A live object at an address converge would manage is not managed by dbsp: an existing table or sequence, or an object created while converge was running. |
| `unmanaged-parent` | A change targets a table dbsp does not manage. |
| `concurrent-drift` | A declared object disappeared while converge was planning. |
| `adoption-refused` | A table or sequence marked `adopt: true` could not be adopted. With an unknown ledger state, it is absent or differs from its declaration; a sequence is also refused when it is owned by a column (`OWNED BY`, serial or identity), is not `bigint` with cache 1, or is declared in another schema. An object already managed under the same catalogue identity is skipped, and its drift follows the ordinary rules (for example `unsupported-change`). Any other ledger state is refused, which includes a managed object that was dropped and recreated; converge offers no way to take it over. |
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

A sequence created outside dbsp is refused as `unmanaged-object` too. Declare it with `adopt: true`
in the schema's `sequences` for the same pass:

- It is adopted only if it is a standalone sequence (not owned by a column through `OWNED BY`, serial
  or identity), `bigint` with cache 1, in the schema converge targets, its ledger state is unknown,
  and its start, increment, minimum, maximum and cycle match the declaration.
- Its current value is never read or reset: the next `nextval` continues where it was.
- The match is observed on the adoption's own session before it commits. PostgreSQL has no lock that
  keeps a sequence from being altered in between, so an `ALTER SEQUENCE` running at that moment is
  not excluded.
- Type, cache and ownership are checked only when adopting. A managed sequence later altered on them
  is not reported as drift.
- `adopt: true` kept on a sequence that is already managed is a no-op. Only `convergePg` and
  `dbsp migrate` adopt sequences; `dbsp plan` and `dbsp apply` refuse a sequence marked `adopt: true`.

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
